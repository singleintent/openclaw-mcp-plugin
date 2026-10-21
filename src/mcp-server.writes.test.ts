/**
 * SCRUM-185: the seven write verbs that are not work-item writes take the same
 * call-ticket path. Each runs the full server refusal matrix from SCRUM-182 and
 * one positive case per runtime key: the request goes out with the ticketed
 * agent's own token, never the instance token, and carries neither the call key
 * nor the ticket's origin (the product has no origin contract on these routes).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { argsDigest, newNonce, writeTicket } from "./call-ticket.js";
import { loadConfig, type Config } from "./config.js";
import { issueCallTicket } from "./index.js";
import { createServer } from "./mcp-server.js";
import { ORIGIN_WRITE_TOOLS, TICKETED_WRITE_TOOLS, WORKITEM_WRITE_TOOLS } from "./workitem-token.js";

const UUID = "1634aa11-2222-4333-8444-555566667777";
const AGENT = "joylabs-backend-dev";
const AGENT_TOKEN = "A".repeat(43);
const SESSION = "agent:" + AGENT + ":main";

type Write = {
  verb: string;
  /** The MCP arguments, as the model sends them. */
  args: Record<string, unknown>;
  /** The same arguments with one value changed, for the digest mismatch. */
  altered: Record<string, unknown>;
  method: string;
  url: string;
  body: Record<string, unknown>;
  response: unknown;
};

const RUN = { run: { runId: "r", status: "completed" } };
const WRITES: Write[] = [
  {
    verb: "send_message",
    args: { agent_id: "mob2-eng-manager", message: "status?" },
    altered: { agent_id: "mob2-eng-manager", message: "status now?" },
    method: "POST",
    url: "/api/chat",
    body: { agentId: "mob2-eng-manager", message: "status?" },
    response: RUN,
  },
  {
    verb: "apply_role",
    args: { agent_id: "mob2-eng-manager", template_id: UUID },
    altered: { agent_id: "mob2-other", template_id: UUID },
    method: "POST",
    url: "/api/agent-roles",
    body: { agentId: "mob2-eng-manager", templateId: UUID },
    response: { ...RUN, roleRecord: {} },
  },
  {
    verb: "create_agent",
    args: { name: "New Agent", project_id: UUID },
    altered: { name: "Other Agent", project_id: UUID },
    method: "POST",
    url: "/api/agents",
    body: { name: "New Agent", projectId: UUID },
    response: { agentId: "new-agent" },
  },
  {
    verb: "create_project",
    args: { name: "mob2", working_directory: "/tmp/mob2" },
    altered: { name: "mob3", working_directory: "/tmp/mob2" },
    method: "POST",
    url: "/api/projects",
    body: { name: "mob2", workingDirectory: "/tmp/mob2" },
    response: { id: UUID, name: "mob2", workingDirectory: "/tmp/mob2" },
  },
  {
    verb: "create_template",
    args: { name: "Role", content: "text" },
    altered: { name: "Role", content: "other text" },
    method: "POST",
    url: "/api/templates",
    body: { name: "Role", content: "text" },
    response: { id: UUID, name: "Role", content: "text" },
  },
  {
    verb: "update_template",
    args: { template_id: UUID, name: "Renamed" },
    altered: { template_id: UUID, name: "Renamed again" },
    method: "PUT",
    url: "/api/templates/" + UUID,
    body: { name: "Renamed" },
    response: { id: UUID, name: "Renamed", content: "kept" },
  },
  {
    verb: "create_connection",
    args: { from: "a-one", to: "b-two" },
    altered: { from: "a-one", to: "c-three" },
    method: "POST",
    url: "/api/connections",
    body: { from: "a-one", to: "b-two" },
    response: { ...RUN, connection: {} },
  },
];
const VERBS = WRITES.map((w) => [w.verb, w] as const);

/** The verb-mismatch pair: create_template ↔ update_template; the rest borrow create_template's. */
const otherVerb = (verb: string): string =>
  verb === "create_template" ? "update_template" : "create_template";

let api: HttpServer | undefined;
let mcpServer: ReturnType<typeof createServer> | undefined;
let client: Client | undefined;
let received: { method: string; url: string; body: unknown; authorization: string | undefined }[] = [];
let stateDir: string;
let tokenDir: string;
let ticketsDir: string;
let responseBody: unknown;
let responseStatus = 200;
let callSeq = 0;

type ToolResult = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: { error?: Record<string, unknown> };
};

async function connect(instanceToken?: string): Promise<void> {
  api = httpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
        authorization: req.headers.authorization,
      });
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve));
  const config: Config = {
    ...loadConfig({}),
    host: "127.0.0.1",
    port: (api.address() as { port: number }).port,
    ...(instanceToken === undefined ? {} : { token: instanceToken }),
  };
  mcpServer = createServer(() => config, { ticketsDir: () => ticketsDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "writes-test", version: "0.0.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(() => {
  vi.stubEnv("SINGLEINTENT_WORKITEM_PRINCIPALS_FILE", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
  stateDir = mkdtempSync(join(tmpdir(), "si-writes-state-"));
  tokenDir = join(stateDir, "singleintent", "workitem-tokens");
  ticketsDir = join(stateDir, "plugin-root", ".call-tickets");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
  if (client) await client.close();
  if (mcpServer) await mcpServer.close();
  if (api) await new Promise<void>((resolve) => api!.close(() => resolve()));
  client = undefined;
  mcpServer = undefined;
  api = undefined;
  received = [];
  responseBody = undefined;
  responseStatus = 200;
});

function provision(agentId: string, token: string): string {
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  const path = join(tokenDir, agentId);
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return path;
}

const hookDeps = (now: () => number = Date.now) => ({
  engineStateDir: () => stateDir,
  ticketsDir: () => ticketsDir,
  now,
  nonce: newNonce,
});

/** Run the real hook for a native call and return the id it ticketed. */
function ticketNative(verb: string, args: Record<string, unknown>, now?: () => number): string {
  const id = `toolu_185_${++callSeq}`;
  const hook = issueCallTicket(
    { toolName: `mcp__singleintent__${verb}`, params: args, toolCallId: id },
    { agentId: AGENT, sessionKey: SESSION, runId: "run-185" },
    hookDeps(now),
  );
  expect(hook).toBeUndefined();
  return id;
}

type Via = "claude" | "codex" | "embedded";

/** A call as a runtime makes it after the hook ran: real hook, then the runtime's key. */
async function callTicketed(verb: string, args: Record<string, unknown>, via: Via): Promise<ToolResult> {
  const id = `toolu_185_${++callSeq}`;
  const toolName = via === "embedded" ? `singleintent__${verb}` : `mcp__singleintent__${verb}`;
  const hook = issueCallTicket(
    { toolName, params: args, toolCallId: id },
    { agentId: AGENT, sessionKey: SESSION, runId: "run-185" },
    hookDeps(),
  );
  if (hook !== undefined && "block" in hook) throw new Error(hook.blockReason);
  if (via === "embedded") return (await client!.callTool({ name: verb, arguments: hook!.params })) as ToolResult;
  expect(hook).toBeUndefined();
  const _meta = via === "claude" ? { "claudecode/toolUseId": id } : { callId: id };
  return (await client!.callTool({ name: verb, arguments: args, _meta })) as ToolResult;
}

async function refused(
  params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> },
  code: string,
  message: RegExp,
): Promise<void> {
  const result = (await client!.callTool(params)) as ToolResult;
  expect(result.isError).toBe(true);
  expect(received).toEqual([]);
  expect(result.structuredContent?.error).toMatchObject({ code });
  expect(result.content[0]?.text).toMatch(new RegExp(`^write refused locally \\[${code}\\]: `));
  expect(result.content[0]?.text).toMatch(message);
}

describe("the ticketed write list (SCRUM-185)", () => {
  it("holds the four work-item writes and the seven other write verbs", () => {
    expect([...TICKETED_WRITE_TOOLS].sort()).toEqual(
      [
        "create_workitem",
        "workitem_set_state",
        "workitem_estimate",
        "workitem_note",
        ...WRITES.map((w) => w.verb),
      ].sort(),
    );
  });

  it("keeps WORKITEM_WRITE_TOOLS as an alias of the same list", () => {
    expect(WORKITEM_WRITE_TOOLS).toBe(TICKETED_WRITE_TOOLS);
  });

  it("sends the ticket origin only on the work-item writes", () => {
    for (const { verb } of WRITES) expect(ORIGIN_WRITE_TOOLS.has(verb)).toBe(false);
    for (const verb of ORIGIN_WRITE_TOOLS) expect(TICKETED_WRITE_TOOLS.has(verb)).toBe(true);
  });

  it("advertises every ticketed verb as a tool", async () => {
    await connect();
    const names = (await client!.listTools()).tools.map((t) => t.name);
    for (const verb of TICKETED_WRITE_TOOLS) expect(names).toContain(verb);
  });
});

describe.each(VERBS)("%s on the call-ticket path (SCRUM-185)", (verb, write) => {
  it.each<Via>(["claude", "codex", "embedded"])(
    "writes as the ticketed agent via the %s key, with no key, ticket or origin in the body",
    async (via) => {
      await connect("instance-token");
      responseBody = write.response;
      provision(AGENT, AGENT_TOKEN);
      provision("someone-else", "B".repeat(43));
      const result = await callTicketed(verb, { ...write.args }, via);
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ method: write.method, url: write.url });
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
      // The ctx had a session key and run id; the ticket recorded them, and
      // these routes still send no origin.
      expect(received[0]?.body).toEqual(write.body);
      expect(JSON.stringify(received[0]?.body)).not.toMatch(/acting|ticket|origin|sessionKey|runId/i);
    },
  );

  it("consumes the ticket: the ticket dir holds only the tombstone afterwards", async () => {
    await connect();
    responseBody = write.response;
    provision(AGENT, AGENT_TOKEN);
    await callTicketed(verb, { ...write.args }, "claude");
    expect(readdirSync(ticketsDir).every((n) => n.endsWith(".used"))).toBe(true);
  });

  it("refuses with no-call-ticket when no hook issued one", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused(
      { name: verb, arguments: { ...write.args }, _meta: { "claudecode/toolUseId": "toolu_never" } },
      "no-call-ticket",
      /no ticket exists for this call key/,
    );
  });

  it("refuses with no-call-ticket for a forged ticketId", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused({ name: verb, arguments: { ...write.args, ticketId: "forged" } }, "no-call-ticket", /no ticket exists/);
  });

  it("refuses with no-call-key when the request carries no key", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused({ name: verb, arguments: { ...write.args } }, "no-call-key", /carries no call key/);
  });

  it.each([
    ["both _meta ids", { "claudecode/toolUseId": "a" }, {}],
    ["a _meta id and a ticketId", {}, { ticketId: "c" }],
  ])("refuses with multiple-call-keys on %s", async (_label, meta, argExtra) => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(verb, { ...write.args });
    await refused(
      { name: verb, arguments: { ...write.args, ...argExtra }, _meta: { ...meta, callId: id } },
      "multiple-call-keys",
      /more than one call key/,
    );
  });

  it("refuses with call-ticket-digest-mismatch when the arguments changed after the hook", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(verb, { ...write.args });
    await refused(
      { name: verb, arguments: { ...write.altered }, _meta: { callId: id } },
      "call-ticket-digest-mismatch",
      /arguments differ/,
    );
  });

  it(`refuses with call-ticket-verb-mismatch on a ${otherVerb(verb)} ticket`, async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(otherVerb(verb), { ...write.args });
    await refused(
      { name: verb, arguments: { ...write.args }, _meta: { callId: id } },
      "call-ticket-verb-mismatch",
      new RegExp(`issued for ${otherVerb(verb)}, not ${verb}`),
    );
  });

  it("refuses with call-ticket-expired after the TTL", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(verb, { ...write.args }, () => Date.now() - 181_000);
    await refused({ name: verb, arguments: { ...write.args }, _meta: { callId: id } }, "call-ticket-expired", /expired/);
  });

  it("refuses a replay with call-ticket-replayed", async () => {
    await connect("instance-token");
    responseBody = write.response;
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(verb, { ...write.args });
    const params = { name: verb, arguments: { ...write.args }, _meta: { "claudecode/toolUseId": id } };
    expect(((await client!.callTool(params)) as ToolResult).isError).toBeFalsy();
    expect(received).toHaveLength(1);
    received = [];
    await refused(params, "call-ticket-replayed", /already claimed/);
  });

  it("refuses a malformed ticket with call-ticket-malformed", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative(verb, { ...write.args });
    writeFileSync(join(ticketsDir, createHash("sha256").update(id).digest("hex") + ".json"), "{not json");
    await refused(
      { name: verb, arguments: { ...write.args }, _meta: { callId: id } },
      "call-ticket-malformed",
      /not a valid v1 call ticket/,
    );
  });

  it.each(["actingAgentId", "actingEngineStateDir", "actingSessionKey", "actingRunId"])(
    "refuses with acting-args-refused when the request carries %s, even with a valid ticket",
    async (key) => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      const id = ticketNative(verb, { ...write.args });
      await refused(
        { name: verb, arguments: { ...write.args, [key]: AGENT }, _meta: { callId: id } },
        "acting-args-refused",
        new RegExp(`carries ${key}\\. Writes take their identity from the plugin's call ticket only`),
      );
    },
  );

  it.each([
    ["origin", { sessionKey: "agent:other:main", runId: "r" }],
    ["sessionKey", "agent:other:main"],
    ["runId", "forged"],
  ])("refuses a model %s with origin-args-refused, even with a valid ticket", async (key, value) => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    // A ticket for exactly these arguments, as if the hook had not blocked them.
    const id = `toolu_185_origin_${++callSeq}`;
    const withOrigin = { ...write.args, [key]: value };
    writeTicket(
      ticketsDir,
      id,
      {
        agentId: AGENT,
        engineStateDir: stateDir,
        sessionKey: SESSION,
        runId: "run-185",
        verb,
        argsDigest: argsDigest(withOrigin),
        expiresAt: Date.now() + 60_000,
      },
      Date.now(),
    );
    await refused(
      { name: verb, arguments: withOrigin, _meta: { callId: id } },
      "origin-args-refused",
      new RegExp(`carries ${key}\\. A write's origin comes from the plugin's call ticket only`),
    );
  });

  it("refuses locally with no-agent-token, never the instance token", async () => {
    await connect("instance-token");
    provision("someone-else", "B".repeat(43));
    const result = await callTicketed(verb, { ...write.args }, "claude");
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({
      code: "no-agent-token",
      agentId: AGENT,
      path: join(tokenDir, AGENT),
    });
  });

  it("never falls back to the instance token, even with SINGLEINTENT_TOKEN set", async () => {
    vi.stubEnv("SINGLEINTENT_TOKEN", "instance-token");
    const instanceToken = loadConfig({
      SINGLEINTENT_TOKEN: "instance-token",
      SINGLEINTENT_CONFIG: join(stateDir, "absent.json"),
    }).token;
    expect(instanceToken).toBe("instance-token");
    await connect(instanceToken);
    responseBody = write.response;
    const result = await callTicketed(verb, { ...write.args }, "embedded");
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code: "no-agent-token", agentId: AGENT });
  });
});

describe("create_agent partial creates reach the MCP caller (SCRUM-190)", () => {
  it("returns a roster-unverified 200 as a success that says partial and not to retry", async () => {
    await connect();
    provision(AGENT, AGENT_TOKEN);
    responseBody = {
      partial: true,
      code: "openclaw-roster-readback-timeout",
      agentId: "new-agent",
      rosterUnverified: true,
      verification: { openclawRosterVerified: false },
      nextAction: { code: "verify-openclaw-roster", message: "Re-read agents.list; do not create the agent again." },
    };
    const result = await callTicketed("create_agent", { name: "New Agent", project_id: UUID }, "claude");
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ agentId: "new-agent", partial: true, rosterUnverified: true });
    expect(parsed.warning).toMatch(/Do not call create_agent again/);
  });

  it("fails the orphan 502 with the created id and nextAction in structuredContent", async () => {
    await connect();
    provision(AGENT, AGENT_TOKEN);
    responseStatus = 502;
    responseBody = {
      partial: true,
      code: "openclaw-roster-mismatch",
      error: "OpenClaw created the agent, but fresh roster identity/workspace did not match.",
      openclawAgentCreated: true,
      createdAgentId: "orphan-agent",
      nextAction: {
        code: "delete-agent",
        message: "Delete it with DELETE /api/agents/orphan-agent, then create it again.",
        route: "DELETE /api/agents/:id",
        path: "/api/agents/orphan-agent",
      },
    };
    const result = await callTicketed("create_agent", { name: "New Agent", project_id: UUID }, "claude");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/OpenClaw DID create agent orphan-agent/);
    expect(result.structuredContent?.error).toMatchObject({
      code: "openclaw-roster-mismatch",
      status: 502,
      createdAgentId: "orphan-agent",
      nextAction: { code: "delete-agent", path: "/api/agents/orphan-agent" },
    });
  });
});

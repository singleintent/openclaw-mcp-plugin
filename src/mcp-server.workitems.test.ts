import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as httpServer,
  type Server as HttpServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { argsDigest, newNonce, writeTicket } from "./call-ticket.js";
import { loadConfig, type Config } from "./config.js";
import { issueCallTicket } from "./index.js";
import { createServer } from "./mcp-server.js";
import { TICKETED_WRITE_TOOLS } from "./workitem-token.js";

const PROJECT = "1634aa11-2222-4333-8444-555566667777";
const ITEM = "019b1234-5678-7abc-8def-0123456789ab";
const EVENT = "019b1234-5678-7abc-8def-0123456789ac";
let api: HttpServer | undefined;
let mcpServer: ReturnType<typeof createServer> | undefined;
let client: Client | undefined;
const AGENT = "joylabs-backend-dev";
const AGENT_TOKEN = "A".repeat(43);
let received: {
  method: string;
  url: string;
  body: unknown;
  authorization: string | undefined;
}[] = [];
let stateDir: string;
let tokenDir: string;
let ticketsDir: string;
/** The engine state dir the hook writes into tickets; tests override it. */
let ticketEngineDir: string;
let ticketAgent: string;
let responseStatus = 200;
let responseBody: unknown;

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
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "workitem-test", version: "0.0.0" });
  await Promise.all([
    mcpServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);
}

beforeEach(() => {
  // The token lookup reads these; the developer's own shell must not leak in.
  vi.stubEnv("SINGLEINTENT_WORKITEM_PRINCIPALS_FILE", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
  stateDir = mkdtempSync(join(tmpdir(), "si-workitem-state-"));
  tokenDir = join(stateDir, "singleintent", "workitem-tokens");
  ticketsDir = join(stateDir, "plugin-root", ".call-tickets");
  ticketEngineDir = stateDir;
  ticketAgent = AGENT;
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
  responseStatus = 200;
  responseBody = undefined;
});

function provision(agentId: string, token: string): string {
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  const path = join(tokenDir, agentId);
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return path;
}

type Via = "claude" | "codex" | "embedded";
let callSeq = 0;

/**
 * Call a tool the way a runtime does after the plugin's before_tool_call hook:
 * for a write verb, run the real hook first (it writes the call ticket), then
 * send the request with the key that runtime carries: claude-cli's
 * `_meta["claudecode/toolUseId"]`, Codex's `_meta.callId`, or the embedded
 * hook's `ticketId` argument. Reads go straight through.
 *
 * `session` is the Gateway ctx's session key and run id. It defaults to none,
 * so the bodies other tests assert carry no `origin` (SCRUM-148).
 */
async function callTool(
  params: { name: string; arguments: Record<string, unknown> },
  via: Via = "claude",
  session: { sessionKey?: string; runId?: string } = {},
): Promise<unknown> {
  if (!TICKETED_WRITE_TOOLS.has(params.name)) return client!.callTool(params);
  const id = `toolu_test_${++callSeq}`;
  const toolName = via === "embedded" ? `singleintent__${params.name}` : `mcp__singleintent__${params.name}`;
  const hook = issueCallTicket(
    { toolName, params: params.arguments, toolCallId: id },
    { agentId: ticketAgent, ...session },
    { engineStateDir: () => ticketEngineDir, ticketsDir: () => ticketsDir, now: Date.now, nonce: newNonce },
  );
  if (hook !== undefined && "block" in hook) throw new Error(hook.blockReason);
  if (via === "embedded") return client!.callTool({ name: params.name, arguments: hook!.params });
  expect(hook).toBeUndefined();
  const _meta = via === "claude" ? { "claudecode/toolUseId": id } : { callId: id };
  return client!.callTool({ name: params.name, arguments: params.arguments, _meta });
}

const resultText = (result: {
  content: unknown[];
}): Record<string, unknown> => {
  const block = result.content[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
};

describe("MCP work-item delegation", () => {
  it("delegates list and get tools to project-scoped API routes", async () => {
    await connect();
    responseBody = {
      readOk: true,
      project: PROJECT,
      items: [],
      store: {},
      index: {},
    };
    await callTool({
      name: "list_workitems",
      arguments: { projectId: PROJECT },
    });
    responseBody = {
      readOk: true,
      project: PROJECT,
      found: true,
      item: { id: ITEM, title: "Task", intent: "Do" },
      events: [],
      ledger: {},
    };
    await callTool({
      name: "get_workitem",
      arguments: { projectId: PROJECT, itemId: ITEM },
    });
    expect(received.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "/api/workitems?project=" + PROJECT],
      ["GET", "/api/workitems/" + ITEM + "?project=" + PROJECT],
    ]);
  });

  it("delegates the single state verb without actor or caller time and returns typed JSON", async () => {
    await connect();
    const writeResult = {
      readOk: true,
      project: PROJECT,
      found: true,
      item: { id: ITEM, title: "Task", intent: "Do", state: "blocked" },
      events: [],
      ledger: {},
      event: {
        id: EVENT,
        type: "blocked",
        actor: "server-agent",
        at: "server-time",
      },
      deduplicated: false,
    };
    responseBody = writeResult;
    provision(AGENT, AGENT_TOKEN);
    const result = await callTool({
      name: "workitem_set_state",
      arguments: {
        projectId: PROJECT,
        itemId: ITEM,
        state: "blocked",
        reason: "Waiting",
        eventId: EVENT,
      },
    });
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/api/workitems/" + ITEM + "/state?project=" + PROJECT,
    });
    expect(received[0]?.body).toEqual({
      eventId: EVENT,
      state: "blocked",
      reason: "Waiting",
    });
    expect(resultText(result as { content: unknown[] })).toMatchObject({
      event: { actor: "server-agent", at: "server-time" },
    });
  });

  it("forwards workitem_set_state's waitingOn to the product (SCRUM-154)", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({
      name: "workitem_set_state",
      arguments: {
        projectId: PROJECT,
        itemId: ITEM,
        state: "blocked",
        reason: "Waiting",
        waitingOn: "backend-dev",
        eventId: EVENT,
      },
    });
    expect(received[0]?.body).toEqual({ eventId: EVENT, state: "blocked", reason: "Waiting", waitingOn: "backend-dev" });
  });

  it("keeps an omitted waitingOn out of the workitem_set_state body (SCRUM-154)", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({
      name: "workitem_set_state",
      arguments: { projectId: PROJECT, itemId: ITEM, state: "blocked", reason: "Waiting", eventId: EVENT },
    });
    expect(Object.keys(received[0]?.body as object).sort()).toEqual(["eventId", "reason", "state"]);
  });

  it("passes the server's 400 waiting-on-not-allowed through as the tool error (SCRUM-154)", async () => {
    await connect();
    responseStatus = 400;
    responseBody = { error: "waitingOn is only allowed with state blocked", code: "waiting-on-not-allowed" };
    provision(AGENT, AGENT_TOKEN);
    const result = await callTool({
      name: "workitem_set_state",
      arguments: { projectId: PROJECT, itemId: ITEM, state: "started", waitingOn: "backend-dev", eventId: EVENT },
    });
    expect((received[0]?.body as { waitingOn?: string }).waitingOn).toBe("backend-dev");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("waiting-on-not-allowed");
    expect(text).toContain("waitingOn is only allowed with state blocked");
  });

  it("returns the product's machine-readable failure as an MCP tool error", async () => {
    await connect();
    responseStatus = 403;
    responseBody = {
      error: "principal is not authorized for this project",
      code: "project-forbidden",
    };
    provision(AGENT, AGENT_TOKEN);
    const result = await callTool({
      name: "create_workitem",
      arguments: {
        projectId: PROJECT,
        title: "Task",
        intent: "Do",
        eventId: EVENT,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("project-forbidden");
    expect(text).toContain("principal is not authorized for this project");
  });

  it("passes the product's own 401 through, not as a local refusal", async () => {
    await connect();
    responseStatus = 401;
    responseBody = { error: "unknown token", code: "token-unknown" };
    provision(AGENT, AGENT_TOKEN);
    const result = (await callTool({
      name: "create_workitem",
      arguments: { projectId: PROJECT, title: "Task", intent: "Do", eventId: EVENT },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    expect(received).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("returned 401");
    expect(result.content[0]?.text).toContain("token-unknown");
    expect(result.structuredContent).toBeUndefined();
  });
});

const CREATE_ARGS = { projectId: PROJECT, title: "Task", intent: "Do", eventId: EVENT };
const WRITE_OK = {
  readOk: true,
  project: PROJECT,
  found: true,
  item: { id: ITEM, title: "Task", intent: "Do", state: "open" },
  events: [],
  ledger: {},
  event: { id: EVENT, type: "created", actor: AGENT, at: "server-time" },
  deduplicated: false,
};

type ToolResult = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: { error?: Record<string, unknown> };
};

describe("work-item write credentials", () => {
  it("sends the ticketed agent's own token and forwards no ticket or identity fields", async () => {
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    provision("someone-else", "B".repeat(43));
    const result = (await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    expect(received[0]?.body).toEqual({ eventId: EVENT, title: "Task", intent: "Do" });
    expect(JSON.stringify(received[0]?.body)).not.toMatch(/acting|ticket/i);
  });

  it("forwards create_workitem's estimate to the product (SCRUM-150)", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, estimate: "XL" },
    });
    expect(received[0]?.body).toEqual({ eventId: EVENT, title: "Task", intent: "Do", estimate: "XL" });
  });

  it("forwards create_workitem's tracking fields to the product (SCRUM-147)", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    const focus = "01890000-0000-7000-8000-0000000000f0";
    await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, kind: "task", assignee: "owner-agent", focus, test: true },
    });
    expect(received[0]?.body).toEqual({
      eventId: EVENT,
      title: "Task",
      intent: "Do",
      kind: "task",
      assignee: "owner-agent",
      focus,
      test: true,
    });
  });

  it("keeps omitted create_workitem tracking fields out of the body (SCRUM-147)", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } });
    expect(Object.keys(received[0]?.body as object).sort()).toEqual(["eventId", "intent", "title"]);
  });

  it("sends workitem_estimate as the ticketed agent, with exactly eventId and size", async () => {
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    const result = (await callTool({
      name: "workitem_estimate",
      arguments: { projectId: PROJECT, itemId: ITEM, size: "M", eventId: EVENT },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/api/workitems/" + ITEM + "/estimate?project=" + PROJECT,
      authorization: "Bearer " + AGENT_TOKEN,
    });
    expect(received[0]?.body).toEqual({ eventId: EVENT, size: "M" });
  });

  it.each<Via>(["claude", "codex", "embedded"])(
    "sends workitem_note as the ticketed agent via the %s key, with exactly eventId and text (SCRUM-170)",
    async (via) => {
      await connect("instance-token");
      responseStatus = 201;
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      provision("someone-else", "B".repeat(43));
      const result = (await callTool(
        { name: "workitem_note", arguments: { projectId: PROJECT, itemId: ITEM, text: "Scope was wrong", eventId: EVENT } },
        via,
      )) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        method: "POST",
        url: "/api/workitems/" + ITEM + "/note?project=" + PROJECT,
        authorization: "Bearer " + AGENT_TOKEN,
      });
      // ticketId (embedded) is stripped; no actor or state is sent, and no
      // origin because this ctx has no session key.
      expect(received[0]?.body).toEqual({ eventId: EVENT, text: "Scope was wrong" });
    },
  );

  it("generates the workitem_note eventId when omitted, still with exactly eventId and text", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({ name: "workitem_note", arguments: { projectId: PROJECT, itemId: ITEM, text: "x" } }, "embedded");
    const body = received[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["eventId", "text"]);
    expect(body.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  const noteResponses: [number, Record<string, unknown>, string[]][] = [
    [201, { ...WRITE_OK, deduplicated: false }, ['"deduplicated": false']],
    [200, { ...WRITE_OK, deduplicated: true }, ['"deduplicated": true']],
    [409, { error: "a completed item cannot be noted", code: "invalid-transition" }, ["returned 409", "invalid-transition", "a completed item cannot be noted"]],
    [409, { error: "event " + EVENT + " already exists with different content", code: "event-conflict" }, ["returned 409", "event-conflict", "already exists with different content"]],
    [400, { error: "text must be 1-2000 characters", code: "invalid-text" }, ["returned 400", "invalid-text", "text must be 1-2000 characters"]],
    [404, { error: "work item not found", code: "not-found" }, ["returned 404", "not-found", "work item not found"]],
  ];
  it.each(noteResponses)("passes the product's %i for workitem_note through unchanged", async (status, body, expected) => {
    await connect();
    responseStatus = status;
    responseBody = body;
    provision(AGENT, AGENT_TOKEN);
    const result = (await callTool({
      name: "workitem_note",
      arguments: { projectId: PROJECT, itemId: ITEM, text: "x", eventId: EVENT },
    })) as ToolResult;
    expect(received).toHaveLength(1);
    expect(Boolean(result.isError)).toBe(status >= 400);
    // A product refusal is not a local one: no plugin code is attached.
    expect(result.structuredContent).toBeUndefined();
    for (const fragment of expected) expect(result.content[0]?.text).toContain(fragment);
  });

  it("refuses workitem_estimate locally with no-agent-token, never the instance token", async () => {
    await connect("instance-token");
    const result = (await callTool({
      name: "workitem_estimate",
      arguments: { projectId: PROJECT, itemId: ITEM, size: "M" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({
      code: "no-agent-token",
      agentId: AGENT,
      path: join(tokenDir, AGENT),
    });
  });

  it("re-reads the token file on every call, so rotation needs no restart", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } });
    provision(AGENT, "C".repeat(43));
    await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } });
    expect(received.map((r) => r.authorization)).toEqual([
      "Bearer " + AGENT_TOKEN,
      "Bearer " + "C".repeat(43),
    ]);
  });

  it("leaves reads on the instance token", async () => {
    await connect("instance-token");
    responseBody = { readOk: true, project: PROJECT, items: [], store: {}, index: {} };
    await callTool({ name: "list_workitems", arguments: { projectId: PROJECT } });
    expect(received[0]?.authorization).toBe("Bearer instance-token");
  });

  /**
   * SCRUM-144's token lookup, now fed by the ticket (SCRUM-182): override, then
   * the ticket's engine state dir, then dirname(OPENCLAW_CONFIG_PATH), then a
   * refusal naming the agent and path. Each step has its own test below.
   */
  const refusals: [string, () => void, string, RegExp, boolean][] = [
    [
      "the ticketed agent id is not a safe path segment",
      () => {
        ticketAgent = "../" + AGENT;
      },
      "unsafe-agent-id",
      /not a single safe path segment/,
      false,
    ],
    [
      "no engine state dir can be resolved",
      () => {
        ticketEngineDir = "relative/state";
      },
      "no-engine-state-dir",
      /cannot locate the token for agent joylabs-backend-dev/,
      false,
    ],
    [
      "the token file is missing",
      () => undefined,
      "no-agent-token",
      /no SingleIntent token for agent joylabs-backend-dev: .*workitem-tokens\/joylabs-backend-dev does not exist/,
      true,
    ],
  ];

  for (const [label, arrange, code, message, namesPath] of refusals) {
    it(`refuses locally with ${code} when ${label}, making no request`, async () => {
      await connect("instance-token");
      arrange();
      const result = (await callTool({
        name: "create_workitem",
        arguments: { ...CREATE_ARGS },
      })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(received).toEqual([]);
      expect(result.content[0]?.text).toMatch(message);
      expect(result.structuredContent?.error).toMatchObject({ code });
      expect(result.structuredContent?.error).not.toHaveProperty("status");
      if (namesPath) {
        expect(result.structuredContent?.error).toMatchObject({
          agentId: AGENT,
          path: join(tokenDir, AGENT),
        });
      }
    });
  }

  it("ignores OPENCLAW_STATE_DIR: alone it resolves no token dir", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    ticketEngineDir = "relative/state";
    const result = (await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code: "no-engine-state-dir" });
  });

  it("uses the ticket's engine state dir ahead of OPENCLAW_CONFIG_PATH", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "si-other-state-"));
    try {
      vi.stubEnv("OPENCLAW_CONFIG_PATH", join(otherDir, "openclaw.json"));
      mkdirSync(join(otherDir, "singleintent", "workitem-tokens"), { recursive: true });
      writeFileSync(join(otherDir, "singleintent", "workitem-tokens", AGENT), "env-dir-token");
      await connect("instance-token");
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } });
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("falls back to dirname(OPENCLAW_CONFIG_PATH) when the ticket's dir is unusable", async () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", join(stateDir, "openclaw.json"));
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    ticketEngineDir = "relative/state";
    await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS },
    });
    expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
  });

  it("refuses locally when the token file is empty", async () => {
    await connect();
    const path = provision(AGENT, "  ");
    const result = (await callTool({
      name: "workitem_set_state",
      arguments: { projectId: PROJECT, itemId: ITEM, state: "started" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.content[0]?.text).toContain(`${path} is empty`);
    expect(result.structuredContent?.error).toMatchObject({
      code: "no-agent-token",
      agentId: AGENT,
      path,
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
    provision("someone-else", "B".repeat(43));
    const result = (await callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code: "no-agent-token", agentId: AGENT });
  });

  it("follows the principals-file override over the hook's state dir", async () => {
    const productDir = mkdtempSync(join(tmpdir(), "si-principals-"));
    try {
      vi.stubEnv("SINGLEINTENT_WORKITEM_PRINCIPALS_FILE", join(productDir, "workitem-principals.json"));
      await connect();
      responseBody = WRITE_OK;
      provision(AGENT, "wrong-dir-token");
      mkdirSync(join(productDir, "singleintent", "workitem-tokens"), { recursive: true });
      writeFileSync(join(productDir, "singleintent", "workitem-tokens", AGENT), AGENT_TOKEN);
      await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } });
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    } finally {
      rmSync(productDir, { recursive: true, force: true });
    }
  });

  it("declares no acting, ticketId or origin argument in any tool schema", async () => {
    await connect();
    const { tools } = await client!.listTools();
    for (const tool of tools) {
      const names = Object.keys(tool.inputSchema.properties ?? {});
      expect(
        names.filter((n) => n.startsWith("acting") || ["ticketId", "origin", "sessionKey", "runId"].includes(n)),
      ).toEqual([]);
    }
  });
});

/**
 * SCRUM-144: per-agent writes survive `openclaw plugins update` and the
 * product's connector bind. Both replace or rewrite files under the plugin's
 * install root; the agent's token lives under the engine state dir, outside it,
 * and instance.json carries only the port.
 */
describe("work-item writes across plugins update and connector bind", () => {
  type Api = { server: HttpServer; port: number; auth: (string | undefined)[] };
  const apis: Api[] = [];
  let root: string;

  async function startApi(): Promise<Api> {
    const auth: (string | undefined)[] = [];
    const server = httpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        auth.push(req.headers.authorization);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(WRITE_OK));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const api = { server, port: (server.address() as { port: number }).port, auth };
    apis.push(api);
    return api;
  }

  /** What the product's bind writes: `{port}` and nothing else. */
  function bind(installRoot: string, port: number): void {
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, "instance.json"), JSON.stringify({ port }, null, 2) + "\n");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "si-install-"));
  });

  afterEach(async () => {
    for (const api of apis.splice(0))
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps writing as the same agent after the install root is replaced and rebound", async () => {
    const tokenPath = provision(AGENT, AGENT_TOKEN);
    const api = await startApi();
    // The manifest points SINGLEINTENT_CONFIG at ${CLAUDE_PLUGIN_ROOT}/instance.json;
    // an update gives the plugin a new install root, so the path moves with it.
    let installRoot = join(root, "singleintent-0.1.3");
    bind(installRoot, api.port);
    mcpServer = createServer(
      () => loadConfig({ SINGLEINTENT_CONFIG: join(installRoot, "instance.json") }),
      { ticketsDir: () => ticketsDir },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "survival-test", version: "0.0.0" });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const write = () =>
      callTool({
        name: "create_workitem",
        arguments: { ...CREATE_ARGS },
      }) as Promise<ToolResult>;

    expect((await write()).isError).toBeFalsy();

    // plugins update: the old install root, instance.json included, is removed.
    rmSync(installRoot, { recursive: true, force: true });
    installRoot = join(root, "singleintent-0.1.4");
    expect(existsSync(tokenPath)).toBe(true);
    // The product's bind writes the new instance.json as the last install step.
    bind(installRoot, api.port);
    expect((await write()).isError).toBeFalsy();

    expect(api.auth).toEqual(["Bearer " + AGENT_TOKEN, "Bearer " + AGENT_TOKEN]);
    expect(readFileSync(tokenPath, "utf8")).toBe(AGENT_TOKEN + "\n");
  });

  it("follows a rebind to a new port with the agent's token, not a token from instance.json", async () => {
    const tokenPath = provision(AGENT, AGENT_TOKEN);
    const before = await startApi();
    const after = await startApi();
    const installRoot = join(root, "singleintent-0.1.4");
    bind(installRoot, before.port);
    mcpServer = createServer(
      () => loadConfig({ SINGLEINTENT_CONFIG: join(installRoot, "instance.json") }),
      { ticketsDir: () => ticketsDir },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "survival-test", version: "0.0.0" });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const write = () =>
      callTool({
        name: "workitem_set_state",
        arguments: { projectId: PROJECT, itemId: ITEM, state: "started" },
      }) as Promise<ToolResult>;

    expect((await write()).isError).toBeFalsy();
    // A rebind rewrites instance.json in place. A stale shared token left in it
    // is ignored; the write still goes out with the agent's own token.
    writeFileSync(
      join(installRoot, "instance.json"),
      JSON.stringify({ port: after.port, token: "retired-shared-token" }),
    );
    expect((await write()).isError).toBeFalsy();

    expect(before.auth).toEqual(["Bearer " + AGENT_TOKEN]);
    expect(after.auth).toEqual(["Bearer " + AGENT_TOKEN]);
    expect(readFileSync(tokenPath, "utf8")).toBe(AGENT_TOKEN + "\n");
  });
});

/**
 * SCRUM-182: one identity path. The server takes the agent only from a call
 * ticket the hook wrote, keyed by exactly one runtime call id, and refuses
 * every other shape. Each refusal has its own code and makes no request.
 */
describe("work-item write call tickets (SCRUM-182)", () => {
  const refused = async (
    params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> },
    code: string,
    message: RegExp,
  ): Promise<void> => {
    const result = (await client!.callTool(params)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code });
    expect(result.content[0]?.text).toMatch(message);
  };

  /** Run the real hook for a native call and return the id it ticketed. */
  const ticketNative = (
    verb: string,
    args: Record<string, unknown>,
    overrides: { now?: () => number } = {},
  ): string => {
    const id = `toolu_matrix_${++callSeq}`;
    const hook = issueCallTicket(
      { toolName: `mcp__singleintent__${verb}`, params: args, toolCallId: id },
      { agentId: AGENT, sessionKey: "agent:test:main", runId: "run-1" },
      {
        engineStateDir: () => stateDir,
        ticketsDir: () => ticketsDir,
        now: overrides.now ?? Date.now,
        nonce: newNonce,
      },
    );
    expect(hook).toBeUndefined();
    return id;
  };

  it.each<Via>(["claude", "codex", "embedded"])(
    "writes as the ticketed agent via the %s key, sending neither key nor ticket to the product",
    async (via) => {
      await connect("instance-token");
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      const result = (await callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS } }, via)) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
      expect(received[0]?.body).toEqual({ eventId: EVENT, title: "Task", intent: "Do" });
    },
  );

  it("consumes the ticket: the ticket dir holds only the tombstone afterwards", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await callTool({ name: "workitem_estimate", arguments: { projectId: PROJECT, itemId: ITEM, size: "S" } });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(ticketsDir).every((n) => n.endsWith(".used"))).toBe(true);
  });

  it("refuses with no-call-ticket when no hook issued one", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS }, _meta: { "claudecode/toolUseId": "toolu_never" } },
      "no-call-ticket",
      /no ticket exists for this call key/,
    );
  });

  it("refuses with no-call-ticket for a forged ticketId", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS, ticketId: "forged" } },
      "no-call-ticket",
      /no ticket exists/,
    );
  });

  it("refuses with no-call-key when the request carries no key", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await refused({ name: "create_workitem", arguments: { ...CREATE_ARGS } }, "no-call-key", /carries no call key/);
  });

  it.each([
    ["an empty _meta id", { _meta: { callId: "" } }, {}],
    ["a non-string ticketId", {}, { ticketId: 7 }],
  ])("refuses with no-call-key on %s", async (_label, extra, argExtra) => {
    await connect("instance-token");
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS, ...argExtra }, ...extra },
      "no-call-key",
      /not a non-empty string/,
    );
  });

  it.each([
    ["both _meta ids", { "claudecode/toolUseId": "a", callId: "b" }, {}],
    ["a _meta id and a ticketId", { callId: "b" }, { ticketId: "c" }],
  ])("refuses with multiple-call-keys on %s", async (_label, meta, argExtra) => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS });
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS, ...argExtra }, _meta: { ...meta, callId: id } },
      "multiple-call-keys",
      /more than one call key/,
    );
  });

  it.each(["actingAgentId", "actingEngineStateDir", "actingSessionKey", "actingRunId"])(
    "refuses with acting-args-refused when the request carries %s, even with a valid ticket",
    async (key) => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      const id = ticketNative("create_workitem", { ...CREATE_ARGS });
      await refused(
        { name: "create_workitem", arguments: { ...CREATE_ARGS, [key]: AGENT }, _meta: { callId: id } },
        "acting-args-refused",
        new RegExp(key),
      );
    },
  );

  it("refuses with call-ticket-digest-mismatch when the arguments changed after the hook", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS });
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS, title: "Other" }, _meta: { callId: id } },
      "call-ticket-digest-mismatch",
      /arguments differ/,
    );
  });

  it("refuses with call-ticket-verb-mismatch when the ticket was for another verb", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const args = { projectId: PROJECT, itemId: ITEM, size: "M" };
    const id = ticketNative("workitem_estimate", args);
    await refused(
      { name: "workitem_set_state", arguments: args, _meta: { callId: id } },
      "call-ticket-verb-mismatch",
      /issued for workitem_estimate, not workitem_set_state/,
    );
  });

  it("refuses with call-ticket-expired after the TTL", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS }, { now: () => Date.now() - 181_000 });
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS }, _meta: { callId: id } },
      "call-ticket-expired",
      /expired/,
    );
  });

  it("refuses a replay with call-ticket-replayed", async () => {
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS });
    const params = { name: "create_workitem", arguments: { ...CREATE_ARGS }, _meta: { "claudecode/toolUseId": id } };
    expect(((await client!.callTool(params)) as ToolResult).isError).toBeFalsy();
    expect(received).toHaveLength(1);
    received = [];
    await refused(params, "call-ticket-replayed", /already claimed/);
  });

  it("refuses a malformed ticket with call-ticket-malformed", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS });
    const { createHash } = await import("node:crypto");
    const file = join(ticketsDir, createHash("sha256").update(id).digest("hex") + ".json");
    writeFileSync(file, "{not json");
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS }, _meta: { callId: id } },
      "call-ticket-malformed",
      /not a valid v1 call ticket/,
    );
  });

  it("refuses with call-ticket-dir-unsafe when the tickets dir is open to group or other", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    const id = ticketNative("create_workitem", { ...CREATE_ARGS });
    chmodSync(ticketsDir, 0o755);
    await refused(
      { name: "create_workitem", arguments: { ...CREATE_ARGS }, _meta: { callId: id } },
      "call-ticket-dir-unsafe",
      /call-ticket directory .*\.call-tickets is unsafe: its mode is 0755/,
    );
  });

  describe("workitem_note (SCRUM-170)", () => {
    const NOTE_ARGS = { projectId: PROJECT, itemId: ITEM, text: "Scope was wrong", eventId: EVENT };

    it("claims the hook's ticket and leaves only the tombstone", async () => {
      await connect("instance-token");
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      const id = ticketNative("workitem_note", { ...NOTE_ARGS });
      const result = (await client!.callTool({
        name: "workitem_note",
        arguments: { ...NOTE_ARGS },
        _meta: { "claudecode/toolUseId": id },
      })) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(ticketsDir).every((n) => n.endsWith(".used"))).toBe(true);
    });

    it("refuses with no-call-ticket when no hook issued one", async () => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      await refused(
        { name: "workitem_note", arguments: { ...NOTE_ARGS }, _meta: { "claudecode/toolUseId": "toolu_never" } },
        "no-call-ticket",
        /no ticket exists for this call key/,
      );
    });

    it("refuses with no-call-ticket for a model-forged ticketId", async () => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      await refused(
        { name: "workitem_note", arguments: { ...NOTE_ARGS, ticketId: "forged" } },
        "no-call-ticket",
        /no ticket exists/,
      );
    });

    it("refuses with no-call-key when the request carries no key", async () => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      await refused({ name: "workitem_note", arguments: { ...NOTE_ARGS } }, "no-call-key", /carries no call key/);
    });

    it.each(["actingAgentId", "actingEngineStateDir", "actingSessionKey", "actingRunId"])(
      "refuses with acting-args-refused when the request carries %s, even with a valid ticket",
      async (key) => {
        await connect("instance-token");
        provision(AGENT, AGENT_TOKEN);
        const id = ticketNative("workitem_note", { ...NOTE_ARGS });
        await refused(
          { name: "workitem_note", arguments: { ...NOTE_ARGS, [key]: AGENT }, _meta: { callId: id } },
          "acting-args-refused",
          new RegExp(key),
        );
      },
    );

    it("refuses with call-ticket-digest-mismatch when the text changed after the hook", async () => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      const id = ticketNative("workitem_note", { ...NOTE_ARGS });
      await refused(
        { name: "workitem_note", arguments: { ...NOTE_ARGS, text: "Other" }, _meta: { callId: id } },
        "call-ticket-digest-mismatch",
        /arguments differ/,
      );
    });

    it("refuses with call-ticket-verb-mismatch on another verb's ticket", async () => {
      await connect("instance-token");
      provision(AGENT, AGENT_TOKEN);
      const args = { projectId: PROJECT, itemId: ITEM, size: "M" };
      const id = ticketNative("workitem_estimate", args);
      await refused(
        { name: "workitem_note", arguments: args, _meta: { callId: id } },
        "call-ticket-verb-mismatch",
        /issued for workitem_estimate, not workitem_note/,
      );
    });
  });

  it("leaves reads untouched: no key, no ticket, instance token", async () => {
    await connect("instance-token");
    responseBody = { readOk: true, project: PROJECT, items: [], store: {}, index: {} };
    const result = (await client!.callTool({ name: "list_workitems", arguments: { projectId: PROJECT } })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(received[0]?.authorization).toBe("Bearer instance-token");
  });
});

/**
 * SCRUM-148 on the call-ticket path: the origin is the session key and run id
 * the hook recorded in the ticket from the Gateway ctx, sent as the body's
 * `origin: {sessionKey, runId?}`, the shape 018dee3 sent from its stamps.
 */
describe("work-item write origin (SCRUM-148)", () => {
  const SESSION = "agent:" + AGENT + ":main";
  const RUN = "run-148";
  const WRITES: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["create_workitem", CREATE_ARGS, { eventId: EVENT, title: "Task", intent: "Do" }],
    [
      "workitem_set_state",
      { projectId: PROJECT, itemId: ITEM, state: "started", eventId: EVENT },
      { eventId: EVENT, state: "started" },
    ],
    [
      "workitem_estimate",
      { projectId: PROJECT, itemId: ITEM, size: "M", eventId: EVENT },
      { eventId: EVENT, size: "M" },
    ],
    // SCRUM-170: the note sends the ticket's origin like the other writes.
    [
      "workitem_note",
      { projectId: PROJECT, itemId: ITEM, text: "Scope was wrong", eventId: EVENT },
      { eventId: EVENT, text: "Scope was wrong" },
    ],
  ];
  const VIAS: Via[] = ["claude", "codex", "embedded"];
  const EACH = WRITES.flatMap(([name, args, body]) => VIAS.map((via) => [name, via, args, body] as const));

  it.each(EACH)(
    "%s via the %s key sends origin {sessionKey, runId} from the ticket and nothing else extra",
    async (name, via, args, body) => {
      await connect("instance-token");
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      const result = (await callTool({ name, arguments: { ...args } }, via, {
        sessionKey: SESSION,
        runId: RUN,
      })) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
      expect(received[0]?.body).toEqual({ ...body, origin: { sessionKey: SESSION, runId: RUN } });
      expect(JSON.stringify(received[0]?.body)).not.toMatch(/acting|ticket/i);
    },
  );

  const withSessions = (sessions: [string, { sessionKey?: string; runId?: string }][]) =>
    WRITES.flatMap(([name, args, body]) =>
      sessions.map(([label, session]) => [name, label, args, body, session] as const),
    );

  it.each(withSessions([["absent", { sessionKey: SESSION }], ["empty", { sessionKey: SESSION, runId: "" }]]))(
    "%s sends origin without runId when the run id is %s",
    async (name, _label, args, body, session) => {
      await connect();
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      await callTool({ name, arguments: { ...args } }, "claude", session);
      expect(received[0]?.body).toEqual({ ...body, origin: { sessionKey: SESSION } });
    },
  );

  it.each(withSessions([["absent", { runId: RUN }], ["empty", { sessionKey: "", runId: RUN }]]))(
    "%s sends no origin key when the session key is %s, even with a run id",
    async (name, _label, args, body, session) => {
      await connect();
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      await callTool({ name, arguments: { ...args } }, "embedded", session);
      expect(received[0]?.body).toEqual(body);
      expect(received[0]?.body).not.toHaveProperty("origin");
    },
  );

  // The product answers 400 origin-session-mismatch unless the origin's session
  // key is agent:<principal>:…; the principal is the ticket's agent.
  it.each(
    withSessions([
      ["another agent's", { sessionKey: "agent:other:main", runId: RUN }],
      ["a prefix-sharing agent's", { sessionKey: "agent:" + AGENT + "x:main", runId: RUN }],
    ]),
  )("%s sends no origin for %s session key, and still writes as the ticket's agent", async (name, _label, args, body, session) => {
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    const result = (await callTool({ name, arguments: { ...args } }, "claude", session)) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    expect(received[0]?.body).toEqual(body);
  });

  it.each(WRITES.map(([name, args]) => [name, args] as const))(
    "%s sends an origin whose session key belongs to the ticket's agent",
    async (name, args) => {
      await connect();
      responseBody = WRITE_OK;
      provision(AGENT, AGENT_TOKEN);
      await callTool({ name, arguments: { ...args } }, "embedded", { sessionKey: SESSION, runId: RUN });
      const origin = (received[0]?.body as { origin?: { sessionKey: string } }).origin;
      expect(origin?.sessionKey.startsWith("agent:" + AGENT + ":")).toBe(true);
    },
  );

  it.each(
    WRITES.flatMap(([name, args]) =>
      [
        ["origin", { sessionKey: "agent:other:main", runId: "r" }],
        ["sessionKey", "agent:other:main"],
        ["runId", "forged"],
      ].map(([key, value]) => [name, key as string, args, value] as const),
    ),
  )("%s refuses a model %s with origin-args-refused, even with a valid ticket", async (name, key, args, value) => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    // A ticket for exactly these arguments, as if the hook had not blocked them.
    const id = `toolu_origin_${++callSeq}`;
    const withOrigin = { ...args, [key]: value };
    writeTicket(
      ticketsDir,
      id,
      {
        agentId: AGENT,
        engineStateDir: stateDir,
        sessionKey: SESSION,
        runId: RUN,
        verb: name,
        argsDigest: argsDigest(withOrigin),
        expiresAt: Date.now() + 60_000,
      },
      Date.now(),
    );
    const result = (await client!.callTool({ name, arguments: withOrigin, _meta: { callId: id } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code: "origin-args-refused" });
    expect(result.content[0]?.text).toMatch(new RegExp(`carries ${key}\\b`));
  });

  it("the hook blocks a model origin before any ticket or request", async () => {
    await connect("instance-token");
    provision(AGENT, AGENT_TOKEN);
    await expect(
      callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS, origin: { sessionKey: SESSION } } }, "embedded", {
        sessionKey: SESSION,
        runId: RUN,
      }),
    ).rejects.toThrow(/\[origin-args-refused\]/);
    expect(received).toEqual([]);
    expect(existsSync(ticketsDir)).toBe(false);
  });
});

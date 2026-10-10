import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as httpServer,
  type Server as HttpServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "./config.js";
import { createServer } from "./mcp-server.js";

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
  mcpServer = createServer(() => config);
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

/** What the plugin's before_tool_call hook adds to a write tool's arguments. */
const acting = () => ({ actingAgentId: AGENT, actingEngineStateDir: stateDir });

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
    await client!.callTool({
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
    await client!.callTool({
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
    const result = await client!.callTool({
      name: "workitem_set_state",
      arguments: {
        ...acting(),
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

  it("returns the product's machine-readable failure as an MCP tool error", async () => {
    await connect();
    responseStatus = 403;
    responseBody = {
      error: "principal is not authorized for this project",
      code: "project-forbidden",
    };
    provision(AGENT, AGENT_TOKEN);
    const result = await client!.callTool({
      name: "create_workitem",
      arguments: {
        ...acting(),
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
    const result = (await client!.callTool({
      name: "create_workitem",
      arguments: { ...acting(), projectId: PROJECT, title: "Task", intent: "Do", eventId: EVENT },
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
  it("sends the acting agent's own token and does not forward the acting arguments", async () => {
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    provision("someone-else", "B".repeat(43));
    const result = (await client!.callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, ...acting() },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    expect(received[0]?.body).toEqual({ eventId: EVENT, title: "Task", intent: "Do" });
    expect(JSON.stringify(received[0]?.body)).not.toMatch(/acting/);
  });

  it("re-reads the token file on every call, so rotation needs no restart", async () => {
    await connect();
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await client!.callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS, ...acting() } });
    provision(AGENT, "C".repeat(43));
    await client!.callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS, ...acting() } });
    expect(received.map((r) => r.authorization)).toEqual([
      "Bearer " + AGENT_TOKEN,
      "Bearer " + "C".repeat(43),
    ]);
  });

  it("leaves reads on the instance token", async () => {
    await connect("instance-token");
    responseBody = { readOk: true, project: PROJECT, items: [], store: {}, index: {} };
    await client!.callTool({ name: "list_workitems", arguments: { projectId: PROJECT } });
    expect(received[0]?.authorization).toBe("Bearer instance-token");
  });

  const refusals: [string, () => Record<string, unknown>, string, RegExp, boolean][] = [
    [
      "the acting agent is missing",
      () => ({ actingEngineStateDir: stateDir }),
      "no-acting-agent",
      /no acting agent/,
      false,
    ],
    [
      "the acting agent id is not a safe path segment",
      () => ({ actingAgentId: "../" + AGENT, actingEngineStateDir: stateDir }),
      "unsafe-agent-id",
      /not a single safe path segment/,
      false,
    ],
    [
      "no engine state dir can be resolved",
      () => ({ actingAgentId: AGENT }),
      "no-engine-state-dir",
      /cannot locate the token for agent joylabs-backend-dev/,
      false,
    ],
    [
      "the token file is missing",
      () => acting(),
      "no-agent-token",
      /no work-item token for agent joylabs-backend-dev: .*workitem-tokens\/joylabs-backend-dev does not exist/,
      true,
    ],
  ];

  for (const [label, extra, code, message, namesPath] of refusals) {
    it(`refuses locally with ${code} when ${label}, making no request`, async () => {
      await connect("instance-token");
      const result = (await client!.callTool({
        name: "create_workitem",
        arguments: { ...CREATE_ARGS, ...extra() },
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
    const result = (await client!.callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, actingAgentId: AGENT },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(received).toEqual([]);
    expect(result.structuredContent?.error).toMatchObject({ code: "no-engine-state-dir" });
  });

  it("falls back to dirname(OPENCLAW_CONFIG_PATH) when the hook supplied no dir", async () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", join(stateDir, "openclaw.json"));
    await connect("instance-token");
    responseBody = WRITE_OK;
    provision(AGENT, AGENT_TOKEN);
    await client!.callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, actingAgentId: AGENT },
    });
    expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
  });

  it("refuses locally when the token file is empty", async () => {
    await connect();
    const path = provision(AGENT, "  ");
    const result = (await client!.callTool({
      name: "workitem_set_state",
      arguments: { ...acting(), projectId: PROJECT, itemId: ITEM, state: "started" },
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
    const result = (await client!.callTool({
      name: "create_workitem",
      arguments: { ...CREATE_ARGS, ...acting() },
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
      await client!.callTool({ name: "create_workitem", arguments: { ...CREATE_ARGS, ...acting() } });
      expect(received[0]?.authorization).toBe("Bearer " + AGENT_TOKEN);
    } finally {
      rmSync(productDir, { recursive: true, force: true });
    }
  });

  it("does not declare the acting arguments in any tool schema", async () => {
    await connect();
    const { tools } = await client!.listTools();
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("actingAgentId");
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("actingEngineStateDir");
    }
  });
});

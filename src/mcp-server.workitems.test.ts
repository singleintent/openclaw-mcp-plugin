import {
  createServer as httpServer,
  type Server as HttpServer,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
let received: { method: string; url: string; body: unknown }[] = [];
let responseStatus = 200;
let responseBody: unknown;

async function connect(): Promise<void> {
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

afterEach(async () => {
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
    const result = await client!.callTool({
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

  it("returns the product's machine-readable failure as an MCP tool error", async () => {
    await connect();
    responseStatus = 403;
    responseBody = {
      error: "principal is not authorized for this project",
      code: "project-forbidden",
    };
    const result = await client!.callTool({
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
});

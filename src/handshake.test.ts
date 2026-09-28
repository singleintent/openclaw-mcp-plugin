/**
 * Runtime proof against the built artifact.
 *
 * Neither `openclaw mcp list`, `openclaw mcp probe`, nor `openclaw plugins
 * validate` can see or check a manifest-declared MCP server, so this drives the
 * real stdio handshake instead. It runs against dist/, which means it also fails
 * when the package ships no executable code.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../dist/mcp-server.js", import.meta.url));

const PROTOCOL_VERSION = "2025-06-18";

type Response = { id?: number; result?: Record<string, unknown> };

async function handshake(): Promise<Response[]> {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "handshake-test", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];

  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  expect(stderr, "server wrote diagnostics to stderr").toBe("");
  expect(code, "server exited non-zero").toBe(0);

  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Response);
}

describe("built server answers a real MCP handshake", () => {
  it("initializes and lists tools over stdio", async () => {
    const responses = await handshake();

    const initialize = responses.find((r) => r.id === 1);
    expect(initialize?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      // The name OpenClaw prefixes discovered tools with.
      serverInfo: { name: "singleintent", version: "0.1.0" },
    });

    const listTools = responses.find((r) => r.id === 2);
    const tools = (listTools?.result as { tools?: { name?: string }[] })?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["list_projects"]);
  }, 30_000);
});

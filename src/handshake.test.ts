/**
 * Runtime proof against the built artifact.
 *
 * Neither `openclaw mcp list`, `openclaw mcp probe`, nor `openclaw plugins
 * validate` can see or check a manifest-declared MCP server, so this drives the
 * real stdio handshake instead. It runs against dist/, which means it also fails
 * when the package ships no executable code.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION, TOOLS } from "./mcp-server.js";

const SERVER = fileURLToPath(new URL("../dist/mcp-server.js", import.meta.url));

const PROTOCOL_VERSION = "2025-06-18";

type Response = { id?: number; result?: Record<string, unknown> };

async function handshake(serverPath: string = SERVER): Promise<Response[]> {
  const child = spawn(process.execPath, [serverPath], {
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
      // Both derived rather than written out. The name is what OpenClaw prefixes
      // discovered tools with, and the version is a string that already exists in
      // four files; a literal here would be a fifth copy, and it would turn every
      // version bump into a failure in the one test whose subject is the handshake.
      // `names.test.ts` is what holds the four in agreement, so asserting the
      // constant here still proves the built artifact reports the bumped version —
      // dist/ is rebuilt by pretest, so a stale build fails this.
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });

    const listTools = responses.find((r) => r.id === 2);
    const tools = (listTools?.result as { tools?: { name?: string }[] })?.tools ?? [];
    // Checked against TOOLS rather than a hand-written list: this test exists to
    // prove the built server really answers over stdio, and a literal here turns
    // every added verb into a failure that says nothing about the handshake.
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(tools.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  /**
   * Regression for a silent no-start.
   *
   * The self-start guard used to compare `import.meta.url` against
   * `"file://" + process.argv[1]`. Node resolves the first through `realpath` and
   * leaves the second alone, so launching the same file by a path crossing a
   * symlink made the guard false: nothing started, the process exited **0**, and
   * the only symptom was a server that served no tools. Found by installing the
   * packed tarball under `/tmp` — which is a symlink to `/private/tmp` on macOS —
   * and driving it over stdio.
   *
   * The launch path is the whole point of this test, so it spawns through a real
   * symlink rather than asserting on the guard's internals. A green
   * `initializes and lists tools over stdio` above does not cover it: that one
   * runs via a path with no symlink in it.
   */
  it("starts when launched through a symlinked path", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "singleintent-symlink-")), "server.js");
    symlinkSync(SERVER, link);
    try {
      const responses = await handshake(link);
      const tools =
        (responses.find((r) => r.id === 2)?.result as { tools?: { name?: string }[] })?.tools ?? [];
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((tool) => tool.name));
    } finally {
      rmSync(link, { force: true });
    }
  }, 30_000);
});

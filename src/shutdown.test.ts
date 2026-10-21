/**
 * Process-lifecycle proof against the built artifact.
 *
 * OpenClaw closes a stdio MCP server by ending its stdin, escalating to SIGTERM
 * after 2s and SIGKILL after 4s. The server has to be gone before the first
 * escalation, including when a tool call is still waiting on the product, or
 * every close costs the host the full grace period.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHUTDOWN_GRACE_MS } from "./mcp-server.js";

const SERVER = fileURLToPath(new URL("../dist/mcp-server.js", import.meta.url));

/** OpenClaw's stdin-EOF grace before it sends SIGTERM. */
const HOST_GRACE_MS = 2000;

type Exit = { code: number | null; signal: NodeJS.Signals | null; afterMs: number };

type Running = {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the exit, timed from the last call to `mark`. */
  exited: Promise<Exit>;
  mark: () => void;
  request: (id: number, method: string, params: Record<string, unknown>) => void;
  response: (id: number) => Promise<unknown>;
};

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A product that accepts every request and never answers it. */
async function stalledProduct(): Promise<number> {
  const server = createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function start(port: number): Promise<Running> {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Never fall through to a real product or a user's config file.
      SINGLEINTENT_CONFIG: "/nonexistent/singleintent-shutdown-test.json",
      SINGLEINTENT_HOST: "127.0.0.1",
      SINGLEINTENT_PORT: String(port),
    },
  });
  children.push(child);

  let out = "";
  let err = "";
  const waiting = new Map<number, (message: unknown) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (err += chunk));
  let pending = "";
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });

  let markedAt = performance.now();
  const exited = new Promise<Exit>((resolve) =>
    child.once("exit", (code, signal) =>
      resolve({ code, signal, afterMs: performance.now() - markedAt }),
    ),
  );
  const request = (id: number, method: string, params: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  const response = (id: number): Promise<unknown> =>
    new Promise((resolve) => waiting.set(id, resolve));

  // Handshake first, so the process is past startup and fully listening.
  const initialized = response(1);
  request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shutdown-test", version: "0" },
  });
  await initialized;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    mark: () => {
      markedAt = performance.now();
    },
    request,
    response,
  };
}

/** Every stdout line is a JSON-RPC message: diagnostics never leak into framing. */
function expectCleanFraming(stdout: string): void {
  for (const line of stdout.split("\n").filter((entry) => entry.trim() !== "")) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }
}

describe("mcp server process lifecycle", () => {
  it("bounds shutdown well inside the host's first escalation", () => {
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(HOST_GRACE_MS / 2);
  });

  it("exits 0 promptly when stdin closes", async () => {
    const server = await start(await stalledProduct());
    server.mark();
    server.child.stdin.end();
    const exit = await server.exited;
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(exit.afterMs).toBeLessThan(HOST_GRACE_MS);
    // A routine close is silent: OpenClaw logs every stderr line.
    expect(server.stderr()).toBe("");
    expectCleanFraming(server.stdout());
  });

  it("exits promptly on SIGTERM with stdin still open", async () => {
    const server = await start(await stalledProduct());
    server.mark();
    server.child.kill("SIGTERM");
    const exit = await server.exited;
    expect(exit).toMatchObject({ code: 143, signal: null });
    expect(exit.afterMs).toBeLessThan(HOST_GRACE_MS);
    expect(server.stderr()).toBe("");
    expectCleanFraming(server.stdout());
  });

  it("exits promptly on SIGINT with stdin still open", async () => {
    const server = await start(await stalledProduct());
    server.mark();
    server.child.kill("SIGINT");
    const exit = await server.exited;
    expect(exit).toMatchObject({ code: 130, signal: null });
    expect(exit.afterMs).toBeLessThan(HOST_GRACE_MS);
  });

  it("exits promptly on stdin close while a tool call waits on a stalled product", async () => {
    const port = await stalledProduct();
    const arrived = new Promise<void>((resolve) => servers.at(-1)?.once("request", () => resolve()));
    const server = await start(port);
    server.request(2, "tools/call", { name: "list_projects", arguments: {} });
    // The call is on the wire to the product before the client goes away.
    await arrived;
    server.mark();
    server.child.stdin.end();
    const exit = await server.exited;
    expect(exit.code).toBe(0);
    // Without explicit shutdown this waits out the 10s product timeout.
    expect(exit.afterMs).toBeLessThan(HOST_GRACE_MS);
    expectCleanFraming(server.stdout());
  });
});

#!/usr/bin/env node
/**
 * SingleInstinct MCP server (stdio).
 *
 * OpenClaw launches this process because `openclaw.plugin.json` declares it under
 * `mcpServers.singleinstinct`. That manifest key — not the plugin `id` — is what
 * OpenClaw uses to prefix the tools it discovers here, as `singleinstinct__<verb>`.
 *
 * The verb surface is deliberately empty. The `tools` capability is wired and
 * `tools/list` answers with an empty array, so the handshake proves the packaged
 * code executes without asserting a product surface that is not yet specified.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Kept in step with package.json by src/mcp-server.test.ts. */
export const SERVER_VERSION = "0.1.0";

/** Matches `mcpServers.singleinstinct` in openclaw.plugin.json. */
export const SERVER_NAME = "singleinstinct";

/** Verb surface, pending specification. */
export const TOOLS: Tool[] = [];

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Only self-start when executed directly, so tests can import this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    // stdout carries the MCP framing; diagnostics must go to stderr, where
    // OpenClaw logs them with a `bundle-mcp:singleinstinct:` prefix.
    console.error("singleinstinct mcp server failed to start:", error);
    process.exit(1);
  });
}

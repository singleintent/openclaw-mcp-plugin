#!/usr/bin/env node
/**
 * SingleIntent MCP server (stdio).
 *
 * OpenClaw launches this process because `openclaw.plugin.json` declares it under
 * `mcpServers.singleintent`. That manifest key — not the plugin `id` — is what
 * OpenClaw uses to prefix the tools it discovers here, as `singleintent__<verb>`.
 *
 * Config is resolved by this process rather than handed to it; see src/config.ts
 * for why none of OpenClaw's config surfaces can reach a stdio subprocess.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./names.js";

export { SERVER_NAME, SERVER_VERSION };

/** Verb surface, pending specification. */
export const TOOLS: Tool[] = [];

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
    // OpenClaw logs them with a `bundle-mcp:singleintent:` prefix.
    console.error(`${SERVER_NAME} mcp server failed to start:`, error);
    process.exit(1);
  });
}

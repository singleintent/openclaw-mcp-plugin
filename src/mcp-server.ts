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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./names.js";
import { getProject } from "./verbs/get-project.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  listProjects,
} from "./verbs/list-projects.js";

export { SERVER_NAME, SERVER_VERSION };

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    description:
      "List SingleIntent projects. Returns id, name, working directory and a " +
      "count of agents per project; use get_project for the agent ids of one " +
      "project. Set agent_id to answer \"which projects is this agent in?\" — " +
      "the answer can be more than one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: `Maximum projects to return (1-${MAX_LIMIT}).`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Projects to skip, for paging through a truncated result.",
        },
        agent_id: {
          type: "string",
          description:
            "Keep only projects containing this agent. When set, total counts " +
            "the matching projects, not every project that exists.",
        },
      },
    },
  },
  {
    name: "get_project",
    description:
      "Get one SingleIntent project by id, including the full agentIds array " +
      "that list_projects reduces to a count. Fails with a not-found naming " +
      "the id when no project matches.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id"],
      properties: {
        project_id: {
          type: "string",
          description: "The project's UUID, as returned by list_projects.",
        },
      },
    },
  },
];

/**
 * Config is read once per process. The subprocess is short-lived relative to a
 * config change, and OpenClaw disposes cached MCP runtimes on reload, so a new
 * process picks up new config rather than this one watching for it.
 */
export function createServer(config: Config): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      // Arguments cross the wire in the snake_case of the verb names; the verb
      // modules speak camelCase. The mapping lives here so it happens once.
      if (request.params.name === "list_projects") {
        const result = await listProjects(
          config,
          {
            limit: args.limit as number | undefined,
            offset: args.offset as number | undefined,
            agentId: args.agent_id,
          },
          { signal: extra?.signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      if (request.params.name === "get_project") {
        const result = await getProject(
          config,
          { projectId: args.project_id },
          { signal: extra?.signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      throw new Error(`unknown tool: ${request.params.name}`);
    } catch (error) {
      // isError keeps a product outage or a misconfiguration legible to the
      // agent as a tool failure, rather than surfacing as a protocol error.
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer(loadConfig());
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

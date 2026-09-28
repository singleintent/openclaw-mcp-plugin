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
import type { RequestOptions } from "./client.js";
import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./names.js";
import { getProject } from "./verbs/get-project.js";
import { listAgents } from "./verbs/list-agents.js";
import { listConnections } from "./verbs/list-connections.js";
import { listProjects } from "./verbs/list-projects.js";
import { listTemplates } from "./verbs/list-templates.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./verbs/paging.js";

export { SERVER_NAME, SERVER_VERSION };

/**
 * Every list verb takes the same two paging arguments, described the same way.
 * Written once so the descriptions cannot drift apart per verb, the same reason
 * the arithmetic behind them lives once in `paging.ts`.
 */
const pagingSchema = (noun: string) => ({
  limit: {
    type: "integer" as const,
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description: `Maximum ${noun} to return (1-${MAX_LIMIT}).`,
  },
  offset: {
    type: "integer" as const,
    minimum: 0,
    default: 0,
    description: `${noun[0].toUpperCase()}${noun.slice(1)} to skip, for paging through a truncated result.`,
  },
});

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
        ...pagingSchema("projects"),
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
  {
    name: "list_agents",
    description:
      "List agents on the SingleIntent roster, each with its onboarding status. " +
      "Set project_id to keep only that project's members; the filter runs here, " +
      "not on the server, and reads membership from the same source as " +
      "get_project so the two cannot disagree. Ids the project lists that the " +
      "roster does not have come back in missingFromRoster rather than being " +
      "dropped silently. Note createdAt is epoch milliseconds here, unlike the " +
      "ISO-8601 string list_projects and get_project return.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...pagingSchema("agents"),
        project_id: {
          type: "string",
          description:
            "Keep only agents belonging to this project, by UUID. When set, " +
            "total counts the matching agents, not the whole roster.",
        },
      },
    },
  },
  {
    name: "list_templates",
    description:
      "List onboarding role templates: id, name, and the character length of " +
      "each template's content. The content itself is not returned — it is 95% " +
      "of the raw response and an agent listing templates is choosing one, not " +
      "reading one. This verb tells you which template to use, not what it says.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...pagingSchema("templates") },
    },
  },
  {
    name: "list_connections",
    description:
      "List agent-to-agent connections. Each is directed: from was pointed at " +
      "to and asked to introduce itself, so the pair is not symmetric. Returns " +
      "the whole record — these fields are all bounded, so nothing is dropped. " +
      "The from and to ids are not expanded into agent records; call list_agents " +
      "for that.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...pagingSchema("connections") },
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

  /**
   * Arguments cross the wire in the snake_case of the tool schemas; the verb
   * modules speak camelCase. That mapping is the only thing each entry does, so
   * a table keeps it visible as a table instead of hiding it in a chain of ifs
   * that grows a branch per verb.
   */
  const handlers: Record<
    string,
    (args: Record<string, unknown>, options: RequestOptions) => Promise<unknown>
  > = {
    list_projects: (args, options) =>
      listProjects(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
          agentId: args.agent_id,
        },
        options,
      ),
    get_project: (args, options) => getProject(config, { projectId: args.project_id }, options),
    list_agents: (args, options) =>
      listAgents(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
          projectId: args.project_id,
        },
        options,
      ),
    list_connections: (args, options) =>
      listConnections(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        },
        options,
      ),
    list_templates: (args, options) =>
      listTemplates(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        },
        options,
      ),
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const handler = handlers[request.params.name];
      if (handler === undefined) {
        throw new Error(`unknown tool: ${request.params.name}`);
      }
      const result = await handler(args, { signal: extra?.signal });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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

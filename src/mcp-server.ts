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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { getActivity } from "./verbs/get-activity.js";
import { getBacklog } from "./verbs/get-backlog.js";
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
  {
    name: "get_backlog",
    description:
      "Read the shared backlog: id, title, description, status, owner and " +
      "timestamps per item. Read-only by design — the file is written only by " +
      "agents through their own file tools, with no locking, so a second writer " +
      "would lose items. A stale read is expected, not an error.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...pagingSchema("items") },
    },
  },
  {
    name: "get_activity",
    description:
      "Current agent activity: running sessions plus those that ended recently. " +
      "Returns now, the product server's clock, alongside the sessions; every " +
      "timestamp in the response is epoch milliseconds relative to that now and " +
      "to nothing else. Compute elapsed time against now, not against your own " +
      "clock. nowSource says whose clock it is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...pagingSchema("sessions") },
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
    get_activity: (args, options) =>
      getActivity(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        },
        options,
      ),
    get_backlog: (args, options) =>
      getBacklog(
        config,
        {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
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

/**
 * Is this module the process entry point?
 *
 * The obvious spelling of this check — `import.meta.url === "file://" + argv[1]`
 * — is wrong in two ways, and both fail **silently**: the guard is false, nothing
 * starts, the process exits 0, and OpenClaw sees a server that connected to
 * nothing and reported no error.
 *
 * 1. **Symlinks.** Node resolves `import.meta.url` through `realpath` but leaves
 *    `argv[1]` as the path it was given. Launching the very same file by a path
 *    that crosses a symlink makes the two disagree. This is not exotic: it is how
 *    `/tmp` behaves on macOS (`/private/tmp`), how pnpm lays out `node_modules`,
 *    and how several version managers place binaries. Found by installing the
 *    packed tarball under `/tmp` and driving it over stdio — the server exited 0
 *    and served nothing.
 * 2. **Encoding.** `file://` + a raw path is not a URL. A launch path containing
 *    a space, `#` or `?` produces a string that never equals the properly encoded
 *    `import.meta.url`.
 *
 * Both go away by comparing real filesystem paths rather than hand-built URLs.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // An unreadable or deleted entry path is not this module.
    return false;
  }
}

// Only self-start when executed directly, so tests can import this module.
if (isEntryPoint()) {
  main().catch((error: unknown) => {
    // stdout carries the MCP framing; diagnostics must go to stderr, where
    // OpenClaw logs them with a `bundle-mcp:singleintent:` prefix.
    console.error(`${SERVER_NAME} mcp server failed to start:`, error);
    process.exit(1);
  });
}

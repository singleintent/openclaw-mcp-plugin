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
import { applyRole } from "./verbs/apply-role.js";
import { createAgent } from "./verbs/create-agent.js";
import { createConnection } from "./verbs/create-connection.js";
import { createProject } from "./verbs/create-project.js";
import { createTemplate } from "./verbs/create-template.js";
import { getActivity } from "./verbs/get-activity.js";
import { getBacklog } from "./verbs/get-backlog.js";
import { getProject } from "./verbs/get-project.js";
import { listAgents } from "./verbs/list-agents.js";
import { listConnections } from "./verbs/list-connections.js";
import { listProjects } from "./verbs/list-projects.js";
import { listTemplates } from "./verbs/list-templates.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./verbs/paging.js";
import { sendMessage } from "./verbs/send-message.js";
import { updateTemplate } from "./verbs/update-template.js";
import { NOT_REVERSIBLE } from "./verbs/write-args.js";

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

  // The write verbs. Each is one API call: these descriptions and the argument
  // validation behind them are the whole of what this layer adds.
  //
  // Three things recur in them on purpose. Irreversibility is stated wherever it
  // holds, in one shared sentence, because the product has no delete route and a
  // caller cannot discover that by trying. The verbs that spend a real agent turn
  // say so, because that cost is invisible from a schema. And where a call can only
  // ever succeed once, the description says so rather than leaving a caller to
  // learn it from a 409 it has already spent a turn to reach.
  {
    name: "create_project",
    description:
      "Create a SingleIntent project. Takes a display name and the working " +
      "directory it maps to; returns the created project including the id every " +
      "other verb's project_id refers to. Starts with no member agents. The " +
      "working directory is recorded exactly as given — not created, not checked " +
      "and not resolved — so a wrong path is stored and surfaces later as agents " +
      `pointed somewhere wrong. ${NOT_REVERSIBLE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "working_directory"],
      properties: {
        name: { type: "string", description: "Display name for the project." },
        working_directory: {
          type: "string",
          description:
            "Absolute path this project maps to. Recorded as given; the product " +
            "does not create it or verify that it exists.",
        },
      },
    },
  },
  {
    name: "create_agent",
    description:
      "Register an agent and add it to a SingleIntent project. Returns the new " +
      "agentId, which is what every other verb's agent_id takes. The workspace is " +
      "derived from the project's working directory and is fixed permanently at " +
      "creation, as is the name — neither is editable afterwards, so a wrong one " +
      "means creating another agent. The new agent has no role; use apply_role to " +
      `give it one. ${NOT_REVERSIBLE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "project_id"],
      properties: {
        name: { type: "string", description: "Display name for the agent. Permanent." },
        project_id: {
          type: "string",
          description:
            "UUID of the project to create it in, as returned by list_projects. " +
            "The agent is added to that project and its workspace comes from it.",
        },
        workspace_subpath: {
          type: "string",
          description:
            "Optional path relative to the project's working directory; must stay " +
            "inside it. Defaults to the working directory itself. Permanent.",
        },
        model: {
          type: "string",
          description: "Optional model override. Defaults to the product's choice.",
        },
      },
    },
  },
  {
    name: "create_template",
    description:
      "Create an agent-role template. The content is the role text an agent is " +
      "later told to adopt as its own identity, used verbatim and never rewritten, " +
      "so it should read as instructions to that agent. Returns the created " +
      "template including the id apply_role takes. Its text stays editable through " +
      `update_template, but the template itself cannot be removed. ${NOT_REVERSIBLE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "content"],
      properties: {
        name: { type: "string", description: "Display name for the template." },
        content: {
          type: "string",
          description:
            "The role text itself, applied verbatim when the template is given to " +
            "an agent. This is the payload of the template, not a summary of it.",
        },
      },
    },
  },
  {
    name: "update_template",
    description:
      "Update an agent-role template by id. Name and content are independent and " +
      "each optional: omit one to leave it unchanged, and the response says which " +
      "were sent. A call with neither is refused rather than rewriting nothing. " +
      "This does not change agents that already carry this role — applying a " +
      "template copies its text onto the agent at that moment, so an edit only " +
      "changes what future applications say. It is the one write verb here that " +
      "can be undone: call it again with the previous values, which means reading " +
      "them first if you want to be able to.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["template_id"],
      properties: {
        template_id: {
          type: "string",
          description: "UUID of the template to update, as returned by list_templates.",
        },
        name: { type: "string", description: "New display name. Omit to leave unchanged." },
        content: { type: "string", description: "New role text. Omit to leave unchanged." },
      },
    },
  },
  {
    name: "apply_role",
    description:
      "Give an agent its role from a template. The agent is asked to store the " +
      "template's text as its own identity, which spends a real agent turn and can " +
      "take minutes. An agent can only ever be roled once: any existing role " +
      "record blocks this whatever state it is in, and none can be cleared, so a " +
      "second call always fails and retrying never helps. Check the template is " +
      "the right one before calling. The role is a copy taken now — editing the " +
      `template afterwards will not reach this agent. ${NOT_REVERSIBLE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "template_id"],
      properties: {
        agent_id: {
          type: "string",
          description: "Id of the agent to give the role to, as returned by list_agents.",
        },
        template_id: {
          type: "string",
          description: "UUID of the template whose text becomes the agent's role.",
        },
      },
    },
  },
  {
    name: "create_connection",
    description:
      "Connect one agent to another so they are aware of each other. Directed: " +
      "this connects from to to, not both ways, and the reverse is a separate call " +
      "rather than a free mirror. Wakes the from agent to introduce itself, so it " +
      "spends a real agent turn and is the slowest verb here — minutes, not " +
      "seconds. A connection is mutual awareness for later reference, not a task: " +
      "the product explicitly tells the two agents not to start or discuss work in " +
      "that exchange. Fails if this exact direction already exists; the reverse " +
      `direction is a different connection and never conflicts. ${NOT_REVERSIBLE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "Agent id the connection points from. This agent is woken.",
        },
        to: { type: "string", description: "Agent id the connection points to." },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to an agent and wait for its reply. Blocks for that agent's " +
      "whole turn, which can take minutes; there is no fire-and-forget variant. If " +
      "it times out the message was still delivered and the agent is probably " +
      "still working — check get_activity rather than resending, because resending " +
      "asks it to do the same thing twice. A null reply alongside a terminal status " +
      "means the turn finished and produced no text, which is not an error.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "message"],
      properties: {
        agent_id: {
          type: "string",
          description: "Id of the agent to message, as returned by list_agents.",
        },
        message: { type: "string", description: "The message text to send." },
      },
    },
  },
];

/**
 * Config is resolved per tool call, not once at startup.
 *
 * The file this process reads is written by the product as the last step of
 * installing this plugin, and the Gateway may already have started this process
 * by then — so a startup read can lose a race it cannot see, and would then serve
 * every call of its lifetime against the wrong port. Reading per call also means a
 * product that moves port, or is reinstalled against a different instance, is
 * picked up without this process having to be recycled for it.
 *
 * The cost is one `readFileSync` of a small file per call, against a tool call
 * that is about to make an HTTP request. The benefit is that there is no window
 * in which this process is confidently wrong.
 *
 * `resolveConfig` throwing is deliberately not special-cased: it happens inside
 * the same try that wraps every handler, so a malformed or invalid file comes
 * back as a tool error naming the file rather than killing the transport.
 */
export function createServer(resolveConfig: () => Config): Server {
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
   *
   * Built per call because it closes over the config resolved for that call.
   */
  const buildHandlers = (
    config: Config,
  ): Record<
    string,
    (args: Record<string, unknown>, options: RequestOptions) => Promise<unknown>
  > => ({
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
    create_project: (args, options) =>
      createProject(
        config,
        { name: args.name, workingDirectory: args.working_directory },
        options,
      ),
    create_agent: (args, options) =>
      createAgent(
        config,
        {
          name: args.name,
          projectId: args.project_id,
          workspaceSubpath: args.workspace_subpath,
          model: args.model,
        },
        options,
      ),
    create_template: (args, options) =>
      createTemplate(config, { name: args.name, content: args.content }, options),
    update_template: (args, options) =>
      updateTemplate(
        config,
        { templateId: args.template_id, name: args.name, content: args.content },
        options,
      ),
    apply_role: (args, options) =>
      applyRole(config, { agentId: args.agent_id, templateId: args.template_id }, options),
    create_connection: (args, options) =>
      createConnection(config, { from: args.from, to: args.to }, options),
    send_message: (args, options) =>
      sendMessage(config, { agentId: args.agent_id, message: args.message }, options),
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const handler = buildHandlers(resolveConfig())[request.params.name];
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
  // `loadConfig` itself is the resolver: it reads process.env on each call, so a
  // config written after this process started is still seen.
  const server = createServer(() => loadConfig());
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

/**
 * Plugin runtime entry.
 *
 * This plugin registers no tools here on purpose. Its surface is the stdio MCP
 * server declared in `openclaw.plugin.json` under `mcpServers.singleintent`,
 * which OpenClaw merges into the `bundle-mcp` namespace that the default
 * `coding` and `messaging` tool profiles already admit. Registering tools
 * through `api.registerTool` instead would scope them under this plugin id and
 * oblige every consumer to hand-edit `tools.alsoAllow`, which an install cannot
 * write for itself.
 *
 * The entry exists because `openclaw.extensions` is mandatory: a manifest-only
 * plugin is rejected at install with "package.json missing openclaw.extensions",
 * even when every tool comes from a manifest-declared MCP server.
 *
 * What it does register is one `before_tool_call` hook, because the MCP child
 * cannot tell which agent is calling it and the work-item write tools must send
 * that agent's own token. The hook is the one place that knows: it stamps the
 * Gateway's `ctx.agentId` and engine state dir onto those tools' arguments, and the
 * child reads them back out (src/workitem-token.ts). Measured on claude-cli: the
 * returned params reach the child even though no inputSchema declares them, which
 * is why they are not declared — a declared argument is one the model is invited
 * to fill in.
 */
import { dirname } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfigPath } from "openclaw/plugin-sdk/state-paths";
import {
  ACTING_AGENT_ID,
  ACTING_ENGINE_STATE_DIR,
  WORKITEM_WRITE_TOOLS,
} from "./workitem-token.js";

/**
 * The verb behind a SingleIntent tool name. claude-cli relays
 * `mcp__singleintent__<verb>`; the embedded runtime uses `singleintent__<verb>`.
 */
export function singleIntentVerb(toolName: string): string | undefined {
  return /^(?:mcp__)?singleintent__(.+)$/.exec(toolName)?.[1];
}

type HookEvent = { toolName: string; params: Record<string, unknown> };
type HookContext = { agentId?: string };
type HookResult =
  | { params: Record<string, unknown> }
  | { block: true; blockReason: string }
  | undefined;

/**
 * The hook body, separate from registration so it can be tested without a Gateway.
 *
 * The stamped values always overwrite whatever the model sent. An agent that
 * could choose `actingAgentId` could choose whose token is used, and the whole
 * point of per-agent tokens is that it cannot.
 */
export function stampActingAgent(
  event: HookEvent,
  ctx: HookContext,
  resolveEngineStateDir: () => string,
): HookResult {
  const verb = singleIntentVerb(event.toolName);
  if (verb === undefined || !WORKITEM_WRITE_TOOLS.has(verb)) return undefined;
  if (!ctx.agentId) {
    return {
      block: true,
      blockReason:
        "SingleIntent work-item writes are attributed to the calling agent, and " +
        "OpenClaw did not identify one for this call.",
    };
  }
  return {
    params: {
      ...event.params,
      [ACTING_AGENT_ID]: ctx.agentId,
      [ACTING_ENGINE_STATE_DIR]: resolveEngineStateDir(),
    },
  };
}

export default definePluginEntry({
  // Must equal the manifest `id`.
  id: "singleintent",
  name: "SingleIntent",
  description: "SingleIntent MCP server for OpenClaw.",
  register(api) {
    // register() runs several times per Gateway start. Should hook copies stack,
    // the stamp is idempotent: every copy writes the same two values.
    // The engine state dir is the directory holding the Gateway's openclaw.json,
    // which is where the product provisions the tokens.
    api.on("before_tool_call", (event, ctx) =>
      stampActingAgent(event, ctx, () => dirname(resolveConfigPath())),
    );
  },
});

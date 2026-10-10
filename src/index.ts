/**
 * SPIKE (spike/acting-agent-hook): not production code.
 *
 * Registers a before_tool_call hook that stamps `actingAgentId: ctx.agentId`
 * onto SingleIntent write-tool params, overwriting any model-supplied value,
 * and logs every hook invocation to `<plugin root>/.spike/hook-calls.jsonl`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = process.env.SI_SPIKE_HOOK_LOG ?? "/tmp/si-spike-acting/hook-calls.jsonl"; void PLUGIN_ROOT;
const WRITE_TOOLS = new Set(["create_workitem", "workitem_set_state"]);

function log(entry: Record<string, unknown>): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
}

/** claude-cli relays `mcp__singleintent__<verb>`; the embedded runtime uses `singleintent__<verb>`. */
function singleIntentVerb(toolName: string): string | undefined {
  return /^(?:mcp__)?singleintent__(.+)$/.exec(toolName)?.[1];
}

export default definePluginEntry({
  // Must equal the manifest `id`.
  id: "singleintent",
  name: "SingleIntent",
  description: "SingleIntent MCP server for OpenClaw.",
  register(api) {
    log({ phase: "register", pluginRoot: PLUGIN_ROOT });
    api.on("before_tool_call", (event, ctx) => {
      const verb = singleIntentVerb(event.toolName);
      log({
        phase: "before_tool_call",
        toolName: event.toolName,
        ctxAgentId: ctx.agentId ?? null,
        sessionKey: ctx.sessionKey ?? null,
        modelParams: event.params,
      });
      if (verb === undefined || !WRITE_TOOLS.has(verb)) return;
      if (!ctx.agentId) {
        return { block: true, blockReason: "SingleIntent writes require a calling agent." };
      }
      return { params: { ...event.params, actingAgentId: ctx.agentId } };
    });
  },
});

/**
 * Plugin runtime entry.
 *
 * This plugin registers no tools here on purpose. Its surface is the stdio MCP
 * server declared in `openclaw.plugin.json` under `mcpServers.singleinstinct`,
 * which OpenClaw merges into the `bundle-mcp` namespace that the default
 * `coding` and `messaging` tool profiles already admit. Registering tools
 * through `api.registerTool` instead would scope them under this plugin id and
 * oblige every consumer to hand-edit `tools.alsoAllow`, which an install cannot
 * write for itself.
 *
 * The entry exists because `openclaw.extensions` is mandatory: a manifest-only
 * plugin is rejected at install with "package.json missing openclaw.extensions",
 * even when every tool comes from a manifest-declared MCP server.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  // Must equal the manifest `id`.
  id: "singleinstinct",
  name: "SingleInstinct",
  description: "SingleInstinct MCP server for OpenClaw.",
  register() {
    // Intentionally empty; see the module comment.
  },
});

# Spike 001: before_tool_call stamps the calling agent on SingleIntent MCP writes

Throwaway. Do not merge. Date: 2026-10-10.

## Setup

- OpenClaw 2026.9.8 (fc23bc8), Claude Code 2.1.296, runtime `claude-cli`, model `claude-cli/claude-opus-5-5`.
- Isolated profile `si-spike-acting` (no Gateway; turns via `openclaw --profile si-spike-acting agent --local`).
- Plugin installed from npm (`plugins install @singleintent/openclaw-mcp-plugin@0.1.3 --force --accept-capabilities`)
  so the trust state matches si (`reason=provenance-invalid`, `installSource="npm"`). The spike's `dist/index.js`,
  `dist/mcp-server.js`, and `openclaw.plugin.json` were then copied over that install path; trust is path/record-based,
  so it stayed `provenance-invalid` (see `evidence/plugins-inspect.txt`).
- `instance.json` pointed at `127.0.0.1:9` so no product server was contacted.
- Agents `spike-alpha` and `spike-beta`, both `claude-cli/claude-opus-5-5`.

## What changed in this branch

- `src/index.ts`: `api.on("before_tool_call")` logs every call and, for `create_workitem` / `workitem_set_state`,
  returns `params: { ...event.params, actingAgentId: ctx.agentId }`.
- `src/mcp-server.ts`: logs the raw `tools/call` arguments to `$SINGLEINTENT_SPIKE_LOG`; `workitem_set_state`
  declares `actingAgentId`, `create_workitem` does not (it keeps `additionalProperties: false`).

## Evidence

- `evidence/hook-calls.jsonl`: hook saw `toolName: "mcp__singleintent__<verb>"`, `ctxAgentId` equal to the calling
  agent, and the model's forged `actingAgentId` (`FORGED-declared` / `FORGED-undeclared`).
- `evidence/mcp-calls.jsonl`: the MCP child received `actingAgentId` equal to `spike-alpha` / `spike-beta`
  for both the declared and undeclared tool.
- `evidence/run-read-other-token.txt`: `spike-beta` read a dummy file at
  `<state>/singleintent/workitem-tokens/spike-alpha` with both native Read and Bash.

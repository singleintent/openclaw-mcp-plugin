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
 * It registers `before_tool_call` for call tickets and policy observation, plus
 * `after_tool_call` for correlated execution/transport observations. The MCP child
 * cannot tell which agent is calling it and the write tools must send
 * that agent's own token. The hook is the one place that knows: it writes a call
 * ticket naming the Gateway's `ctx.agentId` and engine state dir, and the child
 * claims it (src/call-ticket.ts). On runtime-native MCP clients (claude-cli,
 * Codex) the ticket is keyed by the tool call id the client also sends in
 * `_meta`, and the call's arguments are left untouched, because Codex's relay
 * refuses any rewrite. On OpenClaw's own MCP client, which sends no `_meta`, the
 * hook adds one undeclared `ticketId` argument. Measured on 2026.9.8: undeclared
 * hook-added arguments reach the child; they are not declared because a declared
 * argument is one the model is invited to fill in.
 */
import { dirname } from "node:path";
import { actionPolicyConfig, createActionPolicyObserver } from "./action-policy-observer.js";
import { createActionAudit } from "./action-policy-audit.js";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfigPath } from "openclaw/plugin-sdk/state-paths";
import {
  argsDigest,
  defaultTicketsDir,
  newNonce,
  TICKET_ID_ARG,
  TICKET_TTL_MS,
  writeTicket,
} from "./call-ticket.js";
import {
  actingKeys,
  originKeys,
  TICKETED_WRITE_TOOLS,
  WorkitemCredentialError,
} from "./workitem-token.js";

/**
 * The verb behind a SingleIntent tool name. claude-cli and Codex relay
 * `mcp__singleintent__<verb>`; the embedded runtime uses `singleintent__<verb>`.
 */
export function singleIntentVerb(toolName: string): string | undefined {
  return /^(?:mcp__)?singleintent__(.+)$/.exec(toolName)?.[1];
}

type HookEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
};
type HookContext = { agentId?: string; sessionKey?: string; runId?: string };
type HookResult =
  | { params: Record<string, unknown> }
  | { block: true; blockReason: string }
  | undefined;

/** Why the hook blocked a write. Each appears in the block reason as `[code]`. */
export type HookBlockCode =
  | "no-agent-id"
  | "acting-args-refused"
  | "origin-args-refused"
  | "model-ticket-id"
  | "no-tool-call-id"
  | "call-ticket-conflict"
  | "call-key-reused"
  | "call-ticket-dir-unsafe"
  | "call-ticket-write-failed";

const block = (code: HookBlockCode, reason: string): HookResult => ({
  block: true,
  blockReason: `SingleIntent write blocked [${code}]: ${reason}`,
});

export type TicketDeps = {
  engineStateDir: () => string;
  ticketsDir: () => string;
  now: () => number;
  nonce: () => string;
};

/**
 * `rootDir` is the install root the Gateway reports for this plugin. It must
 * come from the Gateway, not from this module's path: OpenClaw runs plugin code
 * from a capture copy, and a ticket written there is one the server never finds.
 */
export const ticketDepsFor = (rootDir: string | undefined): TicketDeps => ({
  // The engine state dir is the directory holding the Gateway's openclaw.json,
  // which is where the product provisions the tokens.
  engineStateDir: () => dirname(resolveConfigPath()),
  ticketsDir: () => defaultTicketsDir(rootDir),
  now: Date.now,
  nonce: newNonce,
});

export const defaultTicketDeps: TicketDeps = ticketDepsFor(undefined);

/**
 * The hook body, separate from registration so it can be tested without a Gateway.
 *
 * Nothing the model sends is identity or origin. A call that carries the retired
 * `acting*` stamps, an `origin`/`sessionKey`/`runId`, or a `ticketId` of its own
 * is blocked rather than cleaned:
 * either can only come from the model or a stale plugin copy, and the write it
 * asks for is not one to make quietly under a different name.
 */
export function issueCallTicket(
  event: HookEvent,
  ctx: HookContext,
  deps: TicketDeps = defaultTicketDeps,
): HookResult {
  // On the embedded `tool_call` wrapper this is undefined for the outer call;
  // only the inner `singleintent__<verb>` call gets a ticket.
  const verb = singleIntentVerb(event.toolName);
  if (verb === undefined || !TICKETED_WRITE_TOOLS.has(verb)) return undefined;
  if (!ctx.agentId) {
    return block(
      "no-agent-id",
      "writes are attributed to the calling agent, and OpenClaw did not identify one for this call.",
    );
  }
  const acting = actingKeys(event.params);
  if (acting.length > 0) {
    return block(
      "acting-args-refused",
      `the call carries ${acting.join(", ")}. Identity comes from OpenClaw, never from tool arguments.`,
    );
  }
  // The origin (SCRUM-148) is the ctx's session and run, recorded in the ticket
  // below; the model naming one would be naming a session it may not be in.
  const origin = originKeys(event.params);
  if (origin.length > 0) {
    return block(
      "origin-args-refused",
      `the call carries ${origin.join(", ")}. The write's origin comes from OpenClaw's session, never from tool arguments.`,
    );
  }
  if (TICKET_ID_ARG in event.params) {
    return block(
      "model-ticket-id",
      `the call carries its own ${TICKET_ID_ARG}. Only this hook issues tickets.`,
    );
  }
  // Native clients (claude-cli, Codex) send the tool call id to the server in
  // `_meta`; OpenClaw's own client sends nothing, so it gets a nonce argument.
  const native = event.toolName.startsWith("mcp__");
  let key: string;
  if (native) {
    if (!event.toolCallId) {
      return block(
        "no-tool-call-id",
        "OpenClaw supplied no tool call id, and without one the server cannot find this call's ticket.",
      );
    }
    key = event.toolCallId;
  } else {
    key = deps.nonce();
  }
  const now = deps.now();
  let written;
  try {
    written = writeTicket(
      deps.ticketsDir(),
      key,
      {
        agentId: ctx.agentId,
        engineStateDir: deps.engineStateDir(),
        sessionKey: ctx.sessionKey ?? null,
        runId: ctx.runId ?? event.runId ?? null,
        verb,
        argsDigest: argsDigest(event.params),
        expiresAt: now + TICKET_TTL_MS,
      },
      now,
    );
  } catch (error) {
    if (error instanceof WorkitemCredentialError && error.code === "call-ticket-dir-unsafe") {
      // The message without WorkitemCredentialError's "refused locally [code]: " prefix.
      return block("call-ticket-dir-unsafe", error.message.slice(error.message.indexOf("]: ") + 3));
    }
    return block(
      "call-ticket-write-failed",
      `the call ticket could not be written (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!written.ok) {
    return written.reason === "key-used"
      ? block("call-key-reused", "this tool call id already authorised a write; it cannot authorise another.")
      : block("call-ticket-conflict", "a different call ticket already exists for this tool call id.");
  }
  // Native: no rewrite. Codex's relay refuses any change to the params.
  return native ? undefined : { params: { ...event.params, [TICKET_ID_ARG]: key } };
}

export default definePluginEntry({
  // Must equal the manifest `id`.
  id: "singleintent",
  name: "SingleIntent",
  description: "SingleIntent MCP server for OpenClaw.",
  register(api) {
    // register() runs several times per Gateway start. Should hook copies stack,
    // each sees the original params (the host isolates them per handler): on a
    // native call the second copy finds an identical ticket and succeeds; on an
    // embedded call each writes its own nonce ticket, the last one's params win,
    // and the unused ticket expires and is swept.
    const deps = ticketDepsFor(api.rootDir);
    let audit;
    try { audit = createActionAudit(deps.engineStateDir()); }
    catch { api.logger?.warn("SCRUM-201 local action audit unavailable; evidence incomplete"); }
    const observer = createActionPolicyObserver(actionPolicyConfig(), api.logger, audit);
    api.on("before_tool_call", async (event, ctx) => {
      const ticket = issueCallTicket(event, ctx, deps);
      await observer.before(event, ctx);
      return ticket;
    });
    api.on("after_tool_call", (event, ctx) => observer.after(event, ctx));
  },
});

/**
 * Per-agent credentials for work-item writes.
 *
 * The product attributes every work-item event to the agent whose bearer token
 * it was sent with; request JSON cannot choose the actor. So the token, not any
 * argument, is the identity, and sending the wrong agent's token is not a lesser
 * failure than sending none — it is a write recorded against someone else. That
 * is why everything here fails closed and nothing falls back to the instance
 * token from config.ts: that token belongs to no agent in particular, and a
 * fallback would turn "this agent has no credential" into "this agent wrote as
 * whoever the instance token maps to".
 *
 * Which agent is calling is not something this process can know. The MCP child
 * is shared and is told nothing about its caller, so the plugin's
 * `before_tool_call` hook (src/index.ts) writes a call ticket naming the agent
 * and the engine state dir, and this process claims it (src/call-ticket.ts).
 * No request field is ever identity: a request carrying `acting*` arguments,
 * the old hook stamps, is refused outright.
 *
 * The token lives at `<engine state dir>/singleintent/workitem-tokens/<agentId>`,
 * the same place the product's provisioning writes it. The engine state dir is
 * the directory holding the Gateway profile's openclaw.json, and is never
 * derived from this package's install path, which changes on every
 * `plugins update` and would take the credentials with it.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { envVar } from "./names.js";

/**
 * The write tools that go out as the calling agent, and so the only ones that
 * need a call ticket: the work-item writes, and since SCRUM-185 every other
 * write verb. One list, read by both the hook and the server, so a new write
 * verb is one edit and cannot be ticketed on one side and sent with the instance
 * token on the other.
 */
export const TICKETED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_workitem",
  "workitem_set_state",
  "workitem_estimate",
  "workitem_note",
  "send_message",
  "apply_role",
  "create_agent",
  "create_project",
  "create_template",
  "update_template",
  "create_connection",
]);

/** The pre-SCRUM-185 name of {@link TICKETED_WRITE_TOOLS}. */
export const WORKITEM_WRITE_TOOLS = TICKETED_WRITE_TOOLS;

/**
 * The ticketed writes that carry the ticket's origin (SCRUM-148). Only the
 * work-item routes have an origin contract on the product; the other ticketed
 * writes send none.
 */
export const ORIGIN_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_workitem",
  "workitem_set_state",
  "workitem_estimate",
  "workitem_note",
]);

/**
 * The prefix of the retired hook stamps (`actingAgentId`, `actingEngineStateDir`,
 * `actingSessionKey`, `actingRunId`). A request carrying any key with it is
 * refused, by the hook and by the server: such a key can only come from the
 * model or from a stale plugin copy, and neither may name an identity.
 */
export const ACTING_PREFIX = "acting";

export const actingKeys = (args: Record<string, unknown>): string[] =>
  Object.keys(args).filter((key) => key.startsWith(ACTING_PREFIX));

/**
 * Argument names that would let the model name the write's origin (SCRUM-148).
 * The origin is the calling session and run, and comes only from the call
 * ticket; no write verb declares any of these, so a request carrying one is
 * refused, by the hook and by the server, rather than silently dropped.
 */
export const ORIGIN_ARGS: readonly string[] = ["origin", "sessionKey", "runId"];

export const originKeys = (args: Record<string, unknown>): string[] =>
  ORIGIN_ARGS.filter((key) => key in args);

/** Where a write came from, as sent in the body's `origin` (SCRUM-148). */
export type WriteOrigin = { sessionKey: string; runId?: string };

/**
 * The write origin from a claimed call ticket, or undefined when it has none.
 *
 * The ticket's session key and run id are the Gateway ctx's, written by the
 * hook. No session key means no origin at all, even with a run id: a run without
 * its session cannot be checked against the agent, and a guessed origin is worse
 * than none. An empty run id is omitted.
 *
 * The product refuses an origin whose session key is not the writing agent's
 * (`agent:<principal>:…`, 400 origin-session-mismatch). The principal is the
 * ticket's agent, so a session key outside `agent:<agentId>:` is left out rather
 * than sent: the write keeps its actor and only loses the link.
 */
export function ticketOrigin(ticket: {
  agentId: string;
  sessionKey: string | null;
  runId: string | null;
}): WriteOrigin | undefined {
  const { agentId, sessionKey, runId } = ticket;
  if (typeof sessionKey !== "string" || sessionKey === "") return undefined;
  if (!sessionKey.startsWith(`agent:${agentId}:`)) return undefined;
  return typeof runId === "string" && runId !== "" ? { sessionKey, runId } : { sessionKey };
}

/** Path segments under the state dir, matching the product's provisioning. */
const TOKEN_DIR_SEGMENTS = ["singleintent", "workitem-tokens"] as const;

/**
 * Why the plugin refused a ticketed write before sending anything. Each names
 * a different cause, so each has its own code.
 *
 *  - `acting-args-refused`: the request carried `acting*` arguments.
 *  - `origin-args-refused`: the request carried `origin`, `sessionKey` or
 *    `runId`; the origin comes from the call ticket only (SCRUM-148).
 *  - `no-call-key`: no `_meta` call id and no `ticketId`, or an unusable one.
 *  - `multiple-call-keys`: more than one of those was present.
 *  - `no-call-ticket`: no ticket exists for the key (the hook did not run).
 *  - `call-ticket-replayed`: the ticket for the key was already claimed.
 *  - `call-ticket-malformed`: the ticket is not a valid v1 ticket for the key.
 *  - `call-ticket-expired`: the ticket outlived its TTL before the request.
 *  - `call-ticket-verb-mismatch`: the ticket was issued for another verb.
 *  - `call-ticket-digest-mismatch`: the arguments differ from the ticketed ones.
 *  - `call-ticket-dir-unsafe`: the tickets directory is a symlink, not a
 *    directory, owned by another user, or open to group or other.
 *  - `call-ticket-claim-failed`: the claim marker could not be written.
 *  - `unsafe-agent-id`: the ticket's agent id is not a single path segment.
 *  - `no-engine-state-dir`: no absolute engine state directory resolved.
 *  - `no-agent-token`: the agent's token file is missing, empty or unreadable.
 */
export type WorkitemCredentialCode =
  | "acting-args-refused"
  | "origin-args-refused"
  | "no-call-key"
  | "multiple-call-keys"
  | "no-call-ticket"
  | "call-ticket-replayed"
  | "call-ticket-malformed"
  | "call-ticket-expired"
  | "call-ticket-verb-mismatch"
  | "call-ticket-digest-mismatch"
  | "call-ticket-dir-unsafe"
  | "call-ticket-claim-failed"
  | "unsafe-agent-id"
  | "no-engine-state-dir"
  | "no-agent-token";

/**
 * The plugin refused before sending anything.
 *
 * Deliberately not shaped like the product's 401: no request was made, so there
 * is no HTTP status, and a plugin-owned code keeps "the plugin had nothing to
 * send" distinguishable from "the product rejected what was sent". The agent and
 * the path are named so the fix does not start with a search.
 */
export class WorkitemCredentialError extends Error {
  constructor(
    readonly code: WorkitemCredentialCode,
    reason: string,
    readonly agentId: string | undefined,
    readonly path: string | undefined,
  ) {
    super(`write refused locally [${code}]: ${reason}`);
    this.name = "WorkitemCredentialError";
  }
}

/**
 * Where token files live, highest precedence first:
 *
 *  1. $SINGLEINTENT_WORKITEM_PRINCIPALS_FILE — the product's override for its
 *     hashed map. The tokens sit beside it, so the plugin follows it the same
 *     way the product does, `resolve()` included, or a relative override would
 *     point the two sides at different directories.
 *  2. the engine state dir in the call ticket: `dirname(resolveConfigPath())`,
 *     the Gateway's own answer, written by the hook.
 *  3. dirname($OPENCLAW_CONFIG_PATH), for a ticket whose dir is unusable, in a
 *     child that was handed the variable. The same definition as (2), so the
 *     two cannot disagree about which profile's directory holds the tokens.
 *
 * Nothing else: no state-dir environment override, which can name a different
 * directory than the one holding openclaw.json. A guess from cwd or the install path would sometimes be right,
 * and a credential lookup that is sometimes right is the failure this replaces.
 */
export function resolveTokenDir(
  engineStateDir: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const principals = env[envVar("WORKITEM_PRINCIPALS_FILE")];
  if (principals !== undefined && principals !== "") {
    return join(dirname(resolve(principals)), ...TOKEN_DIR_SEGMENTS);
  }
  // Absolute only: a relative dir would be resolved against this process's cwd,
  // which is whatever the Gateway happened to launch it in.
  if (typeof engineStateDir === "string" && isAbsolute(engineStateDir)) {
    return join(engineStateDir, ...TOKEN_DIR_SEGMENTS);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath !== undefined && isAbsolute(configPath)) {
    return join(dirname(configPath), ...TOKEN_DIR_SEGMENTS);
  }
  return undefined;
}

/** The agent id becomes a file name, so it has to be exactly one segment. */
function isSafeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/**
 * The bearer token for the agent a claimed ticket names.
 *
 * Read on every call, never cached: rotating or revoking a token is replacing or
 * deleting the file, and that has to take effect on the next write rather than
 * on the next restart of a process nobody restarts deliberately.
 */
export function readWorkitemToken(
  agentId: string,
  engineStateDir: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { agentId: string; token: string } {
  if (!isSafeSegment(agentId)) {
    throw new WorkitemCredentialError(
      "unsafe-agent-id",
      `agent id ${JSON.stringify(agentId)} is not a single safe path segment.`,
      agentId,
      undefined,
    );
  }
  const dir = resolveTokenDir(engineStateDir, env);
  if (dir === undefined) {
    throw new WorkitemCredentialError(
      "no-engine-state-dir",
      `cannot locate the token for agent ${agentId}: no absolute engine state ` +
        `directory was supplied by the call ticket, by ` +
        `SINGLEINTENT_WORKITEM_PRINCIPALS_FILE, or by OPENCLAW_CONFIG_PATH, so ` +
        `<engine state dir>/${TOKEN_DIR_SEGMENTS.join("/")}/${agentId} cannot be resolved.`,
      agentId,
      undefined,
    );
  }
  const path = join(dir, agentId);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "does not exist" : `cannot be read (${String(error)})`;
    throw new WorkitemCredentialError(
      "no-agent-token",
      `no SingleIntent token for agent ${agentId}: ${path} ${why}. Provision that ` +
        `agent's token from the product.`,
      agentId,
      path,
    );
  }
  const token = contents.trim();
  if (token === "") {
    throw new WorkitemCredentialError(
      "no-agent-token",
      `no SingleIntent token for agent ${agentId}: ${path} is empty. Provision that ` +
        `agent's token from the product.`,
      agentId,
      path,
    );
  }
  return { agentId, token };
}

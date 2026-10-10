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
 * `before_tool_call` hook (src/index.ts) stamps `actingAgentId` and
 * `actingEngineStateDir` onto the arguments of exactly these tools. They are
 * stripped here before the request is built and never reach the product.
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
 * The tools that write work items, and so the only ones that need an acting
 * agent. One list, read by both the hook and the server, so a new write verb is
 * one edit and cannot be stamped on one side and sent with the instance token on the other.
 */
export const WORKITEM_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_workitem",
  "workitem_set_state",
  "workitem_estimate",
]);

/** Argument names the hook adds. Public only between the hook and this module. */
export const ACTING_AGENT_ID = "actingAgentId";
export const ACTING_ENGINE_STATE_DIR = "actingEngineStateDir";

/** Path segments under the state dir, matching the product's provisioning. */
const TOKEN_DIR_SEGMENTS = ["singleintent", "workitem-tokens"] as const;

/**
 * Why the plugin refused a work-item write before sending anything. Each names
 * a different missing piece, so each has its own code.
 *
 *  - `no-acting-agent`: the hook supplied no agent id (it did not run).
 *  - `unsafe-agent-id`: the agent id is not a single path segment.
 *  - `no-engine-state-dir`: no absolute engine state directory resolved.
 *  - `no-agent-token`: the agent's token file is missing, empty or unreadable.
 */
export type WorkitemCredentialCode =
  | "no-acting-agent"
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
    super(`work-item write refused locally [${code}]: ${reason}`);
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
 *  2. the engine state dir the hook stamped: `dirname(resolveConfigPath())`,
 *     the Gateway's own answer.
 *  3. dirname($OPENCLAW_CONFIG_PATH), for a child that was handed it but called
 *     without the hook having run. The same definition as (2), so the two
 *     cannot disagree about which profile's directory holds the tokens.
 *
 * Nothing else: no state-dir environment override, which can name a different
 * directory than the one holding openclaw.json. A guess from cwd or the install path would sometimes be right,
 * and a credential lookup that is sometimes right is the failure this replaces.
 */
export function resolveTokenDir(
  actingEngineStateDir: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const principals = env[envVar("WORKITEM_PRINCIPALS_FILE")];
  if (principals !== undefined && principals !== "") {
    return join(dirname(resolve(principals)), ...TOKEN_DIR_SEGMENTS);
  }
  // Absolute only: a relative dir would be resolved against this process's cwd,
  // which is whatever the Gateway happened to launch it in.
  if (typeof actingEngineStateDir === "string" && isAbsolute(actingEngineStateDir)) {
    return join(actingEngineStateDir, ...TOKEN_DIR_SEGMENTS);
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
 * The bearer token for the agent the hook named.
 *
 * Read on every call, never cached: rotating or revoking a token is replacing or
 * deleting the file, and that has to take effect on the next write rather than
 * on the next restart of a process nobody restarts deliberately.
 */
export function readWorkitemToken(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { agentId: string; token: string } {
  const rawAgent = args[ACTING_AGENT_ID];
  if (typeof rawAgent !== "string" || rawAgent === "") {
    throw new WorkitemCredentialError(
      "no-acting-agent",
      "no acting agent was supplied. The SingleIntent plugin's before_tool_call " +
        "hook names the calling agent; on a runtime where that hook did not run, " +
        "work-item writes cannot be attributed and are refused.",
      undefined,
      undefined,
    );
  }
  if (!isSafeSegment(rawAgent)) {
    throw new WorkitemCredentialError(
      "unsafe-agent-id",
      `acting agent id ${JSON.stringify(rawAgent)} is not a single safe path segment.`,
      rawAgent,
      undefined,
    );
  }
  const dir = resolveTokenDir(args[ACTING_ENGINE_STATE_DIR], env);
  if (dir === undefined) {
    throw new WorkitemCredentialError(
      "no-engine-state-dir",
      `cannot locate the token for agent ${rawAgent}: no absolute engine state ` +
        `directory was supplied by the hook (actingEngineStateDir), by ` +
        `SINGLEINTENT_WORKITEM_PRINCIPALS_FILE, or by OPENCLAW_CONFIG_PATH, so ` +
        `<engine state dir>/${TOKEN_DIR_SEGMENTS.join("/")}/${rawAgent} cannot be resolved.`,
      rawAgent,
      undefined,
    );
  }
  const path = join(dir, rawAgent);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "does not exist" : `cannot be read (${String(error)})`;
    throw new WorkitemCredentialError(
      "no-agent-token",
      `no work-item token for agent ${rawAgent}: ${path} ${why}. Provision that ` +
        `agent's token from the product.`,
      rawAgent,
      path,
    );
  }
  const token = contents.trim();
  if (token === "") {
    throw new WorkitemCredentialError(
      "no-agent-token",
      `no work-item token for agent ${rawAgent}: ${path} is empty. Provision that ` +
        `agent's token from the product.`,
      rawAgent,
      path,
    );
  }
  return { agentId: rawAgent, token };
}

/** The arguments with the hook's stamps removed, so they cannot reach the product. */
export function withoutActingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { [ACTING_AGENT_ID]: _agent, [ACTING_ENGINE_STATE_DIR]: _dir, ...rest } = args;
  return rest;
}

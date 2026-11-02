/** SCRUM-201: bounded, observe-only Gateway action-policy adapter. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AuditRow, AuditSink } from "./action-policy-audit.js";

type ToolEvent = { toolName: string; params: Record<string, unknown>; toolCallId?: string; runId?: string; result?: unknown; error?: string };
type ToolContext = { agentId?: string; sessionKey?: string; runId?: string; toolCallId?: string; toolKind?: string };
type Decision = { decisionId: string; mode: string; disposition: string; policyVersion: string };
type Config = { url: string; token: string; projectId?: string; adapterVersion: string; timeoutMs: number };
type Logger = { warn: (message: string) => void };
type Base = Pick<AuditRow, "action" | "route" | "hostAttemptId" | "actorId" | "targetDigest">;
type Pending = { base: Base; decision?: Decision };

const actionFor = (name: string): "send_message" | "spawn_session" | undefined => {
  if (/^(?:openclaw__)?sessions_send$/.test(name)) return "send_message";
  if (/^(?:openclaw__)?sessions_spawn$/.test(name)) return "spawn_session";
  return undefined;
};
const bounded = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value) ? value : undefined;
const destination = (params: Record<string, unknown>, action: string): string =>
  bounded(params.sessionKey) ?? bounded(params.agentId) ?? bounded(params.target) ?? (action === "spawn_session" ? "subagent" : "unspecified");
const keyFor = (event: ToolEvent, ctx: ToolContext): string | undefined => {
  const id = ctx.toolCallId ?? event.toolCallId;
  return id ? `${ctx.sessionKey ?? ""}:${ctx.runId ?? event.runId ?? ""}:${id}:${event.toolName}` : undefined;
};

/** Resolve the product-owned credential beside the Gateway profile, never the plugin install. */
export function actionPolicyCredentialPath(engineStateDir: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stateDir = typeof engineStateDir === "string" && isAbsolute(engineStateDir)
    ? engineStateDir : undefined;
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  const fallback = configPath && isAbsolute(configPath) ? dirname(configPath) : undefined;
  return stateDir || fallback ? join((stateDir || fallback)!, "singleintent", "action-adapter.json") : undefined;
}

/** A fresh, checked read for each decision/observation report. No credential is cached. */
export function actionPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
  engineStateDir?: unknown,
  logger?: Logger,
): Config | undefined {
  const unavailable = (reason: string): undefined => {
    logger?.warn(`SCRUM-220 action adapter credential ${reason}; local audit only`);
    return undefined;
  };
  const path = actionPolicyCredentialPath(engineStateDir, env);
  if (!path) return unavailable("path unavailable");
  let contents: string;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return unavailable("missing or unreadable"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) ||
        (stat.mode & 0o077) !== 0 || stat.size > 4096) return unavailable("unsafe file");
    contents = readFileSync(fd, "utf8");
  } catch { return unavailable("unreadable"); }
  finally { closeSync(fd); }
  let credential: unknown;
  try { credential = JSON.parse(contents); }
  catch { return unavailable("invalid JSON"); }
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return unavailable("invalid contents");
  const { url, token } = credential as Record<string, unknown>;
  if (typeof url !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(url) ||
      Number(url.slice(url.lastIndexOf(":") + 1)) < 1 || Number(url.slice(url.lastIndexOf(":") + 1)) > 65535) {
    return unavailable("invalid loopback URL");
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return unavailable("invalid token");
  const projectId = env.SINGLEINTENT_ACTION_POLICY_PROJECT_ID;
  if (projectId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    return unavailable("invalid project ID");
  }
  return { url, token, ...(projectId ? { projectId } : {}), adapterVersion: "scrum-201-observe-v1", timeoutMs: 450 };
}

async function post(path: string, body: unknown, config: Config): Promise<unknown> {
  const response = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Never blocks or rewrites the tool; local audit failures remain operator-visible. */
export function createActionPolicyObserver(configSource: Config | undefined | (() => Config | undefined), logger: Logger, audit?: AuditSink) {
  const currentConfig = (): Config | undefined => typeof configSource === "function" ? configSource() : configSource;
  const decisions = new Map<string, Pending>();
  const codeModeRuns = new Map<string, number>();
  const record = (row: AuditRow): void => {
    try { audit?.(row); }
    catch { logger.warn("SCRUM-201 local action audit write failed; evidence incomplete"); }
  };
  const before = async (event: ToolEvent, ctx: ToolContext): Promise<void> => {
    if (ctx.toolKind === "code_mode_exec" && ctx.runId) {
      codeModeRuns.set(ctx.runId, (codeModeRuns.get(ctx.runId) ?? 0) + 1);
      return;
    }
    const action = actionFor(event.toolName);
    if (!action) return;
    const route = ctx.runId && codeModeRuns.has(ctx.runId) ? "code_mode" : "assembled";
    const callId = ctx.toolCallId ?? event.toolCallId;
    const attemptId = callId
      ? createHash("sha256").update(JSON.stringify([ctx.sessionKey ?? null, ctx.runId ?? event.runId ?? null, callId])).digest("hex")
      : randomUUID();
    const target = destination(event.params, action);
    const base: Base = { action, route, hostAttemptId: attemptId,
      actorId: bounded(ctx.agentId) ?? null, targetDigest: createHash("sha256").update(target).digest("hex") };
    const key = keyFor(event, ctx);
    if (key) decisions.set(key, { base });
    const started = performance.now();
    const config = currentConfig();
    if (!config) {
      record({ v: 1, at: new Date().toISOString(), kind: "decision", ...base,
        disposition: "indeterminate", outcome: "unavailable", reasonCode: "unconfigured", latencyMs: 0 });
      logger.warn("SCRUM-201 observe adapter unconfigured; local indeterminate audit only");
      return;
    }
    const body = { route, action, actorId: base.actorId, target,
      hostAttemptId: attemptId, projectId: config.projectId, adapterVersion: config.adapterVersion };
    try {
      const value = await post("/api/action-decisions", body, config) as Decision;
      if (performance.now() - started > config.timeoutMs) throw new Error("late-response");
      if (!bounded(value?.decisionId) || value.mode !== "observe" ||
          !["allow", "deny", "indeterminate"].includes(value.disposition) || !bounded(value.policyVersion)) throw new Error("malformed-response");
      record({ v: 1, at: new Date().toISOString(), kind: "decision", ...base,
        decisionId: value.decisionId, policyVersion: value.policyVersion, disposition: value.disposition,
        outcome: "received", latencyMs: Math.round(performance.now() - started) });
      if (key) decisions.set(key, { base, decision: value });
      else logger.warn(`SCRUM-201 uncorrelated ${action} attempt; decision received`);
    } catch (error) {
      const reasonCode = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" :
        error instanceof Error && error.message === "malformed-response" ? "malformed_response" :
        error instanceof Error && error.message === "late-response" ? "late_response" :
        error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? "http_error" : "unreachable";
      record({ v: 1, at: new Date().toISOString(), kind: "decision", ...base,
        disposition: "indeterminate", outcome: "unavailable", reasonCode,
        latencyMs: Math.round(performance.now() - started) });
      logger.warn(`SCRUM-201 observe decision unavailable for ${action}: ${reasonCode}`);
    }
  };
  const after = async (event: ToolEvent, ctx: ToolContext): Promise<void> => {
    if (ctx.toolKind === "code_mode_exec" && ctx.runId) {
      const count = codeModeRuns.get(ctx.runId) ?? 0;
      if (count <= 1) codeModeRuns.delete(ctx.runId);
      else codeModeRuns.set(ctx.runId, count - 1);
      return;
    }
    const action = actionFor(event.toolName);
    if (!action) return;
    const key = keyFor(event, ctx);
    const pending = key ? decisions.get(key) : undefined;
    if (!pending) {
      const target = destination(event.params, action);
      record({ v: 1, at: new Date().toISOString(), kind: "result", action,
        route: ctx.runId && codeModeRuns.has(ctx.runId) ? "code_mode" : "assembled",
        hostAttemptId: randomUUID(), actorId: bounded(ctx.agentId) ?? null,
        targetDigest: createHash("sha256").update(target).digest("hex"),
        outcome: "uncorrelated", state: event.error ? "failed" : event.result === undefined ? "unknown" : "succeeded",
        correlation: "missing" });
      logger.warn(`SCRUM-201 ${action} result uncorrelated; no execution claim recorded`);
      return;
    }
    decisions.delete(key!);
    const at = new Date().toISOString();
    const observations: Array<{ stage: string; state: string }> = [
      { stage: "execution", state: event.error ? "failed" : event.result === undefined ? "unknown" : "succeeded" },
    ];
    const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : undefined;
    if (result?.targetDisposition === "queued" || result?.targetDisposition === "steered") observations.push({ stage: "transport", state: result.targetDisposition });
    record({ v: 1, at, kind: "result", ...pending.base,
      ...(pending.decision ? { decisionId: pending.decision.decisionId, policyVersion: pending.decision.policyVersion } : {}),
      outcome: pending.decision ? "observed" : "indeterminate", state: observations[0].state,
      ...(observations[1] ? { transportState: observations[1].state } : {}), correlation: "matched" });
    if (!pending.decision) return;
    for (const observation of observations) {
      const config = currentConfig();
      if (!config) {
        record({ v: 1, at: new Date().toISOString(), kind: "observation_failure", ...pending.base,
          decisionId: pending.decision.decisionId, policyVersion: pending.decision.policyVersion,
          outcome: "unavailable", stage: observation.stage, state: observation.state, reasonCode: "unconfigured" });
        continue;
      }
      try {
        await post("/api/action-observations", {
          decisionId: pending.decision.decisionId, ...observation,
          sourceEventId: `${pending.decision.decisionId}:${observation.stage}`, observedAt: at,
        }, config);
        record({ v: 1, at: new Date().toISOString(), kind: "observation", ...pending.base,
          decisionId: pending.decision.decisionId, policyVersion: pending.decision.policyVersion,
          outcome: "accepted", stage: observation.stage, state: observation.state });
      } catch (error) {
        record({ v: 1, at: new Date().toISOString(), kind: "observation_failure", ...pending.base,
          decisionId: pending.decision.decisionId, policyVersion: pending.decision.policyVersion,
          outcome: "unavailable", stage: observation.stage, state: observation.state, reasonCode: "observation_post_failed" });
        logger.warn(`SCRUM-201 ${observation.stage} observation unavailable for ${action}: post failed`);
      }
    }
  };
  return { before, after };
}

import { afterEach, expect, it, vi } from "vitest";
import { actionPolicyConfig, createActionPolicyObserver } from "./action-policy-observer.js";

const config = {
  url: "http://127.0.0.1:5173",
  token: "a".repeat(32),
  projectId: "7ffe4bbd-42a5-471f-9b33-c75ae46f01a3",
  adapterVersion: "scrum-201-observe-v1",
  timeoutMs: 450,
};
afterEach(() => vi.unstubAllGlobals());

it("smokes observe-only send decision and separate execution/transport evidence without sending message body", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), authorization: String(new Headers(init.headers).get("authorization")) });
    return { ok: true, json: async () => ({ decisionId: "decision-1", mode: "observe", policyVersion: "scrum-201-observe-v1", disposition: "deny" }) };
  }));
  const warnings: string[] = [];
  const auditRows: unknown[] = [];
  const observer = createActionPolicyObserver(config, { warn: (message) => warnings.push(message) }, (row) => auditRows.push(row));
  const event = { toolName: "sessions_send", params: { sessionKey: "agent:peer:main", message: "private text" }, toolCallId: "call-1" };
  const ctx = { agentId: "actor", sessionKey: "agent:actor:main", runId: "run-1" };
  expect(await observer.before(event, ctx)).toBeUndefined();
  await observer.after({ ...event, result: { targetDisposition: "queued" } }, ctx);
  expect(calls.every((call) => call.authorization === `Bearer ${config.token}`)).toBe(true);
  expect(calls.map((call) => call.url)).toEqual([
    "http://127.0.0.1:5173/api/action-decisions",
    "http://127.0.0.1:5173/api/action-observations",
    "http://127.0.0.1:5173/api/action-observations",
  ]);
  expect(calls[0].body).toMatchObject({ route: "assembled", action: "send_message", actorId: "actor", target: "agent:peer:main" });
  expect(JSON.stringify(calls)).not.toContain("private text");
  expect(calls.slice(1).map((call) => [call.body.stage, call.body.state])).toEqual([["execution", "succeeded"], ["transport", "queued"]]);
  expect(auditRows).toMatchObject([
    { kind: "decision", outcome: "received", decisionId: "decision-1" },
    { kind: "result", state: "succeeded", transportState: "queued" },
    { kind: "observation", stage: "execution", outcome: "accepted" },
    { kind: "observation", stage: "transport", outcome: "accepted" },
  ]);
  expect(JSON.stringify(auditRows)).not.toContain("private text");
  expect(warnings).toEqual([]);
});

it("lets the tool continue when the policy service is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const warnings: string[] = [];
  const observer = createActionPolicyObserver(config, { warn: (message) => warnings.push(message) });
  expect(await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "call-2" }, { agentId: "actor" })).toBeUndefined();
  expect(warnings).toEqual(["SCRUM-201 observe decision unavailable for spawn_session: offline"]);
});


it("labels a nested dynamic action as code_mode only while a host-marked cell is active", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => ({ decisionId: "decision-code", mode: "observe", policyVersion: "scrum-201-observe-v1", disposition: "allow" }) };
  }));
  const observer = createActionPolicyObserver(config, { warn: () => {} });
  const ctx = { agentId: "actor", sessionKey: "agent:actor:main", runId: "run-code" };
  await observer.before({ toolName: "functions.exec", params: {}, toolCallId: "outer" }, { ...ctx, toolKind: "code_mode_exec" });
  await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "inner" }, ctx);
  await observer.after({ toolName: "functions.exec", params: {}, toolCallId: "outer" }, { ...ctx, toolKind: "code_mode_exec" });
  expect(bodies[0].route).toBe("code_mode");
});


it("accepts an isolated loopback config with a valid project UUID", () => {
  expect(actionPolicyConfig({
    SINGLEINTENT_ACTION_ADAPTER_TOKEN: "a".repeat(32),
    SINGLEINTENT_ACTION_POLICY_URL: "http://127.0.0.1:5189",
    SINGLEINTENT_ACTION_POLICY_PROJECT_ID: "3c4d0a91-69f9-445c-a19c-f354b60a61c0",
  })?.projectId).toBe("3c4d0a91-69f9-445c-a19c-f354b60a61c0");
});

it("does not forward model work-item or exception claims when no trusted project pin exists", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => ({ decisionId: "decision-unpinned", mode: "observe", policyVersion: "scrum-201-observe-v1", disposition: "deny" }) };
  }));
  const observer = createActionPolicyObserver({ ...config, projectId: undefined }, { warn: () => {} });
  await observer.before({
    toolName: "openclaw__sessions_send",
    params: { sessionKey: "agent:peer:main", message: "private", projectId: "model-project", workItemId: "model-item", exceptionClass: "incident_report" },
    toolCallId: "claim-1",
  }, { agentId: "actor" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ route: "assembled", action: "send_message", actorId: "actor" });
  expect(requests[0]).not.toHaveProperty("projectId");
  expect(requests[0]).not.toHaveProperty("workItemId");
  expect(requests[0]).not.toHaveProperty("exceptionClass");
  expect(JSON.stringify(requests)).not.toContain("private");
});

it.each([
  ["unreachable", async () => { throw new Error("offline"); }, "unreachable"],
  ["timeout", async () => { throw new DOMException("deadline", "TimeoutError"); }, "timeout"],
  ["malformed", async () => ({ ok: true, json: async () => ({ decisionId: "d", mode: "observe" }) }), "malformed_response"],
  ["http outage", async () => ({ ok: false, status: 503 }), "http_error"],
] as const)("journals %s as indeterminate and correlates the result without a backend decision", async (_label, reply, reason) => {
  const { createActionAudit } = await import("./action-policy-audit.js");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "si-action-audit-"));
  try {
    vi.stubGlobal("fetch", vi.fn(reply));
    const observer = createActionPolicyObserver(config, { warn: () => {} }, createActionAudit(dir));
    const event = { toolName: "sessions_spawn", params: { task: "private task", agentId: "peer" }, toolCallId: "call-fail" };
    const ctx = { agentId: "actor", sessionKey: "agent:actor:main", runId: "run-fail" };
    expect(await observer.before(event, ctx)).toBeUndefined();
    expect(await observer.after({ ...event, result: { targetDisposition: "queued" } }, ctx)).toBeUndefined();
    const rows = readFileSync(join(dir, "singleintent", "action-policy-audit", "events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "decision", action: "spawn_session", disposition: "indeterminate", outcome: "unavailable", reasonCode: reason, route: "assembled" });
    expect(rows[1]).toMatchObject({ kind: "result", outcome: "indeterminate", state: "succeeded", correlation: "matched" });
    expect(rows[1].hostAttemptId).toBe(rows[0].hostAttemptId);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows)).not.toContain("private task");
    expect(JSON.stringify(rows)).not.toContain(config.token);
    expect(JSON.stringify(rows)).not.toContain("peer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("journals a durable decision and failed observation without claiming delivery", async () => {
  const { createActionAudit } = await import("./action-policy-audit.js");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "si-action-audit-"));
  try {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("action-decisions")
      ? { ok: true, json: async () => ({ decisionId: "decision-durable", mode: "observe", disposition: "deny", policyVersion: "pv1" }) }
      : { ok: false, status: 503 }));
    const observer = createActionPolicyObserver(config, { warn: () => {} }, createActionAudit(dir));
    const event = { toolName: "sessions_send", params: { sessionKey: "agent:peer:main", message: "secret" }, toolCallId: "call-post" };
    const ctx = { agentId: "actor", runId: "run-post" };
    await observer.before(event, ctx);
    await observer.after({ ...event, result: { targetDisposition: "queued" } }, ctx);
    const rows = readFileSync(join(dir, "singleintent", "action-policy-audit", "events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.kind)).toEqual(["decision", "result", "observation_failure", "observation_failure"]);
    expect(rows[0]).toMatchObject({ decisionId: "decision-durable", policyVersion: "pv1", disposition: "deny", outcome: "received" });
    expect(rows[1]).toMatchObject({ state: "succeeded", transportState: "queued", outcome: "observed" });
    expect(rows.slice(2).map((row) => row.stage)).toEqual(["execution", "transport"]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(JSON.stringify(rows)).not.toContain("delivered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("stays fail-open when the local journal itself fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const warnings: string[] = [];
  const observer = createActionPolicyObserver(config, { warn: (s) => warnings.push(s) }, () => { throw new Error("disk failed"); });
  expect(await observer.before({ toolName: "sessions_send", params: {}, toolCallId: "c" }, { agentId: "a" })).toBeUndefined();
  expect(warnings).toContain("SCRUM-201 local action audit write failed; evidence incomplete");
});

it("records a missing after-hook correlation without inventing a backend decision", async () => {
  const rows: unknown[] = [];
  const observer = createActionPolicyObserver(config, { warn: () => {} }, (row) => rows.push(row));
  await observer.after({ toolName: "sessions_send", params: { sessionKey: "agent:peer:main" }, toolCallId: "orphan", result: { targetDisposition: "queued" } }, { agentId: "actor" });
  expect(rows).toMatchObject([{ kind: "result", outcome: "uncorrelated", correlation: "missing" }]);
  expect(rows[0]).not.toHaveProperty("decisionId");
});

it("records unconfigured observe attempts as indeterminate and still returns no block", async () => {
  const rows: unknown[] = [];
  const observer = createActionPolicyObserver(undefined, { warn: () => {} }, (row) => rows.push(row));
  const event = { toolName: "sessions_send", params: {}, toolCallId: "unconfigured" };
  expect(await observer.before(event, { agentId: "actor" })).toBeUndefined();
  expect(await observer.after({ ...event, error: "failed" }, { agentId: "actor" })).toBeUndefined();
  expect(rows).toMatchObject([
    { kind: "decision", disposition: "indeterminate", reasonCode: "unconfigured" },
    { kind: "result", outcome: "indeterminate", state: "failed" },
  ]);
});


it("marks a response arriving beyond the internal deadline indeterminate", async () => {
  const rows: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    return { ok: true, json: async () => ({ decisionId: "too-late", mode: "observe", disposition: "allow", policyVersion: "pv1" }) };
  }));
  const observer = createActionPolicyObserver({ ...config, timeoutMs: 1 }, { warn: () => {} }, (row) => rows.push(row));
  expect(await observer.before({ toolName: "sessions_send", params: {}, toolCallId: "late" }, { agentId: "actor" })).toBeUndefined();
  expect(rows).toMatchObject([{ kind: "decision", disposition: "indeterminate", reasonCode: "late_response" }]);
});

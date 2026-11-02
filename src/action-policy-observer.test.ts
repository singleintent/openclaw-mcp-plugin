import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionPolicyConfig, actionPolicyCredentialPath, createActionPolicyObserver } from "./action-policy-observer.js";

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

it("does not leak a bearer token from an HTTP failure into logs", async () => {
  const token = "a".repeat(32);
  const warnings: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`transport included ${token}`); }));
  const observer = createActionPolicyObserver({ ...config, token }, { warn: s => warnings.push(s) });
  await observer.before({ toolName: "sessions_send", params: {}, toolCallId: "no-leak" }, {});
  expect(warnings.join(" ")).not.toContain(token);
});

it("lets the tool continue when the policy service is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const warnings: string[] = [];
  const observer = createActionPolicyObserver(config, { warn: (message) => warnings.push(message) });
  expect(await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "call-2" }, { agentId: "actor" })).toBeUndefined();
  expect(warnings).toEqual(["SCRUM-201 observe decision unavailable for spawn_session: unreachable"]);
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


it("resolves the engine state first and OPENCLAW_CONFIG_PATH directory second", () => {
  const env = { OPENCLAW_CONFIG_PATH: "/fallback/profile/openclaw.json" };
  expect(actionPolicyCredentialPath("/gateway/profile", env)).toBe("/gateway/profile/singleintent/action-adapter.json");
  expect(actionPolicyCredentialPath(undefined, env)).toBe("/fallback/profile/singleintent/action-adapter.json");
  expect(actionPolicyCredentialPath(undefined, {})).toBeUndefined();
});

const credentialRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "si-action-credential-"));
  const dir = join(root, "singleintent");
  mkdirSync(dir, { mode: 0o700 });
  return { root, dir, file: join(dir, "action-adapter.json") };
};
const writeCredential = (file: string, url = "http://127.0.0.1:5189", token = "a".repeat(32)) =>
  writeFileSync(file, JSON.stringify({ url, token }), { mode: 0o600 });

it("reads the product-owned file and posts with its bearer token", async () => {
  const { root, file } = credentialRoot();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const token = "z".repeat(32);
  try {
    writeCredential(file, "http://127.0.0.1:5189", token);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, authorization: new Headers(init.headers).get("authorization") });
      return { ok: true, json: async () => ({ decisionId: "d1", mode: "observe", policyVersion: "pv1", disposition: "allow" }) };
    }));
    const warnings: string[] = [];
    const observer = createActionPolicyObserver(() => actionPolicyConfig({ SINGLEINTENT_ACTION_POLICY_PROJECT_ID: "3c4d0a91-69f9-445c-a19c-f354b60a61c0" }, root, { warn: s => warnings.push(s) }), { warn: s => warnings.push(s) });
    const event = { toolName: "sessions_send", params: {}, toolCallId: "file-1" };
    await observer.before(event, {});
    await observer.after({ ...event, result: {} }, {});
    expect(calls).toEqual([
      { url: "http://127.0.0.1:5189/api/action-decisions", authorization: `Bearer ${token}` },
      { url: "http://127.0.0.1:5189/api/action-observations", authorization: `Bearer ${token}` },
    ]);
    expect(warnings).toEqual([]);
    expect(actionPolicyConfig({ SINGLEINTENT_ACTION_POLICY_PROJECT_ID: "3c4d0a91-69f9-445c-a19c-f354b60a61c0" }, root)?.projectId)
      .toBe("3c4d0a91-69f9-445c-a19c-f354b60a61c0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("ignores legacy URL/token env vars when the file is absent, then picks up a file created after startup", async () => {
  const { root, file } = credentialRoot();
  const env = { SINGLEINTENT_ACTION_ADAPTER_TOKEN: "x".repeat(32), SINGLEINTENT_ACTION_POLICY_URL: "http://127.0.0.1:5173" };
  const warnings: string[] = [];
  const requests: string[] = [];
  try {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(url);
      return { ok: true, json: async () => ({ decisionId: "d1", mode: "observe", policyVersion: "pv1", disposition: "allow" }) };
    }));
    const observer = createActionPolicyObserver(() => actionPolicyConfig(env, root, { warn: s => warnings.push(s) }), { warn: s => warnings.push(s) });
    await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "missing" }, {});
    expect(requests).toEqual([]);
    writeCredential(file);
    await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "created" }, {});
    expect(requests).toEqual(["http://127.0.0.1:5189/api/action-decisions"]);
    writeCredential(file, "http://127.0.0.1:5190", "b".repeat(32));
    await observer.before({ toolName: "sessions_spawn", params: {}, toolCallId: "changed" }, {});
    expect(requests.at(-1)).toBe("http://127.0.0.1:5190/api/action-decisions");
    expect(warnings.join(" ")).not.toContain(env.SINGLEINTENT_ACTION_ADAPTER_TOKEN);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["symlink", "group-readable", "other-readable", "non-loopback", "invalid-token", "malformed-json"])(
  "refuses %s credential without a request or token in logs", async (caseName) => {
    const { root, file } = credentialRoot();
    const token = "secret".repeat(8);
    const warnings: string[] = [];
    try {
      writeCredential(file, "http://127.0.0.1:5189", token);
      if (caseName === "symlink") { rmSync(file); const target = join(root, "target.json"); writeCredential(target, "http://127.0.0.1:5189", token); symlinkSync(target, file); }
      if (caseName === "group-readable") chmodSync(file, 0o640);
      if (caseName === "other-readable") chmodSync(file, 0o604);
      if (caseName === "non-loopback") writeCredential(file, "http://example.com:5189", token);
      if (caseName === "invalid-token") writeCredential(file, "http://127.0.0.1:5189", "bad token");
      if (caseName === "malformed-json") writeFileSync(file, "{bad", { mode: 0o600 });
      const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
      const observer = createActionPolicyObserver(() => actionPolicyConfig({}, root, { warn: s => warnings.push(s) }), { warn: s => warnings.push(s) });
      await observer.before({ toolName: "sessions_send", params: {}, toolCallId: caseName }, {});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join(" ")).not.toContain(token);
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);

it("rejects a FIFO and unsafe parent directory without an HTTP request", async () => {
  const { root, dir, file } = credentialRoot();
  const warnings: string[] = [];
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    execFileSync("mkfifo", [file]);
    expect(actionPolicyConfig({}, root, { warn: s => warnings.push(s) })).toBeUndefined();
    rmSync(file);
    writeCredential(file);
    chmodSync(dir, 0o770);
    expect(actionPolicyConfig({}, root, { warn: s => warnings.push(s) })).toBeUndefined();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true });
    const target = join(root, "target-dir");
    mkdirSync(target, { mode: 0o700 });
    writeCredential(join(target, "action-adapter.json"));
    symlinkSync(target, dir);
    expect(actionPolicyConfig({}, root, { warn: s => warnings.push(s) })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("unsafe file"),
      expect.stringContaining("unsafe directory"),
    ]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("re-reads the credential between decision and observation", async () => {
  const { root, file } = credentialRoot();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const warnings: string[] = [];
  try {
    writeCredential(file, "http://127.0.0.1:5189", "a".repeat(32));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, authorization: new Headers(init.headers).get("authorization") });
      return { ok: true, json: async () => ({ decisionId: "d1", mode: "observe", policyVersion: "pv1", disposition: "allow" }) };
    }));
    const observer = createActionPolicyObserver(() => actionPolicyConfig({}, root, { warn: s => warnings.push(s) }), { warn: s => warnings.push(s) });
    const event = { toolName: "sessions_send", params: {}, toolCallId: "changed-between-hooks" };
    await observer.before(event, {});
    rmSync(file);
    writeCredential(file, "http://127.0.0.1:5190", "b".repeat(32));
    await observer.after({ ...event, result: {} }, {});
    expect(calls).toEqual([
      { url: "http://127.0.0.1:5189/api/action-decisions", authorization: `Bearer ${"a".repeat(32)}` },
      { url: "http://127.0.0.1:5190/api/action-observations", authorization: `Bearer ${"b".repeat(32)}` },
    ]);
    expect(warnings).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

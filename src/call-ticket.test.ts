import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  argsDigest,
  callKey,
  claimTicket,
  defaultTicketsDir,
  pluginRoot,
  stableStringify,
  sweepTickets,
  TICKET_TTL_MS,
  writeTicket,
} from "./call-ticket.js";
import { WorkitemCredentialError } from "./workitem-token.js";

// Real time: the sweep ages unparseable files by mtime, which is wall-clock.
const NOW = Date.now();
const ARGS = { projectId: "p", title: "T", intent: "I" };
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "si-ticket-"));
  dir = join(root, ".call-tickets");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ticket = (over: Record<string, unknown> = {}) => ({
  agentId: "alpha",
  engineStateDir: "/Users/example/.openclaw-x",
  sessionKey: "agent:alpha:main",
  runId: "run-1",
  verb: "create_workitem",
  argsDigest: argsDigest(ARGS),
  expiresAt: NOW + TICKET_TTL_MS,
  ...over,
});

const fileFor = (key: string) => join(dir, createHash("sha256").update(key).digest("hex") + ".json");

const refusal = (fn: () => unknown): WorkitemCredentialError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkitemCredentialError);
    return error as WorkitemCredentialError;
  }
  throw new Error("expected a refusal");
};

describe("stableStringify / argsDigest", () => {
  it("is independent of key order at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(argsDigest({ title: "T", projectId: "p", intent: "I" })).toBe(argsDigest(ARGS));
  });

  it("drops undefined members as JSON does, and distinguishes values", () => {
    expect(argsDigest({ ...ARGS, estimate: undefined })).toBe(argsDigest(ARGS));
    expect(argsDigest({ ...ARGS, title: "U" })).not.toBe(argsDigest(ARGS));
    expect(argsDigest({ ...ARGS, test: false })).not.toBe(argsDigest(ARGS));
  });
});

describe("ticket location", () => {
  it("lives under the plugin root, resolved from the module's own path by default", () => {
    expect(defaultTicketsDir()).toBe(join(pluginRoot(), ".call-tickets"));
    expect(existsSync(join(pluginRoot(), "package.json"))).toBe(true);
  });

  it("uses a given root as a real path, so /tmp and /private/tmp agree", () => {
    expect(defaultTicketsDir(root)).toBe(join(realpathSync(root), ".call-tickets"));
  });
});

describe("writeTicket", () => {
  it("writes 0600 in a 0700 dir under the sha256 of the key, never the key itself", () => {
    expect(writeTicket(dir, "toolu_secret", ticket(), NOW)).toEqual({ ok: true, duplicate: false });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(fileFor("toolu_secret")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([createHash("sha256").update("toolu_secret").digest("hex") + ".json"]);
    expect(JSON.parse(readFileSync(fileFor("toolu_secret"), "utf8"))).toEqual({
      v: 1,
      ...ticket(),
      keyDigest: createHash("sha256").update("toolu_secret").digest("hex"),
    });
  });

  it("treats an identical ticket under the same key as a duplicate hook copy", () => {
    writeTicket(dir, "k", ticket(), NOW);
    // A second copy computes expiresAt a moment later; that alone is not a conflict.
    expect(writeTicket(dir, "k", ticket({ expiresAt: NOW + TICKET_TTL_MS + 3 }), NOW + 3)).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it.each([
    ["agent", { agentId: "beta" }],
    ["verb", { verb: "workitem_estimate" }],
    ["arguments", { argsDigest: argsDigest({ ...ARGS, title: "X" }) }],
  ])("refuses a different %s under an existing key, leaving the first ticket", (_label, over) => {
    writeTicket(dir, "k", ticket(), NOW);
    expect(writeTicket(dir, "k", ticket(over), NOW)).toEqual({ ok: false, reason: "conflict" });
    expect(JSON.parse(readFileSync(fileFor("k"), "utf8")).agentId).toBe("alpha");
  });

  it("refuses an unparseable existing ticket as a conflict", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(fileFor("k"), "junk");
    expect(writeTicket(dir, "k", ticket(), NOW)).toEqual({ ok: false, reason: "conflict" });
  });

  it("refuses to reissue a key whose ticket was claimed", () => {
    writeTicket(dir, "k", ticket(), NOW);
    claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW);
    expect(writeTicket(dir, "k", ticket(), NOW)).toEqual({ ok: false, reason: "key-used" });
  });

  it("leaves no temp file behind", () => {
    writeTicket(dir, "k", ticket(), NOW);
    writeTicket(dir, "k", ticket({ agentId: "beta" }), NOW);
    expect(readdirSync(dir).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("refuses a tickets path that is not a directory", () => {
    writeFileSync(dir, "");
    expect(refusal(() => writeTicket(dir, "k", ticket(), NOW))).toMatchObject({
      code: "call-ticket-dir-unsafe",
      path: dir,
    });
  });
});

describe("tickets directory safety (hook and server alike)", () => {
  const usedFor = (key: string) => join(dir, createHash("sha256").update(key).digest("hex") + ".used");
  // Both sides: the hook writes, the server claims.
  const sides = [
    ["writeTicket", () => writeTicket(dir, "k", ticket(), NOW)],
    ["claimTicket", () => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)],
  ] as const;

  it.each(sides)("%s refuses a symlinked dir with call-ticket-dir-unsafe", (_side, run) => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, dir);
    const error = refusal(run);
    expect(error).toMatchObject({ code: "call-ticket-dir-unsafe", path: dir });
    expect(error.message).toContain(`${dir} is unsafe: it is a symlink`);
    expect(readdirSync(real)).toEqual([]);
  });

  it.each(sides)("%s refuses a tickets path that is not a directory", (_side, run) => {
    writeFileSync(dir, "");
    expect(refusal(run).message).toContain("it is not a directory");
  });

  it.each(sides)("%s refuses an existing dir with group or other bits", (_side, run) => {
    for (const mode of [0o750, 0o705, 0o777]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      chmodSync(dir, mode);
      const error = refusal(run);
      expect(error.code).toBe("call-ticket-dir-unsafe");
      expect(error.message).toContain(`its mode is 0${mode.toString(8)}; group and other bits must be clear`);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it.each(sides)("%s refuses an existing dir owned by another user", (_side, run) => {
    mkdirSync(dir, { mode: 0o700 });
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      const error = refusal(run);
      expect(error.code).toBe("call-ticket-dir-unsafe");
      expect(error.message).toContain(`owned by uid ${uid}, not ${uid + 1}`);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("claimTicket refuses an unsafe dir even with a valid ticket in it, and leaves the ticket", () => {
    writeTicket(dir, "k", ticket(), NOW);
    chmodSync(dir, 0o755);
    expect(refusal(sides[1][1]).code).toBe("call-ticket-dir-unsafe");
    expect(existsSync(fileFor("k"))).toBe(true);
    expect(existsSync(usedFor("k"))).toBe(false);
  });

  it("claimTicket reports a missing dir as no-call-ticket", () => {
    expect(refusal(sides[1][1]).code).toBe("no-call-ticket");
  });
});

describe("sweepTickets", () => {
  it("removes expired tickets and tombstones and keeps live ones", () => {
    writeTicket(dir, "old", ticket({ expiresAt: NOW - 1 }), NOW - TICKET_TTL_MS);
    writeTicket(dir, "live", ticket(), NOW);
    sweepTickets(dir, NOW);
    expect(existsSync(fileFor("old"))).toBe(false);
    expect(existsSync(fileFor("live"))).toBe(true);
  });

  it("runs on every write, so an orphan does not outlive the next write by more than its TTL", () => {
    writeTicket(dir, "orphan", ticket({ expiresAt: NOW + 10 }), NOW);
    writeTicket(dir, "next", ticket({ expiresAt: NOW + 20 + TICKET_TTL_MS }), NOW + 20);
    expect(existsSync(fileFor("orphan"))).toBe(false);
  });

  it("removes stale temp and claim files by age", () => {
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, ".tmp-1-x");
    writeFileSync(stale, "");
    const old = (NOW - TICKET_TTL_MS - 1000) / 1000;
    utimesSync(stale, old, old);
    const fresh = join(dir, "abc.json.claim-1-y");
    writeFileSync(fresh, "");
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    sweepTickets(dir, NOW);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("is silent when the dir does not exist", () => {
    expect(() => sweepTickets(join(root, "absent"), NOW)).not.toThrow();
  });
});

describe("callKey", () => {
  it.each([
    [{ "claudecode/toolUseId": "toolu_1" }, {}, "toolu_1"],
    [{ callId: "call_1", progressToken: 3 }, {}, "call_1"],
    [undefined, { ticketId: "nonce" }, "nonce"],
    [{ progressToken: 1 }, { ticketId: "nonce" }, "nonce"],
  ])("takes the one key present (%j, %j)", (meta, args, key) => {
    expect(callKey(meta, args)).toBe(key);
  });

  it("refuses no key with no-call-key", () => {
    expect(refusal(() => callKey({ progressToken: 1 }, ARGS)).code).toBe("no-call-key");
  });

  it("refuses two keys with multiple-call-keys, naming both", () => {
    const error = refusal(() => callKey({ "claudecode/toolUseId": "a", callId: "b" }, {}));
    expect(error.code).toBe("multiple-call-keys");
    expect(error.message).toContain('_meta["claudecode/toolUseId"]');
    expect(error.message).toContain("_meta.callId");
  });
});

describe("claimTicket", () => {
  it("returns the ticket and the arguments without ticketId", () => {
    writeTicket(dir, "n", ticket(), NOW);
    const claimed = claimTicket(dir, "create_workitem", undefined, { ...ARGS, ticketId: "n" }, NOW);
    expect(claimed.args).toEqual(ARGS);
    expect(claimed.ticket).toMatchObject({ agentId: "alpha", sessionKey: "agent:alpha:main", runId: "run-1" });
  });

  it("is one-shot: the second claim is call-ticket-replayed", () => {
    writeTicket(dir, "k", ticket(), NOW);
    claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW);
    expect(existsSync(fileFor("k"))).toBe(false);
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-replayed",
    );
  });

  it("spends a ticket that fails validation, so it cannot be retried", () => {
    writeTicket(dir, "k", ticket(), NOW);
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, { ...ARGS, title: "X" }, NOW)).code).toBe(
      "call-ticket-digest-mismatch",
    );
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-replayed",
    );
  });

  it("refuses a missing ticket with no-call-ticket", () => {
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "nope" }, ARGS, NOW)).code).toBe(
      "no-call-ticket",
    );
  });

  it("leaves no mark after a forged or early key: no-call-ticket, then that key and another still work", () => {
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "early" }, ARGS, NOW)).code).toBe(
      "no-call-ticket",
    );
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "early" }, ARGS, NOW)).code).toBe(
      "no-call-ticket",
    );
    writeTicket(dir, "early", ticket(), NOW);
    writeTicket(dir, "other", ticket(), NOW);
    expect(claimTicket(dir, "create_workitem", { callId: "early" }, ARGS, NOW).ticket.agentId).toBe("alpha");
    expect(claimTicket(dir, "create_workitem", { callId: "other" }, ARGS, NOW).ticket.agentId).toBe("alpha");
  });

  it("refuses an expired ticket with call-ticket-expired, not no-call-ticket", () => {
    writeTicket(dir, "k", ticket({ expiresAt: NOW - 1 }), NOW - 2);
    const error = refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW));
    expect(error).toMatchObject({ code: "call-ticket-expired", agentId: "alpha" });
  });

  it("refuses a ticket for another verb with call-ticket-verb-mismatch", () => {
    writeTicket(dir, "k", ticket(), NOW);
    expect(refusal(() => claimTicket(dir, "workitem_estimate", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-verb-mismatch",
    );
  });

  const KEY_DIGEST = createHash("sha256").update("k").digest("hex");
  const valid = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ...ticket(), keyDigest: KEY_DIGEST, ...over });

  it.each([
    ["unparseable JSON", "{"],
    ["a wrong version", valid({ v: 2 })],
    ["a missing agent", valid({ agentId: "" })],
    ["a non-numeric expiry", valid({ expiresAt: "soon" })],
    ["another key's ticket", valid({ keyDigest: "0".repeat(64) })],
    ["an expiry beyond the TTL", valid({ expiresAt: NOW + 10 * TICKET_TTL_MS })],
  ])("refuses %s with call-ticket-malformed", (_label, contents) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(fileFor("k"), contents);
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-malformed",
    );
  });

  it("accepts the same hand-written ticket when it is valid", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(fileFor("k"), valid());
    expect(claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW).ticket.agentId).toBe("alpha");
  });

  it("lets exactly one of several concurrent claimants win", () => {
    writeTicket(dir, "k", ticket(), NOW);
    const outcomes = [0, 1, 2].map(() => {
      try {
        claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW);
        return "ok";
      } catch (error) {
        return (error as WorkitemCredentialError).code;
      }
    });
    expect(outcomes).toEqual(["ok", "call-ticket-replayed", "call-ticket-replayed"]);
  });

  const usedFor = (key: string) => join(dir, createHash("sha256").update(key).digest("hex") + ".used");

  it("never claims a fresh ticket that appears under a key after its claim", () => {
    // A hook write that passed its tombstone check just before the claim and
    // links its ticket just after: the ticket exists, but the key is spent.
    writeTicket(dir, "k", ticket(), NOW);
    claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW);
    writeFileSync(fileFor("k"), JSON.stringify({ v: 1, ...ticket(), keyDigest: createHash("sha256").update("k").digest("hex") }));
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-replayed",
    );
    expect(existsSync(fileFor("k"))).toBe(true);
    // And the hook refuses to issue the key at all.
    expect(writeTicket(dir, "k", ticket(), NOW)).toEqual({ ok: false, reason: "key-used" });
  });

  it("treats an existing tombstone (EEXIST) as a replay, not a failure, and leaves the ticket", () => {
    writeTicket(dir, "k", ticket(), NOW);
    writeFileSync(usedFor("k"), JSON.stringify({ expiresAt: NOW + TICKET_TTL_MS }));
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW)).code).toBe(
      "call-ticket-replayed",
    );
    expect(existsSync(fileFor("k"))).toBe(true);
  });

  it("fails closed with call-ticket-claim-failed when the tombstone cannot be written", () => {
    writeTicket(dir, "k", ticket(), NOW);
    // Owner-only, so the dir check passes; read-only, so the tombstone fails (EACCES).
    chmodSync(dir, 0o500);
    try {
      const error = refusal(() => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW));
      expect(error).toMatchObject({ code: "call-ticket-claim-failed", path: usedFor("k") });
      expect(error.message).toContain("EACCES");
    } finally {
      chmodSync(dir, 0o700);
    }
    // Not taken unmarked: the ticket is where the hook left it, with no tombstone.
    expect(existsSync(fileFor("k"))).toBe(true);
    expect(existsSync(usedFor("k"))).toBe(false);
  });

  it("does not spend a key that had no ticket, so the hook can still issue it", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(refusal(() => claimTicket(dir, "create_workitem", { callId: "early" }, ARGS, NOW)).code).toBe(
      "no-call-ticket",
    );
    expect(existsSync(usedFor("early"))).toBe(false);
    expect(writeTicket(dir, "early", ticket(), NOW)).toEqual({ ok: true, duplicate: false });
  });
});

/**
 * Claim ordering and filesystem faults, with node:fs wrapped so a step can be
 * interleaved or made to fail at an exact point of consume().
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argsDigest, claimTicket, TICKET_TTL_MS, writeTicket } from "./call-ticket.js";
import { WorkitemCredentialError } from "./workitem-token.js";

const faults = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string) => void),
  openError: undefined as undefined | ((path: string) => NodeJS.ErrnoException | undefined),
  readError: undefined as undefined | ((path: string) => NodeJS.ErrnoException | undefined),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      faults.beforeRename?.(String(from));
      return actual.renameSync(from, to);
    },
    openSync: (path: fs.PathLike, ...rest: unknown[]) => {
      const error = faults.openError?.(String(path));
      if (error) throw error;
      return (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
    },
    readFileSync: (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const error = faults.readError?.(String(path));
      if (error) throw error;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const NOW = Date.now();
const ARGS = { projectId: "p", title: "T", intent: "I" };
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "si-ticket-faults-"));
  dir = join(root, ".call-tickets");
});
afterEach(() => {
  faults.beforeRename = faults.openError = faults.readError = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const ticket = () => ({
  agentId: "alpha",
  engineStateDir: "/Users/example/.openclaw-x",
  sessionKey: null,
  runId: null,
  verb: "create_workitem",
  argsDigest: argsDigest(ARGS),
  expiresAt: NOW + TICKET_TTL_MS,
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const claim = () => claimTicket(dir, "create_workitem", { callId: "k" }, ARGS, NOW);

const refusal = (fn: () => unknown): WorkitemCredentialError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkitemCredentialError);
    return error as WorkitemCredentialError;
  }
  throw new Error("expected a refusal");
};

describe("claim ordering", () => {
  it("marks the key used before the ticket is taken, so no fresh ticket can be issued in between", () => {
    writeTicket(dir, "k", ticket(), NOW);
    const seen: unknown[] = [];
    faults.beforeRename = (from) => {
      if (!from.endsWith(`${hash("k")}.json`)) return;
      // The tombstone already exists at the moment of the rename...
      seen.push(fs.existsSync(join(dir, `${hash("k")}.used`)));
      // ...so a hook writing under the same key here is refused.
      seen.push(writeTicket(dir, "k", ticket(), NOW));
    };
    expect(claim().ticket.agentId).toBe("alpha");
    expect(seen).toEqual([true, { ok: false, reason: "key-used" }]);
    faults.beforeRename = undefined;
    expect(fs.existsSync(join(dir, `${hash("k")}.json`))).toBe(false);
    expect(refusal(claim).code).toBe("call-ticket-replayed");
  });

  it("refuses a claimant that arrives while another holds the key (exactly one wins)", () => {
    writeTicket(dir, "k", ticket(), NOW);
    let inner: string | undefined;
    faults.beforeRename = (from) => {
      if (inner !== undefined || !from.endsWith(`${hash("k")}.json`)) return;
      inner = "pending";
      try {
        claim();
        inner = "ok";
      } catch (error) {
        inner = (error as WorkitemCredentialError).code;
      }
    };
    expect(claim().ticket.agentId).toBe("alpha");
    expect(inner).toBe("call-ticket-replayed");
  });
});

describe("tombstone faults", () => {
  it.each(["ENOSPC", "EACCES", "EIO"])("fails closed with call-ticket-claim-failed on %s, leaving the ticket", (code) => {
    writeTicket(dir, "k", ticket(), NOW);
    faults.openError = (path) => (path.endsWith(".used") ? errno(code) : undefined);
    let renamed = false;
    faults.beforeRename = () => {
      renamed = true;
    };
    const error = refusal(claim);
    expect(error).toMatchObject({ code: "call-ticket-claim-failed", path: join(dir, `${hash("k")}.used`) });
    expect(error.message).toContain(code);
    expect(renamed).toBe(false);
    expect(fs.existsSync(join(dir, `${hash("k")}.json`))).toBe(true);
  });

  it("tolerates EEXIST: the claim is a replay, not a failure", () => {
    writeTicket(dir, "k", ticket(), NOW);
    faults.openError = (path) => (path.endsWith(".used") ? errno("EEXIST") : undefined);
    expect(refusal(claim).code).toBe("call-ticket-replayed");
  });
});

describe("claim file swept before it is read", () => {
  it("refuses with call-ticket-expired, not a bare ENOENT", () => {
    writeTicket(dir, "k", ticket(), NOW);
    faults.readError = (path) => (path.includes(".json.claim-") ? errno("ENOENT") : undefined);
    const error = refusal(claim);
    expect(error.code).toBe("call-ticket-expired");
    expect(error.message).toContain("swept while it was being claimed");
    // The key stays spent.
    faults.readError = undefined;
    expect(writeTicket(dir, "k", ticket(), NOW)).toEqual({ ok: false, reason: "key-used" });
  });
});

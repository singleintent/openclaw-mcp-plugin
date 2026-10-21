/** Host-owned, metadata-only fallback audit. Never contains message/task bodies or bearer tokens. */
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeSync, constants } from "node:fs";
import { join } from "node:path";

export type AuditRow = {
  v: 1; at: string; kind: "decision" | "result" | "observation" | "observation_failure";
  action: "send_message" | "spawn_session"; route: "assembled" | "code_mode";
  hostAttemptId: string; actorId: string | null; targetDigest: string;
  decisionId?: string; policyVersion?: string; disposition?: string;
  outcome?: string; reasonCode?: string; latencyMs?: number;
  stage?: string; state?: string; transportState?: string; correlation?: "matched" | "missing";
};

export type AuditSink = (row: AuditRow) => void;
const MAX_BYTES = 8 * 1024 * 1024;
const GENERATIONS = 4;

/** Synchronous append+fsync: a successful return means the record is on disk. */
export function createActionAudit(stateDir: string): AuditSink {
  const dir = join(stateDir, "singleintent", "action-policy-audit");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("action audit path is not a directory");
  const file = join(dir, "events.ndjson");
  return (row) => {
    const line = Buffer.from(JSON.stringify(row) + "\n");
    if (line.length > 4096) throw new Error("action audit row too large");
    let fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (fstatSync(fd).size + line.length > MAX_BYTES) {
        closeSync(fd);
        fd = -1;
        for (let n = GENERATIONS - 1; n >= 1; n--) {
          try { renameSync(`${file}.${n}`, `${file}.${n + 1}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        renameSync(file, `${file}.1`);
        fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      }
      let written = 0;
      while (written < line.length) written += writeSync(fd, line, written, line.length - written);
      fsyncSync(fd);
    } finally { if (fd >= 0) closeSync(fd); }
  };
}

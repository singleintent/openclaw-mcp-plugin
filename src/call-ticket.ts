/**
 * Call tickets: how a work-item write learns which agent is calling (SCRUM-182).
 *
 * The MCP server cannot tell who called it, and on runtime-native MCP clients
 * (claude-cli, Codex) the plugin's hook may not change the call's arguments:
 * Codex's native hook relay refuses any rewrite outright. So the hook writes the
 * caller's identity to a file instead, and the server reads it back. Nothing the
 * model emits names the agent or chooses the token.
 *
 * A ticket is keyed by an id both sides see for the same call:
 *
 *  - claude-cli: the hook's `toolCallId` is the `tool_use_id`, which Claude Code
 *    also sends as `tools/call._meta["claudecode/toolUseId"]`.
 *  - Codex native: the hook's `toolCallId` is the Codex `tool_use_id`, which
 *    Codex sends as `tools/call._meta.callId`.
 *  - OpenClaw's own MCP client (embedded runs) sends no `_meta`, but there the
 *    hook may rewrite arguments, so it adds one `ticketId` argument carrying a
 *    fresh random nonce.
 *
 * The key is a lookup handle, never identity. A forged key can only select a
 * ticket that already exists, and that ticket is bound to the exact arguments
 * its owner sent (argsDigest), to one verb, to one use and to a short TTL.
 *
 * Both sides locate the directory from the plugin install root (see
 * pluginRoot), so they agree without being told anything: the hook runs in the
 * Gateway and the server in whatever process the runtime spawned, with whatever
 * environment it was given (Codex hands its MCP children almost none).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkitemCredentialError } from "./workitem-token.js";

export const TICKET_VERSION = 1;

/**
 * How long a ticket stays claimable after the hook writes it.
 *
 * The hook-to-request gap is milliseconds when nothing intervenes (measured
 * 4-17 ms on claude-cli). What can intervene is a plugin approval: another
 * plugin's `before_tool_call` may return `requireApproval`, and the call then
 * waits for a human. On Codex the relay defers that approval past PreToolUse
 * (native-hook-relay `:1085-1097`, resolved at `:578-597`), so the ticket is
 * already written when the wait starts. The default plugin approval timeout is
 * 120 s (`DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS`), and the Gateway adds 10 s of
 * transport grace (`resolvePluginToolApprovalGatewayTimeoutMs`), so 130 s is
 * the longest default wait. 180 s covers that with margin. An approval
 * configured longer (the host allows up to 600 s) that is answered late fails
 * closed with `call-ticket-expired`; it never writes under a guess.
 *
 * Only the hook sets `expiresAt`; the server also rejects a ticket claiming to
 * live longer than this, so the bound holds even for a hand-made file.
 */
export const TICKET_TTL_MS = 180_000;

/** Clock allowance for the "expires too far ahead" check; both sides share one host clock. */
const FUTURE_SKEW_MS = 5_000;

/** The argument the hook adds on the embedded path. Never in any input schema. */
export const TICKET_ID_ARG = "ticketId";

/** The `_meta` keys runtime-native clients send per call. */
export const META_CLAUDE_TOOL_USE_ID = "claudecode/toolUseId";
export const META_CODEX_CALL_ID = "callId";

export type CallTicket = {
  v: typeof TICKET_VERSION;
  agentId: string;
  engineStateDir: string;
  sessionKey: string | null;
  runId: string | null;
  verb: string;
  argsDigest: string;
  /** sha256 of the key, so a file moved to another key's name is refused. */
  keyDigest: string;
  expiresAt: number;
};

/**
 * The plugin install root.
 *
 * The MCP server runs from the install root, so its own module path finds it.
 * The Gateway does not: OpenClaw 2026.9.8 loads plugin code from a capture copy
 * under `<stateDir>/tmp/plugin-captures/…/node_modules/plugin/`, so in the hook
 * the module path names a directory the server never sees. The hook passes the
 * root the Gateway reports (`api.rootDir`) instead. Either way the result is a
 * real path, so `/tmp` and `/private/tmp` cannot name two directories.
 */
export function pluginRoot(rootDir?: string): string {
  const root = rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function defaultTicketsDir(rootDir?: string): string {
  return join(pluginRoot(rootDir), ".call-tickets");
}

/**
 * JSON with object keys sorted at every level, so the hook and the server
 * digest equal arguments equally whatever order the runtime serialised them in.
 * `undefined` members are dropped, as JSON.stringify drops them.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const argsDigest = (args: Record<string, unknown>): string => sha256(stableStringify(args));

export const keyDigest = (key: string): string => sha256(key);

/** A fresh embedded-path key: 256 random bits. */
export const newNonce = (): string => randomBytes(32).toString("base64url");

const ticketPath = (dir: string, key: string) => join(dir, `${keyDigest(key)}.json`);
const usedPath = (dir: string, key: string) => join(dir, `${keyDigest(key)}.used`);

/**
 * Why `dir` is not a safe tickets directory, or undefined when it is: it must be
 * a real directory (not a symlink), owned by this process's user, with no
 * group or other permission bits. mkdir's 0700 applies only when it creates the
 * directory, so a pre-existing one is checked as found.
 */
function unsafeDirReason(dir: string): string | undefined {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it is not a directory";
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  if ((stat.mode & 0o077) !== 0) {
    return `its mode is ${(stat.mode & 0o777).toString(8).padStart(4, "0")}; group and other bits must be clear`;
  }
  return undefined;
}

const dirUnsafe = (dir: string, reason: string) =>
  new WorkitemCredentialError(
    "call-ticket-dir-unsafe",
    `the call-ticket directory ${dir} is unsafe: ${reason}. Remove it or fix it ` +
      "(a directory owned by this user, mode 0700); tickets are never read from or written to it as it is.",
    undefined,
    dir,
  );

/**
 * Create the directory 0700 if missing, then refuse it unless unsafeDirReason
 * passes. Throws call-ticket-dir-unsafe.
 */
function ensureDir(dir: string): void {
  try {
    lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const reason = unsafeDirReason(dir);
  if (reason !== undefined) throw dirUnsafe(dir, reason);
}

/** Write `contents` to a new file, failing if it exists. Mode 0600. */
function writeExclusive(path: string, contents: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

function parseTicket(text: string): CallTicket | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v !== "";
  const optStr = (v: unknown) => v === null || typeof v === "string";
  if (
    t.v !== TICKET_VERSION ||
    !str(t.agentId) ||
    typeof t.engineStateDir !== "string" ||
    !optStr(t.sessionKey) ||
    !optStr(t.runId) ||
    !str(t.verb) ||
    !str(t.argsDigest) ||
    !str(t.keyDigest) ||
    typeof t.expiresAt !== "number" ||
    !Number.isFinite(t.expiresAt)
  ) {
    return undefined;
  }
  return t as unknown as CallTicket;
}

function readExpiry(text: string): number | undefined {
  try {
    const expiresAt = (JSON.parse(text) as { expiresAt?: unknown } | null)?.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove expired tickets, tombstones and leftovers. Opportunistic: run on every
 * write and claim, never fatal. A ticket the call never claims (a later policy
 * blocked it, the run was cancelled) would otherwise stay forever.
 */
export function sweepTickets(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (name.endsWith(".json") || name.endsWith(".used")) {
        // Tickets and tombstones both carry expiresAt; a file without a usable
        // one is swept by age instead.
        const expiresAt = readExpiry(readFileSync(path, "utf8")) ?? lstatSync(path).mtimeMs + TICKET_TTL_MS;
        if (expiresAt < now) unlinkSync(path);
      } else if (lstatSync(path).mtimeMs + TICKET_TTL_MS < now) {
        // Temp files from an interrupted write and claim files from an
        // interrupted claim: neither can be used, so age alone decides.
        unlinkSync(path);
      }
    } catch {
      // Raced with another sweeper or a claim; whoever got there first wins.
    }
  }
}

export type WriteTicketResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "conflict" | "key-used" };

/**
 * Write the ticket for `key`, atomically and exclusively.
 *
 * The contents go to a fresh 0600 temp file opened with O_EXCL, which is then
 * hard-linked to the ticket name. `link` fails with EEXIST rather than replace,
 * so the ticket appears complete or not at all and never overwrites another:
 * O_EXCL semantics without a window in which the server could read half a file.
 *
 * An existing ticket for the same key with the same agent, verb and arguments
 * is a duplicate hook registration doing the same work twice, and succeeds.
 * Anything else under that key is a conflict.
 */
export function writeTicket(
  dir: string,
  key: string,
  ticket: Omit<CallTicket, "v" | "keyDigest">,
  now: number,
): WriteTicketResult {
  ensureDir(dir);
  sweepTickets(dir, now);
  const full: CallTicket = { v: TICKET_VERSION, ...ticket, keyDigest: keyDigest(key) };
  // A key whose ticket was already claimed must not be issued again: that
  // would turn one approved call into two writes.
  try {
    lstatSync(usedPath(dir, key));
    return { ok: false, reason: "key-used" };
  } catch {
    // Not used: the normal case.
  }
  const tmp = join(dir, `.tmp-${process.pid}-${newNonce()}`);
  writeExclusive(tmp, JSON.stringify(full));
  try {
    linkSync(tmp, ticketPath(dir, key));
    return { ok: true, duplicate: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: CallTicket | undefined;
    try {
      existing = parseTicket(readFileSync(ticketPath(dir, key), "utf8"));
    } catch {
      existing = undefined;
    }
    const same =
      existing !== undefined &&
      existing.agentId === full.agentId &&
      existing.verb === full.verb &&
      existing.argsDigest === full.argsDigest &&
      existing.keyDigest === full.keyDigest;
    return same ? { ok: true, duplicate: true } : { ok: false, reason: "conflict" };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The call's key: exactly one of the two `_meta` ids or the `ticketId`
 * argument. None means no hook issued a ticket this server can find; more than
 * one means something other than the expected runtime built the request, and
 * guessing which to trust is the failure this replaces.
 */
export function callKey(
  meta: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string {
  const sources: [string, unknown][] = [
    [`_meta["${META_CLAUDE_TOOL_USE_ID}"]`, meta?.[META_CLAUDE_TOOL_USE_ID]],
    [`_meta.${META_CODEX_CALL_ID}`, meta?.[META_CODEX_CALL_ID]],
    [`the ${TICKET_ID_ARG} argument`, args[TICKET_ID_ARG]],
  ];
  const present = sources.filter(([, v]) => v !== undefined);
  if (present.length > 1) {
    throw new WorkitemCredentialError(
      "multiple-call-keys",
      `the call carries more than one call key (${present.map(([n]) => n).join(", ")}). ` +
        "Exactly one is expected, so none is trusted.",
      undefined,
      undefined,
    );
  }
  const [name, value] = present[0] ?? [];
  if (name === undefined) {
    throw new WorkitemCredentialError(
      "no-call-key",
      `the call carries no call key (_meta["${META_CLAUDE_TOOL_USE_ID}"], ` +
        `_meta.${META_CODEX_CALL_ID} or ${TICKET_ID_ARG}). The SingleIntent plugin's ` +
        "before_tool_call hook issues a ticket for every ticketed write; on a runtime " +
        "where it cannot, the write cannot be attributed and is refused.",
      undefined,
      undefined,
    );
  }
  if (typeof value !== "string" || value === "") {
    throw new WorkitemCredentialError(
      "no-call-key",
      `${name} is not a non-empty string, so it cannot select a ticket.`,
      undefined,
      undefined,
    );
  }
  return value;
}

export type ClaimedCall = { ticket: CallTicket; args: Record<string, unknown> };

/**
 * Claim the ticket for this call, once, and check it describes this call.
 *
 * The claim is an exclusive tombstone under the key, then a rename of the
 * ticket to a name unique to this claimant (see consume), so of any number of
 * concurrent claims exactly one gets the file. The ticket is consumed before it
 * is validated: a ticket that fails a check is spent too, never retried. The
 * tombstone marks the key used, so a replay is reported as one and the hook
 * will not issue that key again while the tombstone lives.
 *
 * The directory must pass the same check the hook applies (unsafeDirReason).
 *
 * Returns the arguments with `ticketId` removed; those are what get digested
 * and what the product receives.
 */
export function claimTicket(
  dir: string,
  verb: string,
  meta: Record<string, unknown> | undefined,
  rawArgs: Record<string, unknown>,
  now: number,
): ClaimedCall {
  const key = callKey(meta, rawArgs);
  const { [TICKET_ID_ARG]: _ticketId, ...args } = rawArgs;
  // The same directory check as the hook's: a ticket from a directory another
  // user could have written is no evidence of who called.
  let reason: string | undefined;
  try {
    reason = unsafeDirReason(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw noTicket(dir);
  }
  if (reason !== undefined) throw dirUnsafe(dir, reason);
  try {
    return validate(consume(dir, key, now), key, verb, args, now);
  } finally {
    // After the claim, not before: sweeping first would delete this call's own
    // expired ticket and report "no ticket" where "expired" is the truth.
    sweepTickets(dir, now);
  }
}

const noTicket = (dir: string) =>
  new WorkitemCredentialError(
    "no-call-ticket",
    `no ticket exists for this call key in ${dir}. The plugin's before_tool_call hook ` +
      "writes one before each ticketed write; it did not run for this call, ran " +
      "under a different plugin install, or the ticket expired and was swept.",
    undefined,
    undefined,
  );

const replayed = () =>
  new WorkitemCredentialError(
    "call-ticket-replayed",
    "the ticket for this call was already claimed. A ticket authorises one write; " +
      "a repeated request with the same call key is refused.",
    undefined,
    undefined,
  );

/**
 * Mark `key` used, then take its ticket file; returns the ticket's text.
 *
 * The tombstone comes first and is the claim: it is created exclusively, so of
 * any number of concurrent claimants exactly one creates it, and only that one
 * goes on to take the ticket. Once it exists the hook refuses the key
 * (`key-used`), and a ticket that still appears under the key afterwards (a
 * hook write that passed its tombstone check just before) is never claimable:
 * every later claim finds the tombstone and is a replay.
 *
 * EEXIST is that replay, not a failure. Any other error creating the tombstone
 * (ENOSPC, EACCES, ...) refuses the claim, so the key is never taken unmarked.
 */
function consume(dir: string, key: string, now: number): string {
  const path = ticketPath(dir, key);
  const used = usedPath(dir, key);
  try {
    writeExclusive(used, JSON.stringify({ expiresAt: now + TICKET_TTL_MS }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw replayed();
    throw new WorkitemCredentialError(
      "call-ticket-claim-failed",
      `the claim marker ${used} could not be written (${code ?? String(error)}), so the ` +
        "ticket was not claimed and the write is refused.",
      undefined,
      used,
    );
  }
  const claim = `${path}.claim-${process.pid}-${newNonce()}`;
  try {
    renameSync(path, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Nothing was claimed, so the key is not spent: a forged or early key must
    // not block the hook from issuing it.
    try {
      unlinkSync(used);
    } catch {
      // Swept already; the key is unmarked either way.
    }
    throw noTicket(dir);
  }
  try {
    return readFileSync(claim, "utf8");
  } catch (error) {
    // A concurrent sweep removes claim files by mtime, which the rename keeps
    // from the ticket, so only a ticket older than its TTL can vanish here.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new WorkitemCredentialError(
      "call-ticket-expired",
      `the ticket for this call outlived its TTL (${TICKET_TTL_MS / 1000} s) and was swept ` +
        "while it was being claimed.",
      undefined,
      undefined,
    );
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      // Swept already.
    }
  }
}

function validate(
  text: string,
  key: string,
  verb: string,
  args: Record<string, unknown>,
  now: number,
): ClaimedCall {
  const ticket = parseTicket(text);
  if (ticket === undefined || ticket.keyDigest !== keyDigest(key)) {
    throw new WorkitemCredentialError(
      "call-ticket-malformed",
      "the ticket for this call is not a valid v1 call ticket for this key.",
      undefined,
      undefined,
    );
  }
  if (ticket.expiresAt > now + TICKET_TTL_MS + FUTURE_SKEW_MS) {
    throw new WorkitemCredentialError(
      "call-ticket-malformed",
      `the ticket claims to stay valid ${Math.round((ticket.expiresAt - now) / 1000)} s, ` +
        `longer than the ${TICKET_TTL_MS / 1000} s a ticket may live.`,
      ticket.agentId,
      undefined,
    );
  }
  if (ticket.expiresAt < now) {
    throw new WorkitemCredentialError(
      "call-ticket-expired",
      `the ticket for agent ${ticket.agentId} expired ${Math.round((now - ticket.expiresAt) / 1000)} s ` +
        `before the request arrived (TTL ${TICKET_TTL_MS / 1000} s).`,
      ticket.agentId,
      undefined,
    );
  }
  if (ticket.verb !== verb) {
    throw new WorkitemCredentialError(
      "call-ticket-verb-mismatch",
      `the ticket for agent ${ticket.agentId} was issued for ${ticket.verb}, not ${verb}.`,
      ticket.agentId,
      undefined,
    );
  }
  if (ticket.argsDigest !== argsDigest(args)) {
    throw new WorkitemCredentialError(
      "call-ticket-digest-mismatch",
      `the arguments differ from the ones the hook issued the ticket for agent ` +
        `${ticket.agentId} against. Something changed them between the hook and this server.`,
      ticket.agentId,
      undefined,
    );
  }
  return { ticket, args };
}

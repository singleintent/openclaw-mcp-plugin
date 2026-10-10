import { randomBytes } from "node:crypto";
import {
  getJson,
  ProductApiError,
  sendJson,
  type RequestOptions,
} from "../client.js";
import type { Config } from "../config.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const WORKITEM_STATES = [
  // SCRUM-150 dispatch events: each appends a ledger event and the item stays
  // open. Outcome, evidence and assignee are the server's to refuse (400).
  "dispatched",
  "acknowledged",
  "started",
  "blocked",
  "completed",
  "failed",
  "canceled",
] as const;
export type WorkitemState = (typeof WORKITEM_STATES)[number];
/** T-shirt sizes the server accepts for `estimate` and `size` (SCRUM-150). */
export const ESTIMATE_SIZES = ["XS", "S", "M", "L", "XL"] as const;

export type WorkitemProjection = {
  id: string;
  title: string | null;
  intent: string | null;
  state: string | null;
  assignee: string | null;
  order: number | null;
  area: string | null;
  anchorState: string;
  anchor?: unknown;
  updatedAt: string | null;
  updatedAtFrom: "ledger" | "file" | "unknown";
};
export type WorkitemEvent = Record<string, unknown> & {
  id: string;
  type: string;
  actor: string;
  at: string;
};
export type WorkitemStoreState = { state: string; defect: boolean };
export type WorkitemIndexResult =
  | {
      regenerated: true;
      inputsHash: string;
      generatedFrom: { itemCount: number; latestEventId: string | null };
    }
  | { regenerated: false; reason: string; status: string };
export type WorkitemLedger = {
  skippedTornTail: boolean;
  deduplicated: number;
  conflicts: unknown[];
};
export type WorkitemListResult = {
  readOk: true;
  project: string;
  items: WorkitemProjection[];
  store: WorkitemStoreState;
  index: WorkitemIndexResult;
};
export type WorkitemDetailResult = {
  readOk: true;
  project: string;
  found: boolean;
  item: WorkitemProjection | null;
  events: WorkitemEvent[];
  ledger?: WorkitemLedger;
};
export type WorkitemWriteResult = WorkitemDetailResult & {
  found: true;
  item: WorkitemProjection;
  event: WorkitemEvent;
  deduplicated: boolean;
};

export class WorkitemReadError extends Error {
  readonly code = "workitem-read-failed";
  readonly status = 200;
  constructor(
    readonly operation: "list" | "get",
    readonly projectId: string,
    reason: string,
  ) {
    super("could not read work items for project " + projectId + " [workitem-read-failed]: " + reason);
    this.name = "WorkitemReadError";
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value))
    throw new Error(name + " must be a UUID");
  return value;
}
function requireEventId(value: unknown): string {
  if (value === undefined) return generateUuidV7();
  if (typeof value !== "string" || !UUID7_RE.test(value))
    throw new Error("eventId must be a UUIDv7");
  return value;
}
/** Generate a UUIDv7 request key when the caller did not provide a stable key. */
export function generateUuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
function projectQuery(projectId: string): string {
  return "?project=" + encodeURIComponent(projectId);
}
function assertListResult(
  value: unknown,
  projectId: string,
): WorkitemListResult {
  if (!isRecord(value) || typeof value.readOk !== "boolean")
    throw new Error(
      "the work-item list API returned an invalid response envelope",
    );
  if (!value.readOk)
    throw new WorkitemReadError(
      "list",
      projectId,
      String(value.reason ?? value.error ?? "readOk was false"),
    );
  if (!Array.isArray(value.items))
    throw new Error("the work-item list API response omitted its items array");
  return value as WorkitemListResult;
}
function assertDetailResult(
  value: unknown,
  projectId: string,
): WorkitemDetailResult {
  if (!isRecord(value) || typeof value.readOk !== "boolean")
    throw new Error(
      "the work-item detail API returned an invalid response envelope",
    );
  if (!value.readOk)
    throw new WorkitemReadError(
      "get",
      projectId,
      String(value.reason ?? value.error ?? "readOk was false"),
    );
  if (typeof value.found !== "boolean" || !Array.isArray(value.events))
    throw new Error(
      "the work-item detail API response omitted found or events",
    );
  return value as WorkitemDetailResult;
}
export async function listWorkitems(
  config: Config,
  args: { projectId: unknown },
  options: RequestOptions = {},
): Promise<WorkitemListResult> {
  const projectId = requireUuid(args.projectId, "projectId");
  const response = await getJson<unknown>(
    config,
    "/api/workitems" + projectQuery(projectId),
    options,
  );
  return assertListResult(response, projectId);
}
export async function getWorkitem(
  config: Config,
  args: { projectId: unknown; itemId: unknown },
  options: RequestOptions = {},
): Promise<WorkitemDetailResult> {
  const projectId = requireUuid(args.projectId, "projectId");
  const itemId = requireUuid(args.itemId, "itemId");
  try {
    const response = await getJson<unknown>(
      config,
      "/api/workitems/" + encodeURIComponent(itemId) + projectQuery(projectId),
      options,
    );
    return assertDetailResult(response, projectId);
  } catch (error) {
    if (
      error instanceof ProductApiError &&
      error.status === 404 &&
      isRecord(error.responseBody) &&
      error.responseBody.found === false
    )
      return assertDetailResult(error.responseBody, projectId);
    throw error;
  }
}
export async function createWorkitem(
  config: Config,
  args: {
    projectId: unknown;
    title: unknown;
    intent: unknown;
    estimate?: unknown;
    kind?: unknown;
    assignee?: unknown;
    focus?: unknown;
    test?: unknown;
    eventId?: unknown;
  },
  options: RequestOptions = {},
): Promise<WorkitemWriteResult> {
  const projectId = requireUuid(args.projectId, "projectId");
  if (
    typeof args.title !== "string" ||
    !args.title.trim() ||
    args.title.length > 200
  )
    throw new Error(
      "title must be non-empty text no longer than 200 characters",
    );
  if (
    typeof args.intent !== "string" ||
    !args.intent.trim() ||
    args.intent.length > 10000
  )
    throw new Error(
      "intent must be non-empty text no longer than 10000 characters",
    );
  const eventId = requireEventId(args.eventId);
  // The size and tracking fields are the server's to check: a bad one comes
  // back as its own 400 (invalid-estimate, invalid-assignee, ...) rather than a
  // plugin message saying the same thing. Absent ones stay out of the body, so
  // an omitted test never becomes false.
  const body: Record<string, unknown> = { eventId, title: args.title, intent: args.intent };
  for (const key of ["estimate", "kind", "assignee", "focus", "test"] as const) {
    if (args[key] !== undefined && args[key] !== null) body[key] = args[key];
  }
  const response = await sendJson<unknown>(
    config,
    "POST",
    "/api/workitems" + projectQuery(projectId),
    body,
    options,
  );
  return assertWriteResult(response, projectId);
}
export async function workitemSetState(
  config: Config,
  args: {
    projectId: unknown;
    itemId: unknown;
    state: unknown;
    reason?: unknown;
    outcome?: unknown;
    evidence?: unknown;
    eventId?: unknown;
  },
  options: RequestOptions = {},
): Promise<WorkitemWriteResult> {
  const projectId = requireUuid(args.projectId, "projectId");
  const itemId = requireUuid(args.itemId, "itemId");
  if (
    typeof args.state !== "string" ||
    !WORKITEM_STATES.includes(args.state as WorkitemState)
  )
    throw new Error("state must be one of: " + WORKITEM_STATES.join(", "));
  for (const [name, value, limit] of [
    ["reason", args.reason, 2000],
    ["outcome", args.outcome, 5000],
    ["evidence", args.evidence, 5000],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > limit)
    )
      throw new Error(
        name + " must be text no longer than " + limit + " characters",
      );
  }
  if (
    ["blocked", "failed", "canceled"].includes(args.state) &&
    (typeof args.reason !== "string" || !args.reason.trim())
  )
    throw new Error(
      "reason is required for blocked, failed, and canceled states",
    );
  if (
    args.state === "completed" &&
    (typeof args.outcome !== "string" || !args.outcome.trim())
  )
    throw new Error("outcome is required for completed state");
  const eventId = requireEventId(args.eventId);
  const body: Record<string, unknown> = { eventId, state: args.state };
  for (const key of ["reason", "outcome", "evidence"] as const)
    if (args[key] !== undefined) body[key] = args[key];
  const response = await sendJson<unknown>(
    config,
    "POST",
    "/api/workitems/" +
      encodeURIComponent(itemId) +
      "/state" +
      projectQuery(projectId),
    body,
    options,
  );
  return assertWriteResult(response, projectId);
}
/**
 * Record a re-estimate (SCRUM-150): a new `estimated` ledger event, never an
 * edit of the original. The body is exactly `{eventId, size}`; the server
 * checks the size and refuses a terminal item with 409.
 */
export async function workitemEstimate(
  config: Config,
  args: {
    projectId: unknown;
    itemId: unknown;
    size: unknown;
    eventId?: unknown;
  },
  options: RequestOptions = {},
): Promise<WorkitemWriteResult> {
  const projectId = requireUuid(args.projectId, "projectId");
  const itemId = requireUuid(args.itemId, "itemId");
  if (args.size === undefined) throw new Error("size is required");
  const eventId = requireEventId(args.eventId);
  const response = await sendJson<unknown>(
    config,
    "POST",
    "/api/workitems/" +
      encodeURIComponent(itemId) +
      "/estimate" +
      projectQuery(projectId),
    { eventId, size: args.size },
    options,
  );
  return assertWriteResult(response, projectId);
}
function assertWriteResult(
  value: unknown,
  projectId: string,
): WorkitemWriteResult {
  const detail = assertDetailResult(value, projectId);
  if (
    !detail.found ||
    !detail.item ||
    !isRecord(value) ||
    !isRecord(value.event) ||
    typeof value.deduplicated !== "boolean"
  )
    throw new Error(
      "the work-item write API returned an incomplete success envelope",
    );
  return value as WorkitemWriteResult;
}

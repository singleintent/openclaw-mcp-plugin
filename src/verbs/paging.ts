/**
 * The paging contract every list verb shares.
 *
 * `list_projects` set the shape — `{ <rows>, total, truncated }` — and W-030 asks
 * the four list verbs after it to match. "Match" is a claim that decays: five
 * hand-written copies of the same arithmetic agree on the day they are written
 * and drift afterwards, and the drift shows up as one verb reporting `truncated`
 * differently from another, which is exactly the kind of quiet inconsistency a
 * caller builds a wrong assumption on. So the arithmetic lives once, here, and
 * the verbs call it.
 *
 * `total` always means **rows that matched, before the limit** — so on a verb
 * with a filter it is the post-filter count, not an inventory of everything that
 * exists. `truncated` is stated rather than inferred: a caller should not have to
 * compare `offset + rows.length` against `total` to discover there is more.
 */

export const DEFAULT_LIMIT = 50;

/**
 * The ceiling exists so a caller cannot ask for an unbounded response by
 * accident. 200 clears the widest live collection (53 agents, 33 connections),
 * so today it never truncates anything in practice; it is a guard against the
 * product growing, not a limit anyone currently hits.
 */
export const MAX_LIMIT = 200;

export type PageInput = {
  limit?: number;
  offset?: number;
};

export type Page<T> = {
  rows: T[];
  total: number;
  truncated: boolean;
};

export function resolveLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(
      `limit must be an integer between 1 and ${MAX_LIMIT}, got ${JSON.stringify(limit)}`,
    );
  }
  return value;
}

export function resolveOffset(offset: unknown): number {
  if (offset === undefined || offset === null) return 0;
  const value = typeof offset === "number" ? offset : Number(offset);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`offset must be an integer of 0 or more, got ${JSON.stringify(offset)}`);
  }
  return value;
}

/**
 * Page an already-filtered list. Filtering happens before this call, never after:
 * paging an unfiltered list and then thinning the page yields short pages and a
 * `total` that no amount of paging can reach.
 */
export function paginate<T>(matching: T[], input: PageInput = {}): Page<T> {
  const limit = resolveLimit(input.limit);
  const offset = resolveOffset(input.offset);
  const rows = matching.slice(offset, offset + limit);
  return {
    rows,
    total: matching.length,
    truncated: offset + rows.length < matching.length,
  };
}

/** Validate paging arguments without doing the work, before spending a request. */
export function assertPageInput(input: PageInput): void {
  resolveLimit(input.limit);
  resolveOffset(input.offset);
}

/**
 * OpenClaw's own agent-id pattern, which the product mirrors in
 * `lib/joylabs-ids.js` as `AGENT_ID_RE`. Every id the Gateway can mint passes.
 *
 * That path carries a retired name because it is the product repo's real, current
 * filename and that repo has not been renamed; see the note in
 * `src/verbs/get-project.ts` before "fixing" it.
 */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The product's own project-id pattern (`lib/joylabs-ids.js`). Project ids are
 * always `randomUUID()`, and the product's `assertProjectId` rejects anything
 * else before it can reach a file path.
 */
export const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validated rather than passed through because the failure mode of not checking
 * is the one this repo consistently refuses: a structurally impossible id would
 * quietly match nothing and return an empty list that reads as a real answer.
 * A well-formed id matching nothing still returns empty, because that is the
 * truthful answer.
 */
export function resolveAgentId(agentId: unknown): string | undefined {
  if (agentId === undefined || agentId === null) return undefined;
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `agent_id must be an agent id as the Gateway mints them, got ${JSON.stringify(agentId)}`,
    );
  }
  return agentId;
}

/** Null rather than empty string, so "absent" and "present but blank" stay apart. */
export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

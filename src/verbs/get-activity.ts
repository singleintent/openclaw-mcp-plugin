/**
 * `get_activity` — `GET /api/activity` (`web/server.mjs:554`).
 *
 * Gateway-backed, so it fails `502` rather than a store route's `500`. It returns
 * running sessions plus those that ended inside the product's recently-ended
 * window (`lib/joylabs-activity.js`).
 *
 * ## `now` is passed through verbatim, and that is the whole design of this verb
 *
 * The handler returns `{ now, sessions }` where `now` is **the product server's**
 * clock, sampled after the fetch. The product's own comment says why: so the UI's
 * relative timers do not depend on the browser's clock.
 *
 * Every timestamp in `sessions` — `startedAt`, `endedAt`, `lastActivityAt` — is
 * epoch milliseconds from that same clock. `now` is the reference point they are
 * meaningful against. Recomputing it here, even with `Date.now()` on the same
 * machine, would silently swap in a *different* clock as the reference for
 * timestamps taken from the first one, and the resulting "3 seconds ago" would be
 * wrong by exactly the skew between them — a number nobody can see and nobody
 * would think to check. On one host today that skew is small; across a host
 * boundary, which `config.host` already allows for, it is unbounded.
 *
 * So `now` is carried through as the number the product sent. There is no
 * fallback that invents one: if the product did not send a usable `now`, this
 * verb fails rather than substituting a local clock, because a substituted
 * reference is worse than a stated failure — it is wrong in a way that looks
 * right. `nowSource: "product"` is returned alongside it to say, at the call
 * site, whose clock this is.
 *
 * ## The projection
 *
 * Twelve fields per session, all present on every live row, all bounded scalars:
 * nothing to count and nothing to truncate, so the whole session record passes
 * through — the same outcome as `list_connections` and for the same reason.
 *
 * `displayName` is the one field that could grow, and the product already
 * truncates it server-side (live rows end in an ellipsis). Truncating it again
 * here would re-cut an already-cut string and lose the product's own choice of
 * where the cut goes.
 *
 * `sessions` is paged like every other collection. Live it is 3 rows, far inside
 * the default limit, but session counts move with load rather than with the size
 * of a stored roster, so this is the collection most likely to spike.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString, assertPageInput, paginate, type PageInput } from "./paging.js";

/** The product's wire shape for an activity row. */
type ApiSession = {
  agentId?: unknown;
  sessionKey?: unknown;
  kind?: unknown;
  channel?: unknown;
  displayName?: unknown;
  state?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  runtimeMs?: unknown;
  lastActivityAt?: unknown;
  totalTokens?: unknown;
  lastRunError?: unknown;
};

/** Epoch milliseconds or null — never coerced, never defaulted to a local clock. */
const asEpoch = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export type ActivitySession = {
  agentId: string;
  sessionKey: string | null;
  kind: string | null;
  channel: string | null;
  /** Already truncated by the product; not re-truncated here. */
  displayName: string | null;
  state: string | null;
  /** Epoch milliseconds on the same clock as `now`. */
  startedAt: number | null;
  endedAt: number | null;
  runtimeMs: number | null;
  lastActivityAt: number | null;
  totalTokens: number | null;
  lastRunError: string | null;
};

export type GetActivityResult = {
  /**
   * The product server's clock, exactly as it sent it. Every timestamp below is
   * relative to this and to nothing else.
   */
  now: number;
  /**
   * Constant `"product"`. Present so a caller reading `now` can see whose clock
   * it is without reading this file, and so that any future change to that
   * answer has to change a value a consumer can branch on rather than a comment.
   */
  nowSource: "product";
  sessions: ActivitySession[];
  total: number;
  truncated: boolean;
};

export type GetActivityInput = PageInput;

export function summarize(session: ApiSession): ActivitySession {
  return {
    agentId: asString(session.agentId) ?? "",
    sessionKey: asString(session.sessionKey),
    kind: asString(session.kind),
    channel: asString(session.channel),
    displayName: asString(session.displayName),
    state: asString(session.state),
    startedAt: asEpoch(session.startedAt),
    endedAt: asEpoch(session.endedAt),
    runtimeMs: asCount(session.runtimeMs),
    lastActivityAt: asEpoch(session.lastActivityAt),
    totalTokens: asCount(session.totalTokens),
    lastRunError: asString(session.lastRunError),
  };
}

export function shape(
  now: unknown,
  sessions: ApiSession[],
  input: GetActivityInput = {},
): GetActivityResult {
  const productNow = asEpoch(now);
  if (productNow === null) {
    // Fail rather than substitute. A local clock here would be a different
    // reference point for timestamps taken from the product's, and the error it
    // introduces is invisible at the call site.
    throw new Error(
      `/api/activity returned no usable now (got ${JSON.stringify(now)}); ` +
        `refusing to substitute a local clock, because every timestamp in the ` +
        `response is relative to the product's`,
    );
  }
  const page = paginate(sessions, input);
  return {
    now: productNow,
    nowSource: "product",
    sessions: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
  };
}

export async function getActivity(
  config: Config,
  input: GetActivityInput = {},
  options: RequestOptions = {},
): Promise<GetActivityResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  const payload = await getJson<{ now?: unknown; sessions?: unknown }>(
    config,
    "/api/activity",
    options,
  );
  if (typeof payload !== "object" || payload === null) {
    throw new Error("the product returned a non-object response for /api/activity");
  }
  if (!Array.isArray(payload.sessions)) {
    throw new Error("the product returned no sessions array for /api/activity");
  }
  return shape(payload.now, payload.sessions as ApiSession[], input);
}

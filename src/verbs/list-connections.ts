/**
 * `list_connections` — `GET /api/connections` (`web/server.mjs:876`).
 *
 * Store-backed, so it fails `500` rather than the Gateway routes' `502`.
 *
 * ## The projection drops nothing, and saying so is the point
 *
 * Four fields live, present on all 33 rows: `id`, `from`, `to`, `establishedAt`.
 * Every one is a bounded scalar; there is no collection to count and no
 * unbounded text to replace. So the whole record passes through.
 *
 * That is a result of applying the rule, not a gap where the rule was skipped.
 * Recorded explicitly because the alternative reading — that this verb was
 * written before the rule existed, or that someone forgot — is the one a later
 * reader would reach for, and because a projection that cut something here would
 * be cutting for symmetry rather than for a reason. `total` and `truncated` are
 * still present: they are the list contract, independent of whether any field
 * was dropped.
 *
 * ## What a connection is, and why the ids are not resolved to agents
 *
 * A connection is directed — `from` was pointed at `to` and asked to introduce
 * itself, under the product's interjection-only model — so `from`/`to` is not a
 * symmetric pair and must not be presented as one.
 *
 * Both are agent ids, and this verb deliberately does not expand them into agent
 * records. Doing so would mean a second request to the Gateway-backed
 * `/api/agents` on every call, which would make a store-backed verb fail when the
 * Gateway is down — converting a `500`-class surface into a `502`-class one for
 * no gain. A caller that wants the agents behind the ids calls `list_agents`,
 * which is one request it can decide to make.
 *
 * ## Filters
 *
 * None, on purpose. The natural one is "connections involving agent X", and it is
 * genuinely useful — but `list_projects` already established that a filter must
 * not change the response shape, and "involving" has two directed answers
 * (`from` X, `to` X) that a single boolean filter would flatten. At 33 rows,
 * inside the default limit of 50, a caller can list and filter in one call
 * without paging. If this grows, the filter to add is an explicit `from`/`to`
 * pair rather than a single "involves", and that is a decision worth making on
 * evidence rather than pre-emptively.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString, assertPageInput, paginate, type PageInput } from "./paging.js";

/** The product's wire shape for a connection — all four fields it stores. */
type ApiConnection = {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  establishedAt?: unknown;
};

export type ConnectionSummary = {
  id: string;
  /** The agent that was pointed at `to`. Directed: this pair is not symmetric. */
  from: string | null;
  to: string | null;
  /** ISO-8601 here, matching `/api/projects` and unlike the roster's epoch ms. */
  establishedAt: string | null;
};

export type ListConnectionsResult = {
  connections: ConnectionSummary[];
  /** Connections before the limit. No filter, so this is the inventory. */
  total: number;
  truncated: boolean;
};

export type ListConnectionsInput = PageInput;

export function summarize(connection: ApiConnection): ConnectionSummary {
  return {
    id: asString(connection.id) ?? "",
    from: asString(connection.from),
    to: asString(connection.to),
    establishedAt: asString(connection.establishedAt),
  };
}

export function shape(
  connections: ApiConnection[],
  input: ListConnectionsInput = {},
): ListConnectionsResult {
  const page = paginate(connections, input);
  return {
    connections: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
  };
}

export async function listConnections(
  config: Config,
  input: ListConnectionsInput = {},
  options: RequestOptions = {},
): Promise<ListConnectionsResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  const connections = await getJson<ApiConnection[]>(config, "/api/connections", options);
  if (!Array.isArray(connections)) {
    throw new Error("the product returned a non-array response for /api/connections");
  }
  return shape(connections, input);
}

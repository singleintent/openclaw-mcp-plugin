/**
 * `get_backlog` — `GET /api/backlog` (`web/server.mjs:573`).
 *
 * Store-backed, failing `500`, and the store is a single file:
 * `~/.joylabs/backlog.json`.
 *
 * ## Read-only, permanently, and not because nobody got to the write verb
 *
 * That file is written **only** by agents through their own file tools — no API,
 * no locking (`lib/joylabs-backlog.js`). The product itself only displays it. A
 * write verb here would introduce a second writer with no coordination against
 * the first, and last-write-wins on a whole-file rewrite loses items silently.
 * So there is no write verb, and this is a property of the design rather than a
 * gap in the implementation.
 *
 * The same fact makes a **stale read not an error**. A caller can read this and
 * have an agent rewrite the file a moment later; that is the expected condition,
 * not a failure, and nothing here validates freshness or retries to chase it.
 *
 * ## Named `get_` rather than `list_`, and still a paged list
 *
 * The backlog is one document that happens to contain items, which is why SCRUM-6
 * names it `get_backlog`. The name is kept as specified. The response is still
 * `{ items, total, truncated }`, because the thing inside it is a list of
 * unbounded length and the list contract is about that, not about the verb's
 * prefix. A caller should not have to learn a second pagination story for the one
 * verb whose name starts differently.
 *
 * ## Why `description` survives when `list_templates` dropped `content`
 *
 * By the discriminator stated in `list-templates.ts`: **does the row still answer
 * the verb's question once the field is gone?** A template row without its
 * content still identifies a template well enough to choose one. A backlog item
 * without its description is a title and a status — the description *is* the
 * item, and dropping it would leave this verb answering nothing while still
 * appearing to work.
 *
 * The measurement agrees rather than deciding it. Live: 11 items, 6,676 bytes
 * total, rows from 365 to 1,533 bytes. Against `list_templates`' 35,903 bytes of
 * content in a 37,913-byte response, there is no comparable cost to cut, and
 * cutting the only field that says what an item is to save a few kilobytes would
 * be the projection rule applied against its own purpose.
 *
 * `limit`/`offset` are the bound instead, which is the right bound for a
 * collection that grows in rows rather than in row size.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString, assertPageInput, paginate, type PageInput } from "./paging.js";

/** The product's wire shape for a backlog item — all seven fields it stores. */
type ApiBacklogItem = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  owner?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type BacklogItem = {
  /** A human-written slug, not a UUID — these ids are authored, not minted. */
  id: string;
  title: string | null;
  /** Kept. See the note above on why this is not cut the way template content is. */
  description: string | null;
  status: string | null;
  /**
   * Empty string is the live representation of "unowned", and it is preserved as
   * null rather than passed through as `""`, so that "no owner" reads as absent
   * instead of as an owner whose name is blank.
   */
  owner: string | null;
  /** ISO-8601, like `/api/projects` and unlike the roster's epoch milliseconds. */
  createdAt: string | null;
  updatedAt: string | null;
};

export type GetBacklogResult = {
  items: BacklogItem[];
  /** Items before the limit. No filter, so this is the whole backlog's size. */
  total: number;
  truncated: boolean;
};

export type GetBacklogInput = PageInput;

export function summarize(item: ApiBacklogItem): BacklogItem {
  return {
    id: asString(item.id) ?? "",
    title: asString(item.title),
    description: asString(item.description),
    status: asString(item.status),
    owner: asString(item.owner),
    createdAt: asString(item.createdAt),
    updatedAt: asString(item.updatedAt),
  };
}

export function shape(items: ApiBacklogItem[], input: GetBacklogInput = {}): GetBacklogResult {
  const page = paginate(items, input);
  return {
    items: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
  };
}

export async function getBacklog(
  config: Config,
  input: GetBacklogInput = {},
  options: RequestOptions = {},
): Promise<GetBacklogResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  const items = await getJson<ApiBacklogItem[]>(config, "/api/backlog", options);
  if (!Array.isArray(items)) {
    throw new Error("the product returned a non-array response for /api/backlog");
  }
  // An empty backlog is a normal state and returns an empty list, not an error.
  return shape(items, input);
}

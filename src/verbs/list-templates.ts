/**
 * `list_templates` — `GET /api/templates` (`web/server.mjs:756`).
 *
 * Store-backed, not Gateway-backed: this route reads the product's own flat-file
 * store and fails `500`, where `/api/agents` proxies the Gateway and fails `502`.
 * The client keeps those apart; see `ProductUpstreamError`.
 *
 * ## The rule meets its first unbounded *scalar*
 *
 * Three fields, measured live: `id`, `name`, `content` across 19 templates. The
 * shape is trivial. The size is not — `content` is 35,903 of the response's
 * 37,913 bytes, **94.7%**, with a median of 2,164 characters and a maximum of
 * 3,912.
 *
 * `list_agents` extended the rule to constant-across-rows fields. This extends it
 * the other way: `content` is a *string*, so "unbounded collections become
 * counts" does not literally reach it, but a template's content is an agent's
 * whole system prompt — arbitrary-length prose with no ceiling. The property the
 * rule is really about is unboundedness, not array-ness. So `content` is dropped
 * and replaced by `contentLength`, which is the count analogue for a string.
 *
 * ## Why this cut is right here and the same cut is wrong on `get_backlog`
 *
 * `get_backlog` keeps its `description`, which is also unbounded prose, and the
 * two decisions need a discriminator sharper than "this one felt big". It is:
 * **does the row still answer the verb's question once the field is gone?**
 *
 * A template row without `content` still says which templates exist, what they
 * are called, and roughly how substantial each is — enough to choose one, which
 * is what a caller lists templates in order to do. A backlog item without its
 * description is a title and a status; the description *is* the item, and the
 * row would answer nothing. Measurement supports the same split rather than
 * driving it: 35,903 bytes of template content against 11 backlog descriptions
 * inside a 6,676-byte response.
 *
 * ## The obligation this creates, stated rather than discharged
 *
 * Dropping `agentIds` from `list_projects` made `get_project` an obligation, and
 * dropping `content` here makes a `get_template` the same kind of obligation: as
 * of this verb, nothing in the connector can read a template's text. W-030 scopes
 * exactly five verbs and `get_template` is not among them, so it is **not** added
 * here — widening the item quietly is the failure mode this repo's tracker exists
 * to prevent. It is recorded here and raised with the requester as the one
 * follow-up W-030 creates. Until it lands, the honest statement of this verb's
 * coverage is: it can tell you which template to use, not what it says.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString, assertPageInput, paginate, type PageInput } from "./paging.js";

/** The product's wire shape for a template — all three fields it stores. */
type ApiTemplate = {
  id?: unknown;
  name?: unknown;
  content?: unknown;
};

export type TemplateSummary = {
  id: string;
  name: string | null;
  /**
   * Characters in the dropped `content`, not bytes. Counted as JavaScript string
   * length because that is what a caller can compare against text it holds; a
   * byte count would need an encoding stated to mean anything.
   *
   * Zero is a real value — the live store holds an 11-character template and
   * nothing forbids an empty one — so it does not mean "absent".
   */
  contentLength: number;
};

export type ListTemplatesResult = {
  templates: TemplateSummary[];
  /** Templates before the limit. This verb has no filter, so it is the inventory. */
  total: number;
  truncated: boolean;
};

export type ListTemplatesInput = PageInput;

export function summarize(template: ApiTemplate): TemplateSummary {
  return {
    id: asString(template.id) ?? "",
    name: asString(template.name),
    contentLength: typeof template.content === "string" ? template.content.length : 0,
  };
}

export function shape(
  templates: ApiTemplate[],
  input: ListTemplatesInput = {},
): ListTemplatesResult {
  const page = paginate(templates, input);
  return {
    templates: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
  };
}

export async function listTemplates(
  config: Config,
  input: ListTemplatesInput = {},
  options: RequestOptions = {},
): Promise<ListTemplatesResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  const templates = await getJson<ApiTemplate[]>(config, "/api/templates", options);
  if (!Array.isArray(templates)) {
    throw new Error("the product returned a non-array response for /api/templates");
  }
  return shape(templates, input);
}

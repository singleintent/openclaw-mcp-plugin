/**
 * `update_template` — `PUT /api/templates/:id` (`web/server.mjs:959`).
 *
 * The one write verb here that is genuinely partial, and the whole design of this
 * module is about preserving that.
 *
 * ## Omitted means unchanged, and the mechanism is worth knowing
 *
 * The product applies each field only when it is not `undefined`. So sending
 * `name` alone renames a template without touching its text, and sending `content`
 * alone rewrites the text under the same name. What makes that work end to end is
 * that `JSON.stringify` drops keys whose value is `undefined`: an omitted argument
 * reaches the product genuinely absent rather than as `null`, which would be
 * *present* and would overwrite the field with nothing.
 *
 * That is a property of the client, not of this file, so `client.ts` carries the
 * comment at the line that depends on it. Both places need it: the property is
 * invisible at the point where it matters.
 *
 * ## Neither field is required, but a call with neither is refused
 *
 * Required fields would destroy the partial update. A call with neither, though, is
 * a request to change nothing that still rewrites the store — so it is refused
 * here rather than sent. The refusal is local: there is no product error to
 * surface, because the product would accept it and do nothing.
 *
 * ## Editing a template changes nothing about agents already carrying the role
 *
 * `apply_role` copies a template's content onto an agent at the moment it is
 * applied. Editing the template afterwards changes what the **next** application
 * says and nothing else. This is the misreading most likely to matter — an edit
 * made to correct a live agent's behaviour would appear to succeed and do nothing
 * — so it is in the verb description, not only here.
 *
 * ## Reversible, unlike every other write verb
 *
 * There is no delete route, but there is nothing to delete: the previous name and
 * content can be put back by calling this again. It is the only verb in the write
 * surface that can be undone, which is why it does not carry `NOT_REVERSIBLE`. The
 * previous values are not returned by the product, so a caller that wants to be
 * able to put them back reads the template first.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString } from "./paging.js";
import { optionalText, requireUuid } from "./write-args.js";

/** The product's wire shape for a template — all three fields it stores. */
type ApiTemplate = {
  id?: unknown;
  name?: unknown;
  content?: unknown;
};

export type UpdatedTemplate = {
  id: string;
  name: string;
  /** The full stored text after the update, which is how a caller confirms it. */
  content: string;
};

export type UpdateTemplateResult = {
  template: UpdatedTemplate;
  /**
   * Which fields this call actually sent, as the product will have applied them.
   *
   * Present because "omitted means unchanged" is the verb's central behaviour and
   * a caller cannot otherwise tell a field it left alone from a field it set to
   * the same value. Derived from the request, not from the response — it says what
   * was asked for, and `template` says what came back.
   */
  changed: ("name" | "content")[];
};

export type UpdateTemplateInput = {
  templateId?: unknown;
  name?: unknown;
  content?: unknown;
};

export function detail(template: ApiTemplate): UpdatedTemplate {
  return {
    id: asString(template.id) ?? "",
    name: asString(template.name) ?? "",
    content: asString(template.content) ?? "",
  };
}

export async function updateTemplate(
  config: Config,
  input: UpdateTemplateInput = {},
  options: RequestOptions = {},
): Promise<UpdateTemplateResult> {
  // Validate before the request, so a bad argument costs no write attempt.
  const templateId = requireUuid(input.templateId, "template_id");
  const name = optionalText(input.name, "name");
  const content = optionalText(input.content, "content");

  if (name === undefined && content === undefined) {
    throw new Error(
      "update_template needs name, content, or both — a call with neither would " +
        "rewrite the template with no change to it",
    );
  }

  const changed: ("name" | "content")[] = [];
  if (name !== undefined) changed.push("name");
  if (content !== undefined) changed.push("content");

  // The id is percent-encoded even though it was just checked to be a UUID, which
  // cannot contain a character encoding would change. Cheap, and it means the
  // path stays correct if the id pattern is ever loosened.
  const path = `/api/templates/${encodeURIComponent(templateId)}`;
  // `undefined` fields are dropped by JSON.stringify, so an omitted argument
  // arrives absent and the product leaves that field alone.
  const template = await sendJson<ApiTemplate>(config, "PUT", path, { name, content }, options);
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new Error(`the product returned a non-object response for PUT ${path}`);
  }
  return { template: detail(template), changed };
}

/**
 * `create_template` — `POST /api/templates` (`web/server.mjs:768`).
 *
 * Two fields in, the created record out with the `id` the product assigned. That
 * id is what `apply_role` takes.
 *
 * ## `content` is the payload, not a label
 *
 * A template's content is the text an agent is later told to store as its own
 * role. It is used **verbatim**: nothing here or in the product rewrites,
 * validates or templates it. So this argument is the whole of what the template
 * does, and a vague one produces a vague agent.
 *
 * That is also why `content` is checked for more than emptiness. The product's own
 * check is falsy — `if (!content) throw` — which accepts a string of spaces, and a
 * whitespace-only template would be created successfully and then handed to an
 * agent as its identity. `write-args.ts` explains why this is the one place being
 * stricter than the product is worth it.
 *
 * ## The response returns whole
 *
 * Three fields: `id`, `name`, `content`. `content` is unbounded text, and
 * `list_templates` drops exactly that field for exactly that reason — but the
 * discriminator there is *does the row still answer the verb's question?* For a
 * list, choosing a template, it does. For a create, `content` is the echo that
 * confirms what was stored, and it is the argument the caller just sent, so
 * returning it costs a caller nothing it does not already hold. `contentLength`
 * would be a worse answer to "what did you store" than the text itself.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString } from "./paging.js";
import { requireFilledText } from "./write-args.js";

/** The product's wire shape for a template — all three fields it stores. */
type ApiTemplate = {
  id?: unknown;
  name?: unknown;
  content?: unknown;
};

export type CreatedTemplate = {
  /** The id the product assigned. `apply_role` takes this. */
  id: string;
  name: string;
  /** Echoed back as stored. See the note above on why this is not a length. */
  content: string;
};

export type CreateTemplateResult = {
  template: CreatedTemplate;
};

export type CreateTemplateInput = {
  name?: unknown;
  content?: unknown;
};

export function detail(template: ApiTemplate): CreatedTemplate {
  return {
    id: asString(template.id) ?? "",
    name: asString(template.name) ?? "",
    content: asString(template.content) ?? "",
  };
}

export async function createTemplate(
  config: Config,
  input: CreateTemplateInput = {},
  options: RequestOptions = {},
): Promise<CreateTemplateResult> {
  // Validate before the request, so a bad argument costs no write attempt.
  const body = {
    name: requireFilledText(input.name, "name"),
    content: requireFilledText(input.content, "content"),
  };
  const template = await sendJson<ApiTemplate>(config, "POST", "/api/templates", body, options);
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("the product returned a non-object response for POST /api/templates");
  }
  return { template: detail(template) };
}

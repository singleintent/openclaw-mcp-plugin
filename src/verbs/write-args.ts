/**
 * Argument validation for the write verbs.
 *
 * A write verb is an API call and nothing else: these checks plus the request is
 * the whole of what it does. So this module is deliberately small, and everything
 * in it earns its place the same way — by refusing an argument the product would
 * refuse anyway, one round trip earlier and with a message that names which
 * argument was wrong instead of returning the product's bare `400`.
 *
 * Nothing here *decides* anything. A check that the product does not also make
 * would be this layer inventing a rule, and the rule would then disagree with the
 * product the first time either changed. Every pattern below is the product's own.
 *
 * ## Why validating before a write matters more than before a read
 *
 * On a read, skipping validation costs a wasted request. On a write it can cost a
 * partial one: several of these routes spend a real agent turn before they record
 * anything, and a body the product rejects halfway leaves a caller reasoning about
 * what did and did not happen. Refusing here is refusing while nothing has
 * happened yet, which is the only point at which "nothing happened" is certain.
 */
import { AGENT_ID_RE, PROJECT_ID_RE } from "./paging.js";

/**
 * The product mints project, template and connection ids the same way, so one
 * pattern covers the three. Named for what a caller sees rather than for the
 * function that produces it.
 */
const UUID_RE = PROJECT_ID_RE;

/** A required argument that has to be a non-empty string. */
export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Required text that has to carry something other than whitespace.
 *
 * Separate from `requireText` because the product's own checks are falsy checks —
 * `if (!name) throw` — and `" "` passes those. A template whose content is three
 * spaces is accepted by the product and is useless: it becomes an agent's whole
 * role. Refusing it here is refusing a write that would succeed and be wrong,
 * which is the one case where being slightly stricter than the product is worth
 * it. Stated rather than silent, because it is the only such case.
 */
export function requireFilledText(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (text.trim().length === 0) {
    throw new Error(`${name} cannot be only whitespace`);
  }
  return text;
}

/** Optional text: absent stays absent, so it reaches the product as absent. */
export function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, name);
}

/**
 * A required agent id, in the shape the Gateway mints and the product accepts.
 *
 * The read side has `resolveAgentId`, which treats absent as "no filter". A write
 * cannot: there is no agent to write to. Hence a second function rather than a
 * flag, so neither call site can pass the wrong one and get the other's meaning.
 */
export function requireAgentId(value: unknown, name = "agent_id"): string {
  const text = requireText(value, name);
  if (!AGENT_ID_RE.test(text)) {
    throw new Error(
      `${name} must be an agent id as the Gateway mints them, got ${JSON.stringify(value)}`,
    );
  }
  return text;
}

/**
 * A required id the product minted as a UUID.
 *
 * For `template_id` this is also what keeps it safe to put in a URL path:
 * `update_template` interpolates the id into `/api/templates/:id`, and a value
 * containing `/` or `..` would address a different route than the caller asked
 * for. A UUID cannot. The id is still percent-encoded at the call site — belt and
 * braces, because the check and the encoding protect against being wrong about
 * each other.
 */
export function requireUuid(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (!UUID_RE.test(text)) {
    throw new Error(
      `${name} must be a UUID as the product mints them, got ${JSON.stringify(value)}`,
    );
  }
  return text;
}

/**
 * The sentence every irreversible verb ends with, written once.
 *
 * Five of the seven write verbs cannot be undone through this connector, and the
 * reason is the same for all of them: the product exposes no delete route, so
 * there is no endpoint to wrap. Saying it per verb in per-verb words would let the
 * wording drift until one verb sounded more reversible than another, which is the
 * one thing this sentence exists to prevent.
 */
export const NOT_REVERSIBLE =
  "This cannot be undone from here: the product exposes no delete route, so this " +
  "connector has none.";

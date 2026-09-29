/**
 * `create_agent` — `POST /api/agents` (`web/server.mjs:650`).
 *
 * Registers an agent and adds it to a project. Gateway-backed, so it fails `502`
 * rather than a store route's `500`.
 *
 * ## The decision on this route's second flow, made rather than inherited
 *
 * `POST /api/agents` serves two flows through one body. Plain create registers the
 * agent. Sending `templateId` and `content` together — the product requires them
 * together or not at all — takes a richer path that also writes a **pending**
 * onboarding record. Finishing that record needs a second call, to
 * `POST /api/agents/:id/onboarding` (`web/server.mjs:720`).
 *
 * **Those two fields are deliberately not in this verb's schema, and no verb here
 * wraps the onboarding call.** The alternative was to wrap it, so that one verb
 * made both requests. That is rejected for the reason the whole package exists:
 * a verb here is one API call, and a verb that made two would be this layer
 * orchestrating a product flow. It would also have no honest failure story —
 * when the first call succeeds and the second does not, the verb has to report a
 * failure that created an agent, and the caller cannot tell that from a failure
 * that created nothing.
 *
 * Leaving the fields out is not merely the conservative choice; it is the one that
 * keeps a bad state unreachable. Offering them without the follow-up call would let
 * a caller strand an agent at "Onboarding not started" with nothing in this surface
 * able to move it on. Omitting them means every agent this verb creates has no
 * onboarding record at all, which is exactly the state `apply_role` requires — so
 * `apply_role` is the in-surface way to give a new agent its role, and it works on
 * every agent this verb produces.
 *
 * If the two-step flow is wanted through MCP, the thing to add is a verb that wraps
 * the onboarding call by itself. That keeps one verb to one call.
 *
 * ## Nothing here can be undone, and two of these arguments are permanent
 *
 * There is no delete route, so there is no delete verb. An agent's identity is not
 * editable afterwards, and its workspace is derived from the project's working
 * directory at creation and never changed. So `name`, `project_id` and
 * `workspace_subpath` are each set once, for good: a wrong one means creating
 * another agent, not correcting this one. The verb description says so, because
 * this is the point at which a caller can still act on it.
 *
 * ## `workspace_subpath` is relative, and the product enforces that
 *
 * The workspace is the project's working directory, or that directory joined with
 * `workspace_subpath`. The product rejects anything that escapes the project
 * directory. This verb does not re-implement that check — it would be a second
 * opinion about a path this layer cannot resolve, since the project's working
 * directory is only known to the product. What it does do is refuse an absolute
 * path, which cannot be a subpath under any resolution and is the mistake the
 * argument's name invites.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString } from "./paging.js";
import { optionalText, requireFilledText, requireUuid } from "./write-args.js";

export type CreateAgentResult = {
  /**
   * Lifted out of the response because every later verb's `agent_id` is this
   * value, and a create whose id a caller has to go digging for is a create that
   * answered the wrong question.
   */
  agentId: string;
  /**
   * The product's create result, whole. Bounded fields only, so the projection
   * drops nothing — the same outcome as `list_connections`.
   */
  created: Record<string, unknown>;
};

export type CreateAgentInput = {
  name?: unknown;
  projectId?: unknown;
  workspaceSubpath?: unknown;
  model?: unknown;
};

/**
 * Refused locally because it cannot be right under any resolution: a subpath is
 * joined onto the project's working directory, and an absolute path would either
 * escape it or be a confusing way of writing a path that does not. The product
 * rejects the escape too; this refuses it before spending a Gateway call.
 */
function requireRelativeSubpath(value: unknown): string | undefined {
  const subpath = optionalText(value, "workspace_subpath");
  if (subpath === undefined) return undefined;
  if (subpath.startsWith("/")) {
    throw new Error(
      `workspace_subpath must be relative to the project's working directory, ` +
        `got the absolute path ${JSON.stringify(subpath)}`,
    );
  }
  return subpath;
}

export async function createAgent(
  config: Config,
  input: CreateAgentInput = {},
  options: RequestOptions = {},
): Promise<CreateAgentResult> {
  // Validate before the request, so a bad argument costs no write attempt.
  const body = {
    name: requireFilledText(input.name, "name"),
    projectId: requireUuid(input.projectId, "project_id"),
    workspaceSubpath: requireRelativeSubpath(input.workspaceSubpath),
    model: optionalText(input.model, "model"),
  };

  const created = await sendJson<Record<string, unknown>>(
    config,
    "POST",
    "/api/agents",
    body,
    options,
  );
  if (created === null || typeof created !== "object" || Array.isArray(created)) {
    throw new Error("the product returned a non-object response for POST /api/agents");
  }

  const agentId = asString(created.agentId);
  if (agentId === null) {
    // A success with no id is not a usable success: the agent may exist and the
    // caller has no way to name it. Failing here says that plainly rather than
    // returning an empty string that reads as an id.
    throw new Error(
      "the product accepted the agent but returned no agentId, so the new agent " +
        "cannot be addressed — call list_agents to find out whether it was created",
    );
  }
  return { agentId, created };
}

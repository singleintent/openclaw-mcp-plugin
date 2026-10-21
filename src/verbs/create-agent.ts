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
 * ## Nothing here can undo it, and the name is permanent
 *
 * No verb here deletes an agent or edits its identity, so `name` is set once, for
 * good: a wrong one means creating another agent, not correcting this one. The
 * verb description says so, because this is the point at which a caller can still
 * act on it. `project_id` makes the agent a member of that project; this surface
 * has no verb that changes membership afterwards. The product's UI can delete the
 * agent or detach it from the project, and the description names both routes
 * (`REVERSIBILITY.create_agent`).
 *
 * ## The workspace is not the project directory (SCRUM-130)
 *
 * The product assigns each new agent its own workspace under the active OpenClaw
 * profile, separate from the project's working directory. Project membership is
 * recorded explicitly and is what grants access; where the workspace sits neither
 * grants nor restricts it. A separate workspace is not a sandbox: the agent's tools
 * run as the same OS user and can reach the project directory and anything else
 * that user can.
 *
 * ## There is no `workspace_subpath` (SCRUM-188)
 *
 * The product no longer applies one. It accepts a well-formed `workspaceSubpath`
 * only to report it back as `applied: false`, so offering the
 * argument would let a caller believe it chose a location it did not. It is out of
 * the schema, and the verb never sends `workspaceSubpath` even if handed one.
 *
 * ## A create can succeed partially, and the caller must be told (SCRUM-190)
 *
 * After `agents.create` the product polls OpenClaw's roster for up to 5 s, because
 * a config hot reload can lag the create. Two outcomes are not plain successes:
 *
 * - **Roster unverified (2xx).** The agent exists and has project access, taken
 *   from OpenClaw's own create response, but the roster never showed it. The
 *   product answers 200 with `partial: true` and `rosterUnverified: true`. This
 *   verb returns the agent with `partial: true`, the product's `nextAction` and a
 *   `warning` saying not to create it again, rather than a bare success.
 * - **Orphan (502).** OpenClaw created the agent but the roster reports a
 *   missing or different workspace, so the product attached it to no project.
 *   This verb fails with {@link CreateAgentPartialError}, which names the created
 *   agent id and the product's `nextAction` (delete it). The connector cannot
 *   delete; the caller must not simply call `create_agent` again.
 *
 * The client timeout covers the product's whole create: the pre-create roster
 * read, `agents.create`, the 5 s poll (whose final read can overrun by about
 * 2 s), and the AGENTS.md, membership and token steps. The 10 s default could
 * abort a create that then completed, so this verb sets its own.
 */
import { ProductApiError, sendJson, type RequestOptions } from "../client.js";
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
  /** Present and true only when the product reports a partial create. */
  partial?: true;
  /** OpenClaw's roster did not confirm the agent within the product's bound. */
  rosterUnverified?: true;
  /** The product's next step for a partial create, passed through. */
  nextAction?: unknown;
  /** One sentence for the caller, so a partial create never reads as success. */
  warning?: string;
};

/**
 * The client budget for `POST /api/agents`. The product's roster poll alone is
 * 5 s; see the module comment for the rest. Comfortably above the worst case.
 */
export const CREATE_AGENT_TIMEOUT_MS = 30_000;

/**
 * The product created the agent in OpenClaw but could not finish, so the agent
 * exists in a state the caller has to act on. Carries the created id and the
 * product's next action, so a caller can tell this from a failure that created
 * nothing.
 */
export class CreateAgentPartialError extends ProductApiError {
  constructor(
    message: string,
    status: number,
    code: string | undefined,
    responseBody: unknown,
    readonly createdAgentId: string,
    readonly nextAction: unknown,
  ) {
    super(message, status, code, responseBody);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nextActionMessage = (nextAction: unknown): string | null =>
  isRecord(nextAction) ? asString(nextAction.message) : null;

export type CreateAgentInput = {
  name?: unknown;
  projectId?: unknown;
  model?: unknown;
};

export async function createAgent(
  config: Config,
  input: CreateAgentInput = {},
  options: RequestOptions = {},
): Promise<CreateAgentResult> {
  // Validate before the request, so a bad argument costs no write attempt.
  const body = {
    name: requireFilledText(input.name, "name"),
    projectId: requireUuid(input.projectId, "project_id"),
    model: optionalText(input.model, "model"),
  };

  let created: Record<string, unknown>;
  try {
    created = await sendJson<Record<string, unknown>>(config, "POST", "/api/agents", body, {
      ...options,
      timeoutMs: options.timeoutMs ?? CREATE_AGENT_TIMEOUT_MS,
    });
  } catch (error) {
    throw partialCreateError(error) ?? error;
  }
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
  const verification = isRecord(created.verification) ? created.verification : {};
  const partial =
    created.partial === true ||
    created.rosterUnverified === true ||
    verification.openclawRosterVerified === false;
  if (!partial) return { agentId, created };

  const next = nextActionMessage(created.nextAction);
  return {
    agentId,
    partial: true,
    ...(created.rosterUnverified === true || verification.openclawRosterVerified === false
      ? { rosterUnverified: true as const }
      : {}),
    ...(created.nextAction !== undefined ? { nextAction: created.nextAction } : {}),
    warning:
      `Partial create: agent ${agentId} was created, but the product did not fully ` +
      `verify it${typeof created.code === "string" ? ` (${created.code})` : ""}. ` +
      `Do not call create_agent again for it.` +
      (next ? ` Next action: ${next}` : ` Re-read it with list_agents.`),
    created,
  };
}

/**
 * Turns a failed create that nonetheless created an agent into an error that
 * names it. Anything else is left for the caller to rethrow unchanged.
 */
function partialCreateError(error: unknown): CreateAgentPartialError | undefined {
  if (!(error instanceof ProductApiError) || !isRecord(error.responseBody)) return undefined;
  const response = error.responseBody;
  const createdAgentId = asString(response.createdAgentId);
  if (response.openclawAgentCreated !== true || createdAgentId === null) return undefined;
  const next = nextActionMessage(response.nextAction);
  return new CreateAgentPartialError(
    `${error.message}\n\nOpenClaw DID create agent ${createdAgentId}, but the product ` +
      `could not finish setting it up, so it is not usable as created. Do not call ` +
      `create_agent again until this agent is dealt with.` +
      (next ? ` Next action: ${next}` : "") +
      ` This connector cannot delete agents; use the product's UI.`,
    error.status,
    error.code,
    error.responseBody,
    createdAgentId,
    response.nextAction ?? null,
  );
}

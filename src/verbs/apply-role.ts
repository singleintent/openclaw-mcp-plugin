/**
 * `apply_role` — `POST /api/agent-roles` (`web/server.mjs:834`).
 *
 * Gives an agent its role from a template. Gateway-backed, so it fails `502` rather
 * than a store route's `500`.
 *
 * ## One-way, once, and this is the call a caller is most likely to try twice
 *
 * The product refuses any agent that already has a role record in **any** state —
 * `applied`, `pending`, `running` and `failed` all block it — and nothing in this
 * connector or in the product's API clears one. An agent gets a role once. Getting
 * it wrong means creating another agent, not re-roling this one.
 *
 * That refusal arrives as `409`, which `client.ts` raises as `ProductConflictError`
 * with the instruction that follows from it: retrying cannot succeed. The type
 * exists mostly for this verb. Both the verb description and the failure say the
 * same thing, because a caller that reads neither will retry, and a caller that
 * reads either will not.
 *
 * A `pending` or `failed` record left by the product's own two-step Create Agent
 * flow also blocks this, and its only way forward is that flow's own retry, which
 * this connector does not wrap. `create_agent` avoids producing such a record at
 * all — see its header — so every agent created through this surface is roleable.
 *
 * ## Not a row write
 *
 * The product sends the template's content to the agent as a real Gateway turn and
 * waits for it to finish before recording anything. So this costs an agent turn and
 * can take minutes. `agent-turn.ts` holds the timeout rule and the projection rule;
 * this verb applies both.
 *
 * The projection keeps `roleRecord` whole — it is the durable outcome, and it is
 * bounded — and reduces the run to `runId` and `status`. What the agent said on
 * being handed its role is that agent's reply, not this call's result.
 *
 * ## The content applied is the template's content at this moment
 *
 * The role is a copy taken now. Editing the template afterwards through
 * `update_template` changes what the next application says and leaves this agent as
 * it is. There is no re-apply to pick the edit up, because there is no second
 * application.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import {
  PRODUCT_TURN_BUDGET_MS,
  turnProof,
  turnTimeoutMs,
  type TurnEnvelope,
  type TurnProof,
} from "./agent-turn.js";
import { asString } from "./paging.js";
import { requireAgentId, requireUuid } from "./write-args.js";

/** The route takes the Gateway client's default run budget; it sets no override. */
const TIMEOUT_MS = turnTimeoutMs(PRODUCT_TURN_BUDGET_MS);

type ApiRoleRecord = {
  status?: unknown;
  templateId?: unknown;
  templateName?: unknown;
  content?: unknown;
  custom?: unknown;
  appliedAt?: unknown;
};

type ApiApplyRole = TurnEnvelope & {
  roleRecord?: ApiRoleRecord | null;
};

export type RoleRecord = {
  status: string | null;
  templateId: string | null;
  templateName: string | null;
  /**
   * The role text as applied — the copy this agent now carries, which is what
   * makes it worth returning rather than counting. A later edit to the template
   * will not change it, and this is the only record of what it said at the time.
   */
  content: string | null;
  /** Whether the applied text differed from the template's own. */
  custom: boolean | null;
  appliedAt: string | null;
};

export type ApplyRoleResult = {
  /** The durable outcome. Kept whole: it is the thing the call created. */
  roleRecord: RoleRecord | null;
  /** That the turn ran, and nothing the agent said in it. */
  turn: TurnProof;
};

export type ApplyRoleInput = {
  agentId?: unknown;
  templateId?: unknown;
};

export function summarize(record: ApiRoleRecord): RoleRecord {
  return {
    status: asString(record.status),
    templateId: asString(record.templateId),
    templateName: asString(record.templateName),
    content: asString(record.content),
    custom: typeof record.custom === "boolean" ? record.custom : null,
    appliedAt: asString(record.appliedAt),
  };
}

export function shape(response: ApiApplyRole): ApplyRoleResult {
  const record = response.roleRecord;
  return {
    roleRecord:
      record === null || record === undefined || typeof record !== "object"
        ? null
        : summarize(record),
    turn: turnProof(response),
  };
}

export async function applyRole(
  config: Config,
  input: ApplyRoleInput = {},
  options: RequestOptions = {},
): Promise<ApplyRoleResult> {
  // Validate before the request. On this verb that matters more than usual: the
  // request spends an agent turn, and a refusal here spends nothing.
  const body = {
    agentId: requireAgentId(input.agentId),
    templateId: requireUuid(input.templateId, "template_id"),
  };
  const response = await sendJson<ApiApplyRole>(config, "POST", "/api/agent-roles", body, {
    ...options,
    // The caller's own timeout still wins if it set one deliberately; this is a
    // default, and ?? rather than a spread so an explicit undefined cannot fall
    // through to the ten-second default meant for reads.
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  });
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("the product returned a non-object response for POST /api/agent-roles");
  }
  return shape(response);
}

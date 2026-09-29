/**
 * `create_connection` — `POST /api/connections` (`web/server.mjs:888`).
 *
 * Connects one agent to another so they are aware of each other. Gateway-backed, so
 * it fails `502` rather than a store route's `500`.
 *
 * ## Directed, so calling it once connects one way
 *
 * `from` is pointed at `to` and asked to introduce itself, under the product's
 * interjection-only model. The pair is not symmetric and creating the reverse is a
 * second call — which is a second agent turn, not a cheap mirror of the first.
 * `list_connections` reports the same asymmetry on the read side.
 *
 * The product refuses a `from`/`to` pair that already exists, as `409`, which
 * `client.ts` raises as `ProductConflictError`. Note what that does *not* cover: the
 * reverse pair is a different connection and is never a conflict.
 *
 * ## Not a row write, and the longest-running verb in this surface
 *
 * Before recording anything the product wakes the `from` agent and waits for it to
 * introduce itself over the Gateway. **This route gives that turn a 600s budget,**
 * twice the product's default elsewhere, after a real observation: an introduction
 * between two identity-rich agents ran to 44 messages. So this verb's own budget is
 * derived from 600s, not from the default that `apply_role` and `send_message` use.
 *
 * The projection keeps the `connection` row whole — four bounded scalars, nothing to
 * cut — and reduces the run to `runId` and `status`. The introduction the two agents
 * exchanged is their conversation; a caller that wants to read it has `get_activity`
 * and the run id.
 *
 * ## What "connected" means, and what it does not
 *
 * The product asks the two agents to become mutually aware for later reference. It
 * explicitly tells them not to start, propose or discuss any work in that exchange —
 * wording the product arrived at after an earlier phrasing was read as a kickoff and
 * produced real work instead of an introduction. So a connection is awareness, not a
 * task. Worth knowing before calling it to make something happen.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { turnProof, turnTimeoutMs, type TurnEnvelope, type TurnProof } from "./agent-turn.js";
import { asString } from "./paging.js";
import { requireAgentId } from "./write-args.js";

/**
 * This route overrides the product's default run budget to 600s, so the client
 * budget is derived from 600s rather than from `PRODUCT_TURN_BUDGET_MS`. Using the
 * default here would put the client's timeout *inside* the product's, which is the
 * one arrangement `agent-turn.ts` exists to rule out.
 */
const PRODUCT_BUDGET_MS = 600_000;
const TIMEOUT_MS = turnTimeoutMs(PRODUCT_BUDGET_MS);

type ApiConnection = {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  establishedAt?: unknown;
};

type ApiCreateConnection = TurnEnvelope & {
  connection?: ApiConnection | null;
};

export type CreatedConnection = {
  id: string;
  /** The agent that was woken and asked to introduce itself. */
  from: string | null;
  to: string | null;
  establishedAt: string | null;
};

export type CreateConnectionResult = {
  /** The durable row. Kept whole — every field is a bounded scalar. */
  connection: CreatedConnection | null;
  /** That the introduction ran, and not what was said in it. */
  introduction: TurnProof;
};

export type CreateConnectionInput = {
  from?: unknown;
  to?: unknown;
};

export function summarize(connection: ApiConnection): CreatedConnection {
  return {
    id: asString(connection.id) ?? "",
    from: asString(connection.from),
    to: asString(connection.to),
    establishedAt: asString(connection.establishedAt),
  };
}

export function shape(response: ApiCreateConnection): CreateConnectionResult {
  const connection = response.connection;
  return {
    connection:
      connection === null || connection === undefined || typeof connection !== "object"
        ? null
        : summarize(connection),
    introduction: turnProof(response),
  };
}

export async function createConnection(
  config: Config,
  input: CreateConnectionInput = {},
  options: RequestOptions = {},
): Promise<CreateConnectionResult> {
  // Validate before the request. Both ids are checked, and `from` and `to` are
  // named separately in the failure so a caller sees which one was wrong — they
  // are not interchangeable, and a message naming neither would be a coin flip.
  const from = requireAgentId(input.from, "from");
  const to = requireAgentId(input.to, "to");
  if (from === to) {
    // Refused locally: the product would wake the agent and ask it to introduce
    // itself to itself, spending a turn to record something meaningless.
    throw new Error(`from and to must be different agents, both are ${JSON.stringify(from)}`);
  }

  const response = await sendJson<ApiCreateConnection>(
    config,
    "POST",
    "/api/connections",
    { from, to },
    {
      ...options,
      // The caller's own timeout still wins if it set one deliberately; this is a
      // default, and ?? rather than a spread so an explicit undefined cannot fall
      // through to the ten-second default meant for reads.
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    },
  );
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("the product returned a non-object response for POST /api/connections");
  }
  return shape(response);
}

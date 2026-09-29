/**
 * `send_message` — `POST /api/chat` (`web/server.mjs:781`).
 *
 * Sends a message to an agent and returns its reply. Gateway-backed, so it fails
 * `502` rather than a store route's `500`.
 *
 * ## This blocks for the whole of another agent's turn
 *
 * It is not fire-and-forget, and there is no non-blocking route to wrap instead. The
 * product connects, sends, and waits for the run to reach a terminal status before
 * answering. So a call here can sit for minutes, and the caller's own turn sits with
 * it.
 *
 * ## The timeout, and why a shorter one would be worse than a longer one
 *
 * `agent-turn.ts` holds the rule; this verb is the clearest case for it. The message
 * is delivered the moment the product accepts the request. Hanging up early does not
 * un-deliver it: the agent reads it, acts on it, and replies to nobody. A caller told
 * "failed" would then retry and the agent would receive the same instruction twice —
 * which for a message that asks an agent to *do* something is not a duplicate
 * record, it is the work happening twice.
 *
 * So the budget here sits past the product's, the product times out first, and the
 * error a caller sees is the product's own. When this side does time out anyway,
 * `client.ts` says the write may still be in progress and to read before retrying.
 * For this verb that is the literal truth, and `get_activity` is the read.
 *
 * ## The projection, which is the opposite of the other two turn verbs
 *
 * `apply_role` and `create_connection` drop the run's content because the
 * conversation is not their result. Here the conversation **is** the result: the
 * point of the call is what the agent said back. So the reply text is kept and what
 * gets dropped is the assembly detail around it — sequence numbers, timestamps, and
 * the identity bookkeeping that describes how the reply was put together rather than
 * what it says.
 *
 * A reply of `null` is a real outcome, not an error: the run reached a terminal
 * status and produced no text. `status` is what distinguishes that from a failure,
 * which is why it is returned alongside rather than left out as redundant.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import {
  PRODUCT_TURN_BUDGET_MS,
  replyText,
  turnProof,
  turnTimeoutMs,
  type TurnEnvelope,
} from "./agent-turn.js";
import { requireAgentId, requireFilledText } from "./write-args.js";

/** The route takes the Gateway client's default run budget; it sets no override. */
const TIMEOUT_MS = turnTimeoutMs(PRODUCT_TURN_BUDGET_MS);

export type SendMessageResult = {
  /** The handle for looking this turn up afterwards, notably after a timeout. */
  runId: string | null;
  /** The run's terminal status. What tells an empty reply from a failed turn. */
  status: string | null;
  /** The agent's words, joined across text blocks. `null` when it said nothing. */
  reply: string | null;
};

export type SendMessageInput = {
  agentId?: unknown;
  message?: unknown;
};

export function shape(response: TurnEnvelope): SendMessageResult {
  const proof = turnProof(response);
  return {
    runId: proof.runId,
    status: proof.status,
    reply: replyText(response),
  };
}

export async function sendMessage(
  config: Config,
  input: SendMessageInput = {},
  options: RequestOptions = {},
): Promise<SendMessageResult> {
  // Validate before the request. A whitespace-only message passes the product's
  // falsy check and would wake an agent to read nothing, spending a turn on it.
  const body = {
    agentId: requireAgentId(input.agentId),
    message: requireFilledText(input.message, "message"),
  };
  const response = await sendJson<TurnEnvelope>(config, "POST", "/api/chat", body, {
    ...options,
    // The caller's own timeout still wins if it set one deliberately; this is a
    // default, and ?? rather than a spread so an explicit undefined cannot fall
    // through to the ten-second default meant for reads.
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  });
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("the product returned a non-object response for POST /api/chat");
  }
  return shape(response);
}

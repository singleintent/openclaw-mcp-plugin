/**
 * The three write verbs that wake a real agent, and the two things they share.
 *
 * `apply_role`, `create_connection` and `send_message` are not row inserts. Each
 * sends a message to an agent through the Gateway and waits for that agent's turn
 * to reach a terminal status before the product records anything. A turn is billed,
 * and it takes as long as the agent takes — minutes, not milliseconds.
 *
 * ## The timeout rule: the client's budget must sit PAST the server's
 *
 * The tempting choice is a short client timeout, and it is the wrong one. The
 * product's wait is not cancelled by this side hanging up: abandon the request and
 * the agent keeps running, the turn completes, and the product records the write.
 * The caller has been told the call failed and something happened anyway — the
 * worst of the available outcomes, because it invites a retry that does the work
 * twice.
 *
 * So every one of these verbs sets a client budget deliberately **longer** than the
 * product's own budget for the same call. The product then times out first, aborts
 * its own wait, and returns an error describing what actually happened, which the
 * verb surfaces as it is rather than inventing one.
 *
 * `client.ts` carries the other half: when a write does time out here anyway, its
 * message says the write may still complete and that the caller should read before
 * retrying.
 *
 * ## The projection on a turn
 *
 * The product returns `{ ack, run }` — plus the record it wrote, where it wrote
 * one. `run` is the full session projection of the turn, which contains the
 * conversation the agents had. For `apply_role` and `create_connection` that
 * conversation is a third party's and is not this call's result: what the caller
 * needs is that the turn reached a terminal status and what was recorded. Those two
 * verbs therefore keep `runId` and `status` and drop the rest, which is the shaping
 * rule applied to unbounded text exactly as `list_templates` applies it to
 * `content`.
 *
 * `send_message` is the exception, and for the same reason read the other way: the
 * point of that call *is* what the agent said, so there the reply text is the
 * result and the assembly detail around it is what gets dropped. Each of the three
 * says which it is at its own call site.
 */

/**
 * The product's budget for an agent turn on the routes that do not override it:
 * the Gateway client's `runTimeoutMs` default. `create_connection` overrides it and
 * says so.
 */
export const PRODUCT_TURN_BUDGET_MS = 300_000;

/**
 * How far past the product's budget this side waits.
 *
 * Covers the Gateway's own 15s connect allowance, which is spent before the run
 * budget starts, plus room for the round trip. The exact figure matters less than
 * the sign: it must be positive, so the product is always the one that gives up
 * first.
 */
const HEADROOM_MS = 30_000;

/** A client budget that outlasts the product's, which is the whole point of it. */
export const turnTimeoutMs = (productBudgetMs: number): number =>
  productBudgetMs + HEADROOM_MS;

/** A content block in a projected assistant message. */
export type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

/** The envelope every turn-spending route wraps its result in. */
export type TurnEnvelope = {
  ack?: { runId?: unknown } | null;
  run?: {
    runId?: unknown;
    status?: unknown;
    message?: { role?: unknown; content?: unknown } | null;
  } | null;
};

/**
 * Proof the turn ran, reduced to the two fields that say so.
 *
 * `runId` falls back to the ack's, because the ack carries it before the run
 * projection exists and a caller that wants to look the turn up afterwards should
 * not lose the handle just because the run came back thin.
 */
export type TurnProof = {
  runId: string | null;
  /** The run's terminal status as the product reported it. */
  status: string | null;
};

export function turnProof(envelope: TurnEnvelope): TurnProof {
  const runId = envelope.run?.runId ?? envelope.ack?.runId;
  return {
    runId: typeof runId === "string" && runId.length > 0 ? runId : null,
    status:
      typeof envelope.run?.status === "string" && envelope.run.status.length > 0
        ? envelope.run.status
        : null,
  };
}

/**
 * The assistant's words, and only its words.
 *
 * A projected message's content is an array of typed blocks; only `text` blocks
 * carry language, and the rest — tool use, thinking — is machinery the caller did
 * not ask for. The text blocks are joined rather than reduced to the last one,
 * because a reply interrupted by tool use arrives as several of them and taking one
 * would silently return a fragment of the answer.
 */
export function replyText(envelope: TurnEnvelope): string | null {
  const content = envelope.run?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = (content as ContentBlock[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

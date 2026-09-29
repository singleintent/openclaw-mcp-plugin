/**
 * The two shared pieces of a turn-spending verb: the timeout rule and the run
 * projection.
 *
 * The timeout assertion is the one worth having as a test rather than a comment. Its
 * whole content is a sign — the client's budget must be larger than the product's —
 * and a well-meaning edit that "tightened" it would invert the sign while still
 * looking like a timeout. Nothing else in the suite would notice.
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCT_TURN_BUDGET_MS,
  replyText,
  turnProof,
  turnTimeoutMs,
  type TurnEnvelope,
} from "./agent-turn.js";

describe("the timeout rule: the client outlasts the product", () => {
  it.each([
    ["the default run budget", PRODUCT_TURN_BUDGET_MS],
    ["create_connection's 600s override", 600_000],
  ])("gives %s a strictly larger client budget", (_label, productBudget) => {
    expect(turnTimeoutMs(productBudget)).toBeGreaterThan(productBudget);
  });

  it("leaves room for the Gateway's connect allowance on top of the run budget", () => {
    // The connect allowance is spent before the run budget starts, so a client
    // budget that only just exceeded the run budget could still fire first.
    expect(turnTimeoutMs(PRODUCT_TURN_BUDGET_MS) - PRODUCT_TURN_BUDGET_MS).toBeGreaterThanOrEqual(
      15_000,
    );
  });

  it("records the product's default budget as the product sets it", () => {
    expect(PRODUCT_TURN_BUDGET_MS).toBe(300_000);
  });
});

describe("turnProof", () => {
  it("keeps the run's id and terminal status", () => {
    expect(turnProof({ run: { runId: "r-1", status: "completed" } })).toEqual({
      runId: "r-1",
      status: "completed",
    });
  });

  it("falls back to the ack's runId when the run carries none", () => {
    // The ack has the handle before the run projection exists. Losing it would
    // leave a caller unable to look the turn up, which is the one thing the handle
    // is for after a timeout.
    expect(turnProof({ ack: { runId: "r-2" }, run: { status: "completed" } })).toEqual({
      runId: "r-2",
      status: "completed",
    });
  });

  it("prefers the run's id when both are present", () => {
    expect(turnProof({ ack: { runId: "ack" }, run: { runId: "run" } }).runId).toBe("run");
  });

  it.each([{}, { run: null }, { ack: null, run: null }, { run: { runId: "" } }])(
    "returns nulls rather than empty strings for %o",
    (envelope) => {
      expect(turnProof(envelope as TurnEnvelope)).toEqual({ runId: null, status: null });
    },
  );

  it("ignores a non-string runId instead of coercing it", () => {
    expect(turnProof({ run: { runId: 7, status: 9 } } as TurnEnvelope)).toEqual({
      runId: null,
      status: null,
    });
  });

  it("carries a failed status through rather than treating it as absent", () => {
    // A failed turn is a result. Dropping the status would make it look like a
    // turn that never reported one.
    expect(turnProof({ run: { runId: "r", status: "failed" } }).status).toBe("failed");
  });
});

describe("replyText", () => {
  const withContent = (content: unknown): TurnEnvelope => ({
    run: { runId: "r", status: "completed", message: { role: "assistant", content } },
  });

  it("returns the text of a single block", () => {
    expect(replyText(withContent([{ type: "text", text: "done" }]))).toBe("done");
  });

  it("joins several text blocks rather than taking the last", () => {
    // A reply interrupted by tool use arrives as several text blocks. Taking one
    // would return a fragment of the answer while looking like the answer.
    expect(
      replyText(
        withContent([
          { type: "text", text: "first" },
          { type: "tool_use", text: "ignored" },
          { type: "text", text: "second" },
        ]),
      ),
    ).toBe("first\nsecond");
  });

  it.each(["thinking", "tool_use", "tool_result"])("drops %s blocks", (type) => {
    expect(replyText(withContent([{ type, text: "machinery" }]))).toBeNull();
  });

  it.each([[[]], [undefined], [null], ["a string"], [{}]])(
    "returns null for content %o",
    (content) => {
      expect(replyText(withContent(content))).toBeNull();
    },
  );

  it("returns null for a message that is all whitespace", () => {
    expect(replyText(withContent([{ type: "text", text: "  \n " }]))).toBeNull();
  });

  it("returns null when there is no message at all", () => {
    expect(replyText({ run: { runId: "r", status: "completed" } })).toBeNull();
  });

  it("ignores a text block whose text is not a string", () => {
    expect(replyText(withContent([{ type: "text", text: 5 }]))).toBeNull();
  });

  it("keeps internal blank lines inside a block", () => {
    expect(replyText(withContent([{ type: "text", text: "a\n\nb" }]))).toBe("a\n\nb");
  });
});

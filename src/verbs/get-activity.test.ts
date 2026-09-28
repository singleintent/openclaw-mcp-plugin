import { describe, expect, it } from "vitest";
import { shape, summarize } from "./get-activity.js";

const session = (overrides: Record<string, unknown> = {}) => ({
  agentId: "singleintent-plugin-engineer",
  sessionKey: "agent:singleintent-plugin-engineer:main",
  kind: "direct",
  channel: null,
  displayName: null,
  state: "running",
  startedAt: 1790631605319,
  endedAt: 1790631627544,
  runtimeMs: 22225,
  lastActivityAt: 1790631627000,
  totalTokens: 1234,
  lastRunError: null,
  ...overrides,
});

const NOW = 1790632627842;

describe("now", () => {
  it("passes the product's clock through unmodified", () => {
    expect(shape(NOW, []).now).toBe(NOW);
  });

  it("does not drift toward the local clock", () => {
    // A stale product clock must stay stale, not be quietly corrected.
    const stale = 1;
    expect(shape(stale, []).now).toBe(stale);
    expect(shape(stale, []).now).not.toBe(Date.now());
  });

  it("names whose clock it is", () => {
    expect(shape(NOW, []).nowSource).toBe("product");
  });

  it("fails rather than substituting a local clock when now is unusable", () => {
    for (const bad of [undefined, null, "1790632627842", Number.NaN]) {
      expect(() => shape(bad, [])).toThrow(/refusing to substitute a local clock/);
    }
  });

  it("is unaffected by paging", () => {
    const rows = [session(), session({ agentId: "b" }), session({ agentId: "c" })];
    expect(shape(NOW, rows, { limit: 1 }).now).toBe(NOW);
    expect(shape(NOW, rows, { limit: 1, offset: 2 }).now).toBe(NOW);
  });
});

describe("the projection", () => {
  it("passes the whole session record through", () => {
    expect(Object.keys(summarize(session())).sort()).toEqual(
      [
        "agentId",
        "channel",
        "displayName",
        "endedAt",
        "kind",
        "lastActivityAt",
        "lastRunError",
        "runtimeMs",
        "sessionKey",
        "startedAt",
        "state",
        "totalTokens",
      ].sort(),
    );
  });

  it("keeps timestamps as the epoch numbers now is measured against", () => {
    const summary = summarize(session());
    expect(summary.startedAt).toBe(1790631605319);
    expect(summary.runtimeMs).toBe(22225);
  });

  it("does not re-truncate a displayName the product already truncated", () => {
    const truncated = "Ask the infrastructure eng to figure out how to distribute…";
    expect(summarize(session({ displayName: truncated })).displayName).toBe(truncated);
  });

  it("reports a missing timestamp as null rather than as zero", () => {
    const summary = summarize(session({ endedAt: null, totalTokens: undefined }));
    expect(summary.endedAt).toBeNull();
    expect(summary.totalTokens).toBeNull();
  });
});

describe("the list shape", () => {
  const rows = Array.from({ length: 3 }, (_, i) => session({ agentId: `agent-${i}` }));

  it("carries the list contract alongside now", () => {
    expect(Object.keys(shape(NOW, rows)).sort()).toEqual(
      ["now", "nowSource", "sessions", "total", "truncated"].sort(),
    );
  });

  it("states truncated rather than leaving it to be inferred", () => {
    const result = shape(NOW, rows, { limit: 2 });
    expect(result.sessions).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("treats no activity as a normal state", () => {
    const result = shape(NOW, []);
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

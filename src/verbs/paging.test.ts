/**
 * The shared paging contract, pinned against literals.
 *
 * Every other test that touches these bounds refers to them symbolically —
 * `expect(resolveLimit(MAX_LIMIT)).toBe(MAX_LIMIT)` — which is right for
 * expressing intent and useless for catching the bound *moving*: it passes
 * whatever the constant becomes. W-031 raised `DEFAULT_LIMIT` to sit on top of
 * `MAX_LIMIT`, which puts the ceiling one constant away from being removed by
 * accident, so this file states the numbers outright. It is deliberately the
 * only place in the suite that hard-codes them.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  paginate,
  resolveLimit,
  resolveOffset,
} from "./paging.js";

describe("the ceiling, stated in literals so it cannot drift unnoticed", () => {
  it("is still 200", () => {
    expect(MAX_LIMIT).toBe(200);
  });

  it("still rejects 201 rather than clamping it", () => {
    expect(() => resolveLimit(201)).toThrow(
      /limit must be an integer between 1 and 200/,
    );
  });

  it("still accepts exactly 200", () => {
    expect(resolveLimit(200)).toBe(200);
  });

  it("still rejects 0 and negatives at the bottom", () => {
    expect(() => resolveLimit(0)).toThrow(/between 1 and 200/);
    expect(() => resolveLimit(-1)).toThrow(/between 1 and 200/);
  });

  it("still rejects a non-integer", () => {
    expect(() => resolveLimit(1.5)).toThrow(/between 1 and 200/);
    expect(() => resolveLimit("many")).toThrow(/between 1 and 200/);
  });
});

describe("the default", () => {
  it("is 200", () => {
    expect(DEFAULT_LIMIT).toBe(200);
  });

  it("sits exactly on the ceiling, so limit can only ever reduce", () => {
    expect(DEFAULT_LIMIT).toBe(MAX_LIMIT);
    // The property that makes the two constants worth keeping separate: a
    // caller can never ask for more than it already gets by default.
    expect(() => resolveLimit(DEFAULT_LIMIT + 1)).toThrow();
  });

  it("applies when limit is omitted", () => {
    expect(resolveLimit(undefined)).toBe(200);
    expect(resolveLimit(null)).toBe(200);
  });

  it("does not truncate a collection the size of the live roster", () => {
    // 53 agents was the number that made the old default of 50 wrong.
    const roster = Array.from({ length: 53 }, (_, i) => i);
    const page = paginate(roster);
    expect(page.rows).toHaveLength(53);
    expect(page.total).toBe(53);
    expect(page.truncated).toBe(false);
  });

  it("still truncates past the ceiling, because the guard is the point", () => {
    const huge = Array.from({ length: 201 }, (_, i) => i);
    const page = paginate(huge);
    expect(page.rows).toHaveLength(200);
    expect(page.total).toBe(201);
    expect(page.truncated).toBe(true);
  });
});

describe("offset is unchanged by the default moving", () => {
  it("still defaults to 0 and still rejects negatives", () => {
    expect(resolveOffset(undefined)).toBe(0);
    expect(() => resolveOffset(-1)).toThrow(/offset must be an integer of 0 or more/);
  });

  it("still pages from the offset", () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);
    expect(paginate(rows, { limit: 3, offset: 4 }).rows).toEqual([4, 5, 6]);
  });
});

import { describe, expect, it } from "vitest";
import { shape, summarize } from "./list-connections.js";

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: "063f8bea-5459-48b6-a22f-8942dc9d7609",
  from: "test-a",
  to: "test-b",
  establishedAt: "2026-09-17T22:22:44.775Z",
  ...overrides,
});

describe("the projection", () => {
  it("passes the whole record through, because nothing here is unbounded", () => {
    expect(summarize(connection())).toEqual({
      id: "063f8bea-5459-48b6-a22f-8942dc9d7609",
      from: "test-a",
      to: "test-b",
      establishedAt: "2026-09-17T22:22:44.775Z",
    });
  });

  it("keeps the direction, which is not a symmetric pair", () => {
    const summary = summarize(connection({ from: "b", to: "a" }));
    expect(summary.from).toBe("b");
    expect(summary.to).toBe("a");
  });

  it("does not expand the agent ids into agent records", () => {
    // Expanding would make a store-backed verb depend on the Gateway.
    const summary = summarize(connection()) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(["establishedAt", "from", "id", "to"]);
  });

  it("reports a missing field as null rather than as an empty string", () => {
    const summary = summarize({ id: "x" });
    expect(summary.from).toBeNull();
    expect(summary.to).toBeNull();
    expect(summary.establishedAt).toBeNull();
  });
});

describe("the list shape", () => {
  const rows = Array.from({ length: 3 }, (_, i) => connection({ id: `id-${i}` }));

  it("carries total and truncated even though no field was dropped", () => {
    // The list contract is independent of whether the projection cut anything.
    expect(Object.keys(shape(rows)).sort()).toEqual(
      ["connections", "total", "truncated"].sort(),
    );
  });

  it("states truncated rather than leaving it to be inferred", () => {
    const result = shape(rows, { limit: 1 });
    expect(result.connections).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated once the last row is included", () => {
    expect(shape(rows, { limit: 1, offset: 2 }).truncated).toBe(false);
  });

  it("reports an empty store as empty rather than as a failure", () => {
    expect(shape([])).toEqual({ connections: [], total: 0, truncated: false });
  });

  it("rejects paging arguments the shared contract rejects", () => {
    expect(() => shape(rows, { limit: 201 })).toThrow(/limit must be an integer/);
    expect(() => shape(rows, { offset: -1 })).toThrow(/offset must be an integer/);
  });
});

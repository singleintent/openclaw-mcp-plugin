import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  resolveLimit,
  resolveOffset,
  shape,
  summarize,
} from "./list-projects.js";

const project = (id: string, agentIds: string[] = []) => ({
  id,
  name: `project-${id}`,
  workingDirectory: `/tmp/${id}`,
  agentIds,
  createdAt: "2026-09-23T03:21:40.330Z",
});

describe("projection", () => {
  // The rule this verb establishes: unbounded collections become counts.
  it("replaces the unbounded agentIds array with a count", () => {
    const summary = summarize(project("a", ["one", "two", "three"]));
    expect(summary.agentCount).toBe(3);
    expect(summary).not.toHaveProperty("agentIds");
  });

  it("keeps only bounded scalars", () => {
    expect(Object.keys(summarize(project("a"))).sort()).toEqual([
      "agentCount",
      "id",
      "name",
      "workingDirectory",
    ]);
  });

  it("drops createdAt, which costs context without informing a decision", () => {
    expect(summarize(project("a"))).not.toHaveProperty("createdAt");
  });

  it("tolerates a missing agentIds array rather than throwing", () => {
    expect(summarize({ id: "a", name: "a" }).agentCount).toBe(0);
  });

  it("normalises an absent working directory to null", () => {
    expect(summarize({ id: "a", name: "a" }).workingDirectory).toBeNull();
  });
});

describe("pagination", () => {
  const many = Array.from({ length: 120 }, (_, i) => project(String(i)));

  it("reports the untruncated total alongside a page", () => {
    const result = shape(many, { limit: 10 });
    expect(result.projects).toHaveLength(10);
    expect(result.total).toBe(120);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when everything fits", () => {
    const result = shape(many.slice(0, 5), { limit: 10 });
    expect(result).toMatchObject({ total: 5, truncated: false });
  });

  it("pages with offset", () => {
    expect(shape(many, { limit: 10, offset: 10 }).projects[0]?.id).toBe("10");
  });

  it("reports the final page as untruncated", () => {
    expect(shape(many, { limit: 20, offset: 100 }).truncated).toBe(false);
  });

  it("defaults to the documented limit", () => {
    expect(shape(many).projects).toHaveLength(DEFAULT_LIMIT);
  });
});

describe("input validation", () => {
  it.each([0, -1, MAX_LIMIT + 1, 1.5, "abc"])("rejects the limit %s", (limit) => {
    expect(() => resolveLimit(limit)).toThrow(/limit must be an integer/);
  });

  it.each([-1, 1.5, "abc"])("rejects the offset %s", (offset) => {
    expect(() => resolveOffset(offset)).toThrow(/offset must be an integer/);
  });

  it("accepts the documented bounds", () => {
    expect(resolveLimit(1)).toBe(1);
    expect(resolveLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(resolveOffset(0)).toBe(0);
  });

  it("treats omission as the default", () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(resolveOffset(undefined)).toBe(0);
  });
});

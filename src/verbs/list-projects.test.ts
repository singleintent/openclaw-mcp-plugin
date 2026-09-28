import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  resolveAgentId,
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

describe("agentId filter", () => {
  // Mirrors the live shape that motivated the filter: travel-agent is in two
  // projects, so the answer to "which project is this agent in?" is a list.
  const projects = [
    project("a", ["mob2-eng-manager", "travel-agent"]),
    project("b", ["personal-assistant", "travel-agent"]),
    project("c", ["someone-else"]),
    project("d"),
  ];

  it("keeps only projects containing the agent", () => {
    const result = shape(projects, { agentId: "travel-agent" });
    expect(result.projects.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("counts the matching projects in total, not every project that exists", () => {
    expect(shape(projects, { agentId: "travel-agent" })).toMatchObject({
      total: 2,
      truncated: false,
    });
  });

  it("returns an empty result for a well-formed id that matches nothing", () => {
    expect(shape(projects, { agentId: "nobody" })).toMatchObject({
      projects: [],
      total: 0,
      truncated: false,
    });
  });

  it("returns the same shape whether the filter is set or not", () => {
    expect(Object.keys(shape(projects)).sort()).toEqual(
      Object.keys(shape(projects, { agentId: "travel-agent" })).sort(),
    );
  });

  it("filters before paging, so a page is never short of its limit", () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) => project(`hit-${i}`, ["wanted"])),
      ...Array.from({ length: 30 }, (_, i) => project(`miss-${i}`, ["other"])),
    ];
    const result = shape(many, { agentId: "wanted", limit: 10 });
    expect(result.projects).toHaveLength(10);
    expect(result.projects.every((p) => p.id.startsWith("hit-"))).toBe(true);
    expect(result).toMatchObject({ total: 30, truncated: true });
  });

  it("pages within the filtered set", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      project(String(i), i % 2 === 0 ? ["wanted"] : ["other"]),
    );
    const result = shape(many, { agentId: "wanted", limit: 5, offset: 5 });
    expect(result.projects.map((p) => p.id)).toEqual(["10", "12", "14", "16", "18"]);
    expect(result).toMatchObject({ total: 10, truncated: false });
  });

  it("ignores an agentIds array that is not an array", () => {
    expect(shape([{ id: "x", agentIds: "wanted" }], { agentId: "wanted" }).total).toBe(0);
  });
});

describe("input validation", () => {
  it.each([0, -1, MAX_LIMIT + 1, 1.5, "abc"])("rejects the limit %s", (limit) => {
    expect(() => resolveLimit(limit)).toThrow(/limit must be an integer/);
  });

  it.each([-1, 1.5, "abc"])("rejects the offset %s", (offset) => {
    expect(() => resolveOffset(offset)).toThrow(/offset must be an integer/);
  });

  // A structurally impossible id would match nothing and return an empty list
  // that reads as a real answer. Rejecting it keeps the failure visible.
  it.each(["", "with/slash", "with.dot", "with:colon", "-leading-dash", 7, "a".repeat(65)])(
    "rejects the agent_id %s",
    (agentId) => {
      expect(() => resolveAgentId(agentId)).toThrow(/agent_id must be an agent id/);
    },
  );

  it("accepts an agent id the Gateway could mint", () => {
    expect(resolveAgentId("travel-agent")).toBe("travel-agent");
    expect(resolveAgentId("mcp_probe_bot2")).toBe("mcp_probe_bot2");
  });

  it("accepts the documented bounds", () => {
    expect(resolveLimit(1)).toBe(1);
    expect(resolveLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(resolveOffset(0)).toBe(0);
  });

  it("treats omission as the default", () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(resolveOffset(undefined)).toBe(0);
    // An absent filter is not a filter for the empty string.
    expect(resolveAgentId(undefined)).toBeUndefined();
    expect(resolveAgentId(null)).toBeUndefined();
  });
});

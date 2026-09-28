import { describe, expect, it } from "vitest";
import { shape, summarize } from "./get-backlog.js";

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "commit-review-policy",
  title: "Decide commit-review policy for project-scoped teams",
  description:
    "Should commits from project-scoped teams get the same review treatment " +
    "as the Telegram Eng Team's, or is unreviewed autonomy the intended design?",
  status: "open",
  owner: "",
  createdAt: "2026-09-19T16:52:00.000Z",
  updatedAt: "2026-09-19T16:52:00.000Z",
  ...overrides,
});

describe("the projection", () => {
  it("keeps the description, because it is the item", () => {
    const summary = summarize(item());
    expect(summary.description).toBe(item().description);
    // The cut list_templates made is deliberately not made here.
    expect(summary).not.toHaveProperty("descriptionLength");
  });

  it("keeps every stored field", () => {
    expect(Object.keys(summarize(item())).sort()).toEqual(
      ["createdAt", "description", "id", "owner", "status", "title", "updatedAt"].sort(),
    );
  });

  it("reads the live empty-string owner as unowned rather than as a blank name", () => {
    expect(summarize(item()).owner).toBeNull();
    expect(summarize(item({ owner: "james" })).owner).toBe("james");
  });

  it("survives an item missing optional fields", () => {
    const sparse = summarize({ id: "bare" });
    expect(sparse.id).toBe("bare");
    expect(sparse.title).toBeNull();
    expect(sparse.description).toBeNull();
    expect(sparse.status).toBeNull();
  });
});

describe("the list shape", () => {
  const rows = Array.from({ length: 4 }, (_, i) => item({ id: `item-${i}` }));

  it("returns the list contract despite the get_ prefix", () => {
    expect(Object.keys(shape(rows)).sort()).toEqual(["items", "total", "truncated"].sort());
  });

  it("states truncated rather than leaving it to be inferred", () => {
    const result = shape(rows, { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated once the last row is included", () => {
    expect(shape(rows, { limit: 2, offset: 2 }).truncated).toBe(false);
  });

  it("treats an empty backlog as a normal state, not a failure", () => {
    expect(shape([])).toEqual({ items: [], total: 0, truncated: false });
  });

  it("rejects paging arguments the shared contract rejects", () => {
    expect(() => shape(rows, { limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => shape(rows, { offset: -1 })).toThrow(/offset must be an integer/);
  });
});

import { describe, expect, it } from "vitest";
import { shape, summarize } from "./list-templates.js";

const template = (overrides: Record<string, unknown> = {}) => ({
  id: "f1f8979b-be27-4614-962c-184fd6e5b6d7",
  name: "UIUX Agent",
  content: "Name: UIUX bot\n\nScope: Design/UX authority for the team.",
  ...overrides,
});

describe("the projection", () => {
  it("replaces the content with its length", () => {
    const summary = summarize(template());
    expect(summary).not.toHaveProperty("content");
    expect(summary.contentLength).toBe(template().content.length);
  });

  it("counts characters, and reports zero for an absent content", () => {
    expect(summarize(template({ content: undefined })).contentLength).toBe(0);
    expect(summarize(template({ content: 42 })).contentLength).toBe(0);
  });

  it("treats an empty template as zero-length rather than as missing", () => {
    // Zero is a real value here; the live store holds an 11-character template.
    expect(summarize(template({ content: "" })).contentLength).toBe(0);
  });

  it("keeps the identifying fields, which are what choosing a template needs", () => {
    const summary = summarize(template());
    expect(summary.id).toBe("f1f8979b-be27-4614-962c-184fd6e5b6d7");
    expect(summary.name).toBe("UIUX Agent");
  });
});

describe("the list shape", () => {
  const rows = Array.from({ length: 4 }, (_, i) =>
    template({ id: `id-${i}`, content: "x".repeat(i) }),
  );

  it("returns the same three keys every other list verb returns", () => {
    expect(Object.keys(shape(rows)).sort()).toEqual(["templates", "total", "truncated"].sort());
  });

  it("states truncated rather than leaving it to be inferred", () => {
    const result = shape(rows, { limit: 2 });
    expect(result.templates).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated once the last row is included", () => {
    expect(shape(rows, { limit: 4 }).truncated).toBe(false);
    expect(shape(rows, { limit: 2, offset: 2 }).truncated).toBe(false);
  });

  it("reports an empty store as empty rather than as a failure", () => {
    expect(shape([])).toEqual({ templates: [], total: 0, truncated: false });
  });

  it("rejects paging arguments the shared contract rejects", () => {
    expect(() => shape(rows, { limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => shape(rows, { offset: -1 })).toThrow(/offset must be an integer/);
  });
});

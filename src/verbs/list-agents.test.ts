import { describe, expect, it } from "vitest";
import {
  ProjectNotFoundError,
  memberIds,
  resolveProjectId,
  shape,
  summarize,
} from "./list-agents.js";

/**
 * A row carrying every field the live roster carries, including the three that
 * the projection drops. Fixtures that omit the dropped fields cannot prove they
 * are dropped.
 */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-one",
  name: "agent-one",
  identity: { name: "agent-one", theme: "does a thing", emoji: "🛠" },
  workspace: "/tmp/one",
  workspaceGit: true,
  agentRuntime: { id: "claude-cli", source: "model" },
  thinkingLevels: [{ id: "off", label: "off" }, { id: "high", label: "high" }],
  thinkingOptions: ["off", "high"],
  thinkingDefault: "high",
  model: { primary: "anthropic/claude-opus-5" },
  utilityModel: "anthropic/claude-sonnet-4-6",
  defaultPermissionMode: "full",
  createdVia: "operator",
  creatorAgentId: null,
  createdAt: 1790179774225,
  onboarding: {
    status: "applied",
    error: null,
    templateId: "073641d8-6a6e-49e3-b364-eda2c531bd49",
    templateName: "Cellar and Inventory Manager",
    custom: false,
    startedAt: null,
    appliedAt: "2026-09-23T16:12:13.108Z",
  },
  ...overrides,
});

describe("the projection", () => {
  it("drops the fields that are constant across every row", () => {
    const summary = summarize(row());
    // The 30.7% of the live response that carries no per-row information.
    expect(summary).not.toHaveProperty("thinkingLevels");
    expect(summary).not.toHaveProperty("thinkingOptions");
    expect(summary).not.toHaveProperty("agentRuntime");
    // The per-agent choice survives while the host's menu of choices does not.
    expect(summary.thinkingDefault).toBe("high");
  });

  it("keeps the product's own onboarding merge whole", () => {
    expect(summarize(row()).onboarding).toEqual({
      status: "applied",
      error: null,
      templateId: "073641d8-6a6e-49e3-b364-eda2c531bd49",
      templateName: "Cellar and Inventory Manager",
      custom: false,
      startedAt: null,
      appliedAt: "2026-09-23T16:12:13.108Z",
    });
  });

  it("reports a null onboarding as null rather than inventing a status", () => {
    expect(summarize(row({ onboarding: null })).onboarding).toBeNull();
  });

  it("flattens model to its primary", () => {
    expect(summarize(row()).model).toBe("anthropic/claude-opus-5");
    expect(summarize(row({ model: null })).model).toBeNull();
  });

  it("passes createdAt through as the epoch number the Gateway sends", () => {
    expect(summarize(row()).createdAt).toBe(1790179774225);
    // Not coerced from a string: reporting the product's shape, not fixing it.
    expect(summarize(row({ createdAt: "2026-09-23T16:12:13.108Z" })).createdAt).toBeNull();
  });

  it("survives a row missing the optional fields", () => {
    const sparse = summarize({ id: "bare" });
    expect(sparse.id).toBe("bare");
    expect(sparse.name).toBeNull();
    expect(sparse.identity).toBeNull();
    expect(sparse.workspaceGit).toBe(false);
  });
});

describe("the envelope", () => {
  it("returns the uniform list shape and nothing from the Gateway envelope", () => {
    const result = shape([row()]);
    expect(Object.keys(result).sort()).toEqual([
      "agents",
      "missingFromRoster",
      "total",
      "truncated",
    ]);
  });
});

describe("paging", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ id: `agent-${i}` }));

  it("states truncated rather than leaving it to be inferred", () => {
    const result = shape(rows, { limit: 2 });
    expect(result.agents).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated on the last page", () => {
    const result = shape(rows, { limit: 2, offset: 4 });
    expect(result.agents).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("rejects a limit above the ceiling", () => {
    expect(() => shape(rows, { limit: 201 })).toThrow(/limit must be an integer between 1 and 200/);
  });
});

describe("the project filter", () => {
  const rows = [row({ id: "alpha" }), row({ id: "beta" }), row({ id: "gamma" })];

  it("keeps only the project's members, in roster order", () => {
    const result = shape(rows, {}, ["gamma", "alpha"]);
    expect(result.agents.map((a) => a.id)).toEqual(["alpha", "gamma"]);
    expect(result.total).toBe(2);
    expect(result.missingFromRoster).toEqual([]);
  });

  it("names members the roster does not have instead of dropping them", () => {
    // The live case: a project still lists an agent that was renamed away.
    const result = shape(rows, {}, ["alpha", "singleinstinct-plugin-engineer"]);
    expect(result.agents.map((a) => a.id)).toEqual(["alpha"]);
    expect(result.missingFromRoster).toEqual(["singleinstinct-plugin-engineer"]);
  });

  it("holds the relationship the two verbs agree on", () => {
    const members = ["alpha", "ghost", "gamma"];
    const result = shape(rows, {}, members);
    const reconstructed = [...result.agents.map((a) => a.id), ...result.missingFromRoster];
    expect(reconstructed.sort()).toEqual([...members].sort());
  });

  it("keeps the shape byte-identical whether the filter is set or not", () => {
    expect(Object.keys(shape(rows)).sort()).toEqual(Object.keys(shape(rows, {}, ["alpha"])).sort());
  });

  it("counts total after filtering, not before", () => {
    expect(shape(rows, {}, ["alpha"]).total).toBe(1);
  });
});

describe("resolveProjectId", () => {
  it("accepts an absent id, because the filter is optional", () => {
    expect(resolveProjectId(undefined)).toBeUndefined();
    expect(resolveProjectId(null)).toBeUndefined();
  });

  it("rejects a non-UUID rather than letting it match nothing", () => {
    expect(() => resolveProjectId("joy-labs")).toThrow(/must be a UUID/);
    expect(() => resolveProjectId(7)).toThrow(/must be a UUID/);
  });

  it("accepts a UUID as the product mints them", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(resolveProjectId(id)).toBe(id);
  });
});

describe("memberIds", () => {
  it("fails an unknown project as not-found, not as an outage", () => {
    expect(() => memberIds([{ id: "other" }], "missing")).toThrow(ProjectNotFoundError);
    expect(() => memberIds([{ id: "other" }], "missing")).toThrow(/reported 1 projects/);
  });

  it("treats an absent agentIds as empty rather than throwing", () => {
    expect(memberIds([{ id: "p" }], "p")).toEqual([]);
  });

  it("keeps only string ids", () => {
    expect(memberIds([{ id: "p", agentIds: ["a", 3, null, "b"] }], "p")).toEqual(["a", "b"]);
  });
});

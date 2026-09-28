import { describe, expect, it } from "vitest";
import { ProjectNotFoundError, detail, resolveProjectId, select } from "./get-project.js";

const UUID_A = "16346028-c13c-4ad8-8e75-08a12ea61638";
const UUID_B = "1b0c89e5-be3a-4963-985e-ef2938c9cb58";

const project = (id: string, agentIds: string[] = []) => ({
  id,
  name: `project-${id}`,
  workingDirectory: `/tmp/${id}`,
  agentIds,
  createdAt: "2026-09-23T03:21:40.330Z",
});

describe("projection", () => {
  // The whole point of the verb: the collection list_projects counts.
  it("returns the full agentIds array rather than a count", () => {
    const shaped = detail(project(UUID_A, ["one", "two", "three"]));
    expect(shaped.agentIds).toEqual(["one", "two", "three"]);
    expect(shaped).not.toHaveProperty("agentCount");
  });

  it("carries the whole record, createdAt included", () => {
    expect(Object.keys(detail(project(UUID_A))).sort()).toEqual([
      "agentIds",
      "createdAt",
      "id",
      "name",
      "workingDirectory",
    ]);
  });

  it("tolerates a missing agentIds array rather than throwing", () => {
    expect(detail({ id: UUID_A, name: "a" }).agentIds).toEqual([]);
  });

  it("drops non-string entries rather than passing them through", () => {
    expect(detail({ id: UUID_A, agentIds: ["ok", 7, null] }).agentIds).toEqual(["ok"]);
  });

  it("normalises an absent working directory and createdAt to null", () => {
    const shaped = detail({ id: UUID_A, name: "a" });
    expect(shaped.workingDirectory).toBeNull();
    expect(shaped.createdAt).toBeNull();
  });
});

describe("selection", () => {
  const projects = [project(UUID_A, ["travel-agent"]), project(UUID_B)];

  it("selects the matching project", () => {
    expect(select(projects, UUID_B).id).toBe(UUID_B);
  });

  // A not-found and an outage call for different responses from a caller.
  it("fails as a not-found, distinct from a transport error", () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(() => select(projects, missing)).toThrow(ProjectNotFoundError);
    expect(() => select(projects, missing)).toThrow(new RegExp(`no project with id ${missing}`));
  });

  it("names how many projects the product reported, so an empty store reads clearly", () => {
    expect(() => select([], UUID_A)).toThrow(/reported 0 projects/);
  });
});

describe("input validation", () => {
  it.each([undefined, null, "", "not-a-uuid", 7, UUID_A.slice(0, -1)])(
    "rejects the project_id %s before spending a round trip",
    (projectId) => {
      expect(() => resolveProjectId(projectId)).toThrow(/project_id/);
    },
  );

  it("accepts a uuid as the product mints them, in either case", () => {
    expect(resolveProjectId(UUID_A)).toBe(UUID_A);
    expect(resolveProjectId(UUID_A.toUpperCase())).toBe(UUID_A.toUpperCase());
  });
});

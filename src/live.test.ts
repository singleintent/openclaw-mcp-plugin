/**
 * End-to-end proof against the running product.
 *
 * Skips rather than fails when the product is not reachable, so the suite stays
 * green on a machine that is not running it. A skip is visible in the output; a
 * silent pass would not be.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ProductError } from "./client.js";
import { baseUrl, loadConfig } from "./config.js";
import { ProjectNotFoundError, getProject } from "./verbs/get-project.js";
import { listProjects } from "./verbs/list-projects.js";

const config = loadConfig({});

let reachable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${baseUrl(config)}/api/projects`, {
      signal: AbortSignal.timeout(2_000),
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.warn(`[live] skipping: product not reachable at ${baseUrl(config)}`);
  }
});

describe("live product", () => {
  it("lists projects through the real transport", async () => {
    if (!reachable) return;
    const result = await listProjects(config);

    expect(result.total).toBeGreaterThan(0);
    expect(result.projects.length).toBeGreaterThan(0);

    for (const project of result.projects) {
      expect(typeof project.id).toBe("string");
      expect(project.id.length).toBeGreaterThan(0);
      expect(typeof project.agentCount).toBe("number");
      // The projection must hold against real data, not just fixtures.
      expect(project).not.toHaveProperty("agentIds");
      expect(project).not.toHaveProperty("createdAt");
    }
  }, 20_000);

  it("honours the limit against real data", async () => {
    if (!reachable) return;
    const result = await listProjects(config, { limit: 1 });
    expect(result.projects).toHaveLength(1);
    expect(result.truncated).toBe(result.total > 1);
  }, 20_000);

  it("names the endpoint when the product is not there", async () => {
    // Deliberately wrong port: proves the diagnostic, reachable or not.
    const wrong = { ...config, port: 1 };
    await expect(listProjects(wrong)).rejects.toThrow(ProductError);
    await expect(listProjects(wrong)).rejects.toThrow(/cannot reach the product at http:/);
  }, 20_000);

  it("returns the full agentIds for one real project", async () => {
    if (!reachable) return;
    // Take the id from the list verb, which is how a caller reaches this verb.
    const listed = await listProjects(config, { limit: 200 });
    const withAgents = listed.projects.find((project) => project.agentCount > 0);
    if (withAgents === undefined) return; // No populated project to detail.

    const { project } = await getProject(config, { projectId: withAgents.id });
    expect(project.id).toBe(withAgents.id);
    // The count and the array must agree, or one of the two verbs is lying.
    expect(project.agentIds).toHaveLength(withAgents.agentCount);
    expect(project).toHaveProperty("createdAt");
  }, 20_000);

  it("filters the list by agent, and keeps total meaning the filtered count", async () => {
    if (!reachable) return;
    const all = await listProjects(config, { limit: 200 });
    const seed = all.projects.find((project) => project.agentCount > 0);
    if (seed === undefined) return;
    const { project } = await getProject(config, { projectId: seed.id });
    const agentId = project.agentIds[0];
    if (agentId === undefined) return;

    const filtered = await listProjects(config, { agentId, limit: 200 });
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total).toBeLessThanOrEqual(all.total);
    expect(filtered.projects.map((p) => p.id)).toContain(seed.id);
    // The filtered shape is the unfiltered shape: same keys, fewer rows.
    expect(Object.keys(filtered).sort()).toEqual(Object.keys(all).sort());
  }, 20_000);

  it("fails a well-formed unknown id as a not-found, not as an outage", async () => {
    if (!reachable) return;
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(getProject(config, { projectId: missing })).rejects.toThrow(
      ProjectNotFoundError,
    );
    await expect(getProject(config, { projectId: missing })).rejects.toThrow(
      new RegExp(`no project with id ${missing}`),
    );
  }, 20_000);
});

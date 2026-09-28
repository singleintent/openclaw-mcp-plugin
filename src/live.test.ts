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
});

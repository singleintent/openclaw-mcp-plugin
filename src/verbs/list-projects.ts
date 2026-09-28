/**
 * `list_projects` — the first verb, and the one that sets the response-shaping
 * pattern for every list verb after it.
 *
 * The rule: bounded scalars pass through; unbounded collections do not, and are
 * replaced by a count. Measured against the live product, `GET /api/projects`
 * returns 11 projects carrying 46 agent ids between them, and the sibling agents
 * route returns 53 agents with full metadata in a single blob. Those arrays are
 * the part that grows without limit as the product grows, and an agent deciding
 * what to do next does not need them — it needs to know which projects exist and
 * how big they are. Anyone who wants the ids asks for agents directly.
 *
 * Pagination exists for the same reason. At 11 projects it changes nothing; the
 * point is that `total` and `truncated` cannot be added later without changing a
 * shape consumers already depend on.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The product's wire shape for a project. */
type ApiProject = {
  id?: unknown;
  name?: unknown;
  workingDirectory?: unknown;
  agentIds?: unknown;
};

/** What this verb returns per project. */
export type ProjectSummary = {
  id: string;
  name: string;
  workingDirectory: string | null;
  agentCount: number;
};

export type ListProjectsResult = {
  projects: ProjectSummary[];
  /** Projects the product reported, before any limit was applied. */
  total: number;
  /** True when `total` exceeded the limit and `projects` is a prefix. */
  truncated: boolean;
};

export type ListProjectsInput = {
  limit?: number;
  offset?: number;
};

export function resolveLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(
      `limit must be an integer between 1 and ${MAX_LIMIT}, got ${JSON.stringify(limit)}`,
    );
  }
  return value;
}

export function resolveOffset(offset: unknown): number {
  if (offset === undefined || offset === null) return 0;
  const value = typeof offset === "number" ? offset : Number(offset);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`offset must be an integer of 0 or more, got ${JSON.stringify(offset)}`);
  }
  return value;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function summarize(project: ApiProject): ProjectSummary {
  return {
    id: asString(project.id) ?? "",
    name: asString(project.name) ?? "",
    workingDirectory: asString(project.workingDirectory),
    // A count, not the array: this is the whole point of the projection.
    agentCount: Array.isArray(project.agentIds) ? project.agentIds.length : 0,
  };
}

export function shape(
  projects: ApiProject[],
  input: ListProjectsInput = {},
): ListProjectsResult {
  const limit = resolveLimit(input.limit);
  const offset = resolveOffset(input.offset);
  const page = projects.slice(offset, offset + limit);
  return {
    projects: page.map(summarize),
    total: projects.length,
    truncated: offset + page.length < projects.length,
  };
}

export async function listProjects(
  config: Config,
  input: ListProjectsInput = {},
  options: RequestOptions = {},
): Promise<ListProjectsResult> {
  // Validate before the request, so a bad limit does not cost a round trip.
  resolveLimit(input.limit);
  resolveOffset(input.offset);
  const projects = await getJson<ApiProject[]>(config, "/api/projects", options);
  if (!Array.isArray(projects)) {
    throw new Error("the product returned a non-array response for /api/projects");
  }
  return shape(projects, input);
}

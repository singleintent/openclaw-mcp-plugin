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
 *
 * ## The `agentId` filter, and why it is a filter rather than a field selector
 *
 * "Which project is this agent in?" is the question that prompted this work, and
 * the answer is a **list** — on live data `travel-agent` belongs to both `mob2`
 * and `Personal`, so a detail verb keyed on one project cannot answer it either.
 *
 * A field selector was rejected and this is deliberately not one. A selector
 * changes *which fields* come back, making the response shape conditional on
 * arguments — harder to document, cache and reason about at the call site. A
 * filter changes *which rows*, and the shape is byte-identical whether it is set
 * or not. A third verb was rejected for the opposite reason: it would return the
 * same shape this verb already returns.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * OpenClaw's own agent-id pattern, which the product mirrors in
 * `lib/joylabs-ids.js` as `AGENT_ID_RE`. Every id the Gateway can mint passes.
 *
 * That path carries a retired name because it is the product repo's real, current
 * filename and that repo has not been renamed; see the note in
 * `src/verbs/get-project.ts` before "fixing" it.
 *
 * Validated rather than passed through because the failure mode of not checking
 * is the one this repo consistently refuses: a structurally impossible id would
 * quietly match nothing and return an empty list that reads as a real answer.
 * A well-formed id matching no project still returns empty, because that is the
 * truthful answer.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
  /**
   * Matching projects before any limit was applied — so when `agentId` is set
   * this is the count **after** filtering, not the number of projects that
   * exist. A caller that assumed otherwise would read a filtered total as an
   * inventory, which is why the tool description says so too.
   */
  total: number;
  /** True when `total` exceeded the limit and `projects` is a prefix. */
  truncated: boolean;
};

export type ListProjectsInput = {
  limit?: number;
  offset?: number;
  /** When set, keep only projects whose `agentIds` contains it. */
  agentId?: unknown;
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

export function resolveAgentId(agentId: unknown): string | undefined {
  if (agentId === undefined || agentId === null) return undefined;
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `agent_id must be an agent id as the Gateway mints them, got ${JSON.stringify(agentId)}`,
    );
  }
  return agentId;
}

/** Membership test against the raw wire shape, before the count replaces it. */
const hasAgent = (project: ApiProject, agentId: string): boolean =>
  Array.isArray(project.agentIds) && project.agentIds.includes(agentId);

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
  const agentId = resolveAgentId(input.agentId);
  // Filter, then page. The other order would page an unfiltered list and then
  // thin the page, so a caller would see short pages and a `total` that no
  // amount of paging could reach.
  const matching =
    agentId === undefined ? projects : projects.filter((project) => hasAgent(project, agentId));
  const page = matching.slice(offset, offset + limit);
  return {
    projects: page.map(summarize),
    total: matching.length,
    truncated: offset + page.length < matching.length,
  };
}

export async function listProjects(
  config: Config,
  input: ListProjectsInput = {},
  options: RequestOptions = {},
): Promise<ListProjectsResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  resolveLimit(input.limit);
  resolveOffset(input.offset);
  resolveAgentId(input.agentId);
  const projects = await getJson<ApiProject[]>(config, "/api/projects", options);
  if (!Array.isArray(projects)) {
    throw new Error("the product returned a non-array response for /api/projects");
  }
  return shape(projects, input);
}

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
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  asString,
  assertPageInput,
  paginate,
  resolveAgentId,
  resolveLimit,
  resolveOffset,
} from "./paging.js";

/**
 * Re-exported rather than redefined. The paging contract moved to `paging.ts`
 * when the second list verb landed, so that "every list verb matches
 * `list_projects`" is enforced by one implementation instead of asserted about
 * five. These names stay exported here because they were part of this module's
 * surface first.
 */
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  resolveAgentId,
  resolveLimit,
  resolveOffset,
};

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

/** Membership test against the raw wire shape, before the count replaces it. */
const hasAgent = (project: ApiProject, agentId: string): boolean =>
  Array.isArray(project.agentIds) && project.agentIds.includes(agentId);

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
  const agentId = resolveAgentId(input.agentId);
  // Filter, then page. The other order would page an unfiltered list and then
  // thin the page, so a caller would see short pages and a `total` that no
  // amount of paging could reach.
  const matching =
    agentId === undefined ? projects : projects.filter((project) => hasAgent(project, agentId));
  const page = paginate(matching, input);
  return {
    projects: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
  };
}

export async function listProjects(
  config: Config,
  input: ListProjectsInput = {},
  options: RequestOptions = {},
): Promise<ListProjectsResult> {
  // Validate before the request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  resolveAgentId(input.agentId);
  const projects = await getJson<ApiProject[]>(config, "/api/projects", options);
  if (!Array.isArray(projects)) {
    throw new Error("the product returned a non-array response for /api/projects");
  }
  return shape(projects, input);
}

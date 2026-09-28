/**
 * `get_project` — the detail verb `list_projects` made necessary.
 *
 * `list_projects` replaces `agentIds` with `agentCount` under the shaping rule
 * (bounded scalars pass through; unbounded collections become counts). That
 * leaves "who is in project X" unanswerable, so a detail verb is an obligation
 * rather than an option. The boundary between the two: **a list verb carries
 * identity plus size; a detail verb carries the whole record.** `createdAt` is
 * dropped from the summary for signal-per-byte and kept here for that reason.
 *
 * ## Why this selects from the list rather than fetching a detail route
 *
 * The product has no per-project route. `web/server.mjs` matches `/api/projects`
 * for GET and POST only, and `GET /api/projects/<uuid>` answers 404 — verified
 * against the running product, not inferred. `lib/joylabs-projects.js` does
 * export `getProject(id)`, but it is internal and never routed.
 *
 * So the one round trip this verb makes is to `/api/projects`, and the selection
 * happens here. If a detail route lands later, the swap is confined to
 * `getProject()` below: replace the list fetch and the `select` call with a fetch
 * of the new path, and keep `detail()` and the not-found behaviour as they are.
 * This note exists so that swap is obvious rather than archaeological.
 *
 * **On the retired name in the paths above and below.** `lib/joylabs-*.js` is not
 * a stale reference to fix: those are the product repo's real, current filenames,
 * and that repo has not been renamed even though this plugin's brand was. The
 * retired-name guard in `src/mcp-server.test.ts` deliberately scopes to this
 * plugin's own identity — package, manifest id, env prefix — rather than to
 * truthful citations of another repository. Do not vague these out.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";

/**
 * The product's own project-id pattern (`lib/joylabs-ids.js`). Project ids are
 * always `randomUUID()`, and the product's `assertProjectId` rejects anything
 * else before it can reach a file path.
 */
const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A well-formed id that matches no project. Distinct from `ProductError` on
 * purpose: "no such project" and "the product is unreachable" call for different
 * responses from a caller, and collapsing them into one type makes a typo look
 * like an outage.
 */
export class ProjectNotFoundError extends Error {}

/** The product's wire shape for a project — all five fields it stores. */
type ApiProject = {
  id?: unknown;
  name?: unknown;
  workingDirectory?: unknown;
  agentIds?: unknown;
  createdAt?: unknown;
};

/** The whole record, which is what a detail verb owes its caller. */
export type ProjectDetail = {
  id: string;
  name: string;
  workingDirectory: string | null;
  /**
   * Passed through uncapped. This collection is the reason the verb exists, so
   * counting it here would leave the question unanswered again. If it ever needs
   * paging that is a separate verb, not a shape conditional on arguments.
   */
  agentIds: string[];
  createdAt: string | null;
};

export type GetProjectResult = {
  /**
   * Wrapped rather than returned flat, so a sibling field can be added without
   * changing a shape consumers already depend on — the same reasoning that put
   * `total` and `truncated` alongside `projects` in `list_projects`.
   */
  project: ProjectDetail;
};

export type GetProjectInput = {
  projectId?: unknown;
};

export function resolveProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error(`project_id is required, got ${JSON.stringify(projectId)}`);
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `project_id must be a UUID as the product mints them, got ${JSON.stringify(projectId)}`,
    );
  }
  return projectId;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function detail(project: ApiProject): ProjectDetail {
  return {
    id: asString(project.id) ?? "",
    name: asString(project.name) ?? "",
    workingDirectory: asString(project.workingDirectory),
    // Tolerate an absent or malformed array rather than throwing: a project
    // written before the field existed is a real possibility in a flat-file
    // store, and an empty list is the truthful answer for it.
    agentIds: Array.isArray(project.agentIds)
      ? project.agentIds.filter((id): id is string => typeof id === "string")
      : [],
    createdAt: asString(project.createdAt),
  };
}

export function select(projects: ApiProject[], projectId: string): ProjectDetail {
  const found = projects.find((project) => project.id === projectId);
  if (found === undefined) {
    // Name the id. A caller holding a stale id needs to see which one failed,
    // and needs to be able to tell this apart from the product being down —
    // the same provenance habit the config diagnostics follow.
    throw new ProjectNotFoundError(
      `no project with id ${projectId} (the product reported ${projects.length} projects)`,
    );
  }
  return detail(found);
}

export async function getProject(
  config: Config,
  input: GetProjectInput = {},
  options: RequestOptions = {},
): Promise<GetProjectResult> {
  // Validate before the request, so a malformed id does not cost a round trip.
  const projectId = resolveProjectId(input.projectId);
  const projects = await getJson<ApiProject[]>(config, "/api/projects", options);
  if (!Array.isArray(projects)) {
    throw new Error("the product returned a non-array response for /api/projects");
  }
  return { project: select(projects, projectId) };
}

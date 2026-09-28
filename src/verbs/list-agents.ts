/**
 * `list_agents` — the widest response in the product, and therefore the verb that
 * settles the projection rule for every list verb after it.
 *
 * `GET /api/agents` proxies the Gateway's `agents.list` and then merges an
 * `onboarding` block into every row (`web/server.mjs:614`), so each row is a full
 * Gateway agent record *plus* the product's own onboarding status. Measured live:
 * 53 rows, 53,688 bytes.
 *
 * ## What the projection drops, and why
 *
 * `list_projects` stated the rule as *bounded scalars pass through; unbounded
 * collections become counts*. This response does not fit that rule cleanly, and
 * the misfit is informative — it forces one extension and one clarification.
 *
 * **Dropped outright: `thinkingLevels`, `thinkingOptions`, `agentRuntime`.**
 * Measured on the live roster, all three are byte-identical across all 53 rows,
 * and `thinkingLevels` + `thinkingOptions` alone are 16,483 bytes — **30.7% of
 * the entire response** — carrying zero per-row information. This is the
 * extension: the rule's remedy for an unbounded collection is to replace it with
 * a count, because its *size* is the part worth keeping. These are not that.
 * They are a fixed capability enumeration describing what the host supports, the
 * same eight values every time, so their count is the constant 8 and a count
 * would be as useless as the array. A field that is constant across rows belongs
 * to the host, not to the row, and a per-row listing is the wrong place to carry
 * it. Dropped, not counted.
 *
 * `thinkingDefault` is kept, and the pairing is the point: the *levels available*
 * are the host's, the *level chosen* is the agent's.
 *
 * **Dropped: the response envelope.** The route returns
 * `{ defaultId, ownership, selectionRequired, mainKey, scope, agents }`. Those
 * five are bounded scalars, so the rule as written would pass them through. They
 * are dropped anyway, which is the clarification: they describe the Gateway's
 * agent-*selection* policy — which agent answers an unaddressed message — and
 * this verb answers "which agents exist". A caller who needs selection policy is
 * asking the Gateway a different question, and should not have it smuggled in
 * here under a name that does not say so. Keeping them would also break the
 * `{ rows, total, truncated }` shape every other list verb returns.
 *
 * **Kept whole: `onboarding`.** Seven bounded fields, and it is the entire reason
 * this route exists rather than a direct Gateway call. Dropping the product's own
 * contribution to a product route would be the one indefensible cut.
 *
 * **Kept: `identity`.** Three bounded fields (`name`, `theme`, `emoji`), 3.2% of
 * the response. `theme` is the one-line statement of what an agent is for — the
 * highest signal-per-byte field on the row.
 *
 * ## Two shapes the product hands over that are worth naming
 *
 * `createdAt` here is **epoch milliseconds**, a number. On `/api/projects` the
 * field of the same name is an ISO-8601 string. Passed through as-is rather than
 * normalised: this connector reports what the product stores, and inventing a
 * consistency the product does not have would misrepresent it. The tool
 * description says so, because a caller comparing the two fields across verbs is
 * the obvious way to get burned.
 *
 * `model` arrives as `{ primary: string }` — verified as exactly that key on all
 * 53 live rows, no others — and is flattened to the string. If the Gateway ever
 * adds a sibling (`fallback`, say), this flattening starts losing it silently,
 * so `agentModel()` below is the single place that changes.
 *
 * ## Why `project_id` filters here rather than on the server
 *
 * Every product route is an exact-string match on `req.url` with no query
 * parsing, so a query parameter would be accepted, ignored, and return the
 * unfiltered list looking like a successful filter. The filter is therefore
 * local, and it costs a second request — to `/api/projects`, for the project's
 * `agentIds`.
 *
 * Reading membership from `/api/projects` rather than from anything on the agent
 * row is deliberate: it is the same source `get_project` reads, so the two verbs
 * cannot disagree about membership by construction. They can still disagree about
 * *existence*, which is the next paragraph.
 */
import { getJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import {
  PROJECT_ID_RE,
  asString,
  assertPageInput,
  paginate,
  type PageInput,
} from "./paging.js";

/** Mirrors `get-project.ts`: a stale id is not an outage and must not read as one. */
export class ProjectNotFoundError extends Error {}

/** The Gateway's wire shape for an agent row, after the product's merge. */
type ApiAgent = {
  id?: unknown;
  name?: unknown;
  identity?: unknown;
  workspace?: unknown;
  workspaceGit?: unknown;
  model?: unknown;
  utilityModel?: unknown;
  thinkingDefault?: unknown;
  defaultPermissionMode?: unknown;
  createdVia?: unknown;
  creatorAgentId?: unknown;
  createdAt?: unknown;
  onboarding?: unknown;
};

type ApiProject = { id?: unknown; agentIds?: unknown };

export type AgentIdentity = {
  name: string | null;
  /** The one-line statement of what this agent is for. */
  theme: string | null;
  emoji: string | null;
};

export type AgentOnboarding = {
  status: string | null;
  error: string | null;
  templateId: string | null;
  templateName: string | null;
  custom: boolean;
  startedAt: string | null;
  appliedAt: string | null;
};

export type AgentSummary = {
  id: string;
  name: string | null;
  identity: AgentIdentity | null;
  workspace: string | null;
  workspaceGit: boolean;
  /** `model.primary`, flattened. See the note on `agentModel` above. */
  model: string | null;
  utilityModel: string | null;
  thinkingDefault: string | null;
  defaultPermissionMode: string | null;
  createdVia: string | null;
  creatorAgentId: string | null;
  /** Epoch milliseconds — *not* the ISO string `/api/projects` uses. */
  createdAt: number | null;
  /** The product's own merge; null when the agent has no role applied. */
  onboarding: AgentOnboarding | null;
};

export type ListAgentsResult = {
  agents: AgentSummary[];
  /** Matching rows before the limit — post-filter when `project_id` is set. */
  total: number;
  truncated: boolean;
  /**
   * Agent ids the project claims that the roster does not contain.
   *
   * This is not hypothetical. On the live product, project
   * `singleinstinct-openclaw-mcp-plugin` lists `singleinstinct-plugin-engineer`,
   * an agent renamed out of existence — so `get_project` reports one member and
   * the roster has none. Returning only the matched rows would make the two verbs
   * silently disagree about membership; naming the gap makes them agree on a
   * larger truth, and the relationship a caller can rely on is:
   *
   *     get_project(id).agentIds  ==  agents[].id  ∪  missingFromRoster
   *
   * Always present, `[]` when no filter is set, so the response shape is
   * byte-identical whether `project_id` is passed or not — the same reason
   * `list_projects` made its lookup a row filter rather than a field selector.
   */
  missingFromRoster: string[];
};

export type ListAgentsInput = PageInput & {
  /** When set, keep only agents the named project lists as members. */
  projectId?: unknown;
};

export function resolveProjectId(projectId: unknown): string | undefined {
  if (projectId === undefined || projectId === null) return undefined;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `project_id must be a UUID as the product mints them, got ${JSON.stringify(projectId)}`,
    );
  }
  return projectId;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The single place the `{ primary }` assumption lives. */
function agentModel(model: unknown): string | null {
  const record = asRecord(model);
  if (record === null) return asString(model);
  return asString(record.primary);
}

function identity(value: unknown): AgentIdentity | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    name: asString(record.name),
    theme: asString(record.theme),
    emoji: asString(record.emoji),
  };
}

function onboarding(value: unknown): AgentOnboarding | null {
  // Null is a real, common state — 15 of 53 live rows — meaning no role applied.
  const record = asRecord(value);
  if (record === null) return null;
  return {
    status: asString(record.status),
    error: asString(record.error),
    templateId: asString(record.templateId),
    templateName: asString(record.templateName),
    custom: record.custom === true,
    startedAt: asString(record.startedAt),
    appliedAt: asString(record.appliedAt),
  };
}

export function summarize(agent: ApiAgent): AgentSummary {
  return {
    id: asString(agent.id) ?? "",
    name: asString(agent.name),
    identity: identity(agent.identity),
    workspace: asString(agent.workspace),
    workspaceGit: agent.workspaceGit === true,
    model: agentModel(agent.model),
    utilityModel: asString(agent.utilityModel),
    thinkingDefault: asString(agent.thinkingDefault),
    defaultPermissionMode: asString(agent.defaultPermissionMode),
    createdVia: asString(agent.createdVia),
    creatorAgentId: asString(agent.creatorAgentId),
    createdAt: typeof agent.createdAt === "number" ? agent.createdAt : null,
    onboarding: onboarding(agent.onboarding),
  };
}

/** The member ids a project claims, tolerating an absent or malformed array. */
export function memberIds(projects: ApiProject[], projectId: string): string[] {
  const found = projects.find((project) => project.id === projectId);
  if (found === undefined) {
    throw new ProjectNotFoundError(
      `no project with id ${projectId} (the product reported ${projects.length} projects)`,
    );
  }
  return Array.isArray(found.agentIds)
    ? found.agentIds.filter((id): id is string => typeof id === "string")
    : [];
}

export function shape(
  agents: ApiAgent[],
  input: ListAgentsInput = {},
  members?: string[],
): ListAgentsResult {
  let matching = agents;
  let missingFromRoster: string[] = [];

  if (members !== undefined) {
    const wanted = new Set(members);
    // Preserve roster order rather than the project's id order: the roster is the
    // stable ordering, and the project file's array order is an artefact of the
    // order members happened to be added.
    matching = agents.filter((agent) => typeof agent.id === "string" && wanted.has(agent.id));
    const present = new Set(matching.map((agent) => agent.id as string));
    missingFromRoster = members.filter((id) => !present.has(id));
  }

  // Filter first, then page — see `paginate`.
  const page = paginate(matching, input);
  return {
    agents: page.rows.map(summarize),
    total: page.total,
    truncated: page.truncated,
    missingFromRoster,
  };
}

export async function listAgents(
  config: Config,
  input: ListAgentsInput = {},
  options: RequestOptions = {},
): Promise<ListAgentsResult> {
  // Validate before any request, so a bad argument does not cost a round trip.
  assertPageInput(input);
  const projectId = resolveProjectId(input.projectId);

  // Sequential rather than parallel on purpose: when a project id is wrong, the
  // caller should get "no such project" without also having waited on — and
  // possibly failed against — the Gateway-backed roster behind it.
  let members: string[] | undefined;
  if (projectId !== undefined) {
    const projects = await getJson<ApiProject[]>(config, "/api/projects", options);
    if (!Array.isArray(projects)) {
      throw new Error("the product returned a non-array response for /api/projects");
    }
    members = memberIds(projects, projectId);
  }

  const payload = await getJson<{ agents?: unknown }>(config, "/api/agents", options);
  const agents = asRecord(payload)?.agents;
  if (!Array.isArray(agents)) {
    throw new Error("the product returned no agents array for /api/agents");
  }
  return shape(agents as ApiAgent[], input, members);
}

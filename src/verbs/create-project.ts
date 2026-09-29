/**
 * `create_project` — `POST /api/projects` (`web/server.mjs:601`).
 *
 * The simplest write there is: two fields in, the created record out, including
 * the `id` the product assigned. That id is the point of the call — every other
 * verb that takes a `project_id` takes this one.
 *
 * ## The projection returns everything, and that is the rule's output here
 *
 * Five fields, all bounded scalars except `agentIds`, which on a new project is
 * always `[]`. Nothing to count and nothing to truncate, so the record passes
 * through whole — the same outcome as `list_connections` and for the same reason.
 * A create verb that withheld the id would answer nothing.
 *
 * ## Both fields are required here because both are required there
 *
 * The product refuses a missing `name` or `workingDirectory`. A schema that let a
 * caller omit one would turn a clear local refusal into a round trip ending in a
 * bare `400`.
 *
 * `workingDirectory` is **recorded, not resolved**. The product does not create
 * the directory, does not check that it exists, and does not make a relative path
 * absolute. A typo is stored as a typo, and it surfaces later as an agent whose
 * workspace points somewhere wrong rather than as an error now. That is the
 * product's behaviour and this verb does not paper over it; the argument
 * description says so, which is the only place a caller will read it in time.
 */
import { sendJson, type RequestOptions } from "../client.js";
import type { Config } from "../config.js";
import { asString } from "./paging.js";
import { requireFilledText } from "./write-args.js";

/** The product's wire shape for a project — all five fields it stores. */
type ApiProject = {
  id?: unknown;
  name?: unknown;
  workingDirectory?: unknown;
  agentIds?: unknown;
  createdAt?: unknown;
};

export type CreatedProject = {
  /** The id the product assigned. Every `project_id` argument takes this. */
  id: string;
  name: string;
  workingDirectory: string | null;
  /** Always empty on a new project; a project starts with no members. */
  agentIds: string[];
  createdAt: string | null;
};

export type CreateProjectResult = {
  /** Wrapped, matching `get_project`, so a sibling field can be added later. */
  project: CreatedProject;
};

export type CreateProjectInput = {
  name?: unknown;
  workingDirectory?: unknown;
};

export function detail(project: ApiProject): CreatedProject {
  return {
    id: asString(project.id) ?? "",
    name: asString(project.name) ?? "",
    workingDirectory: asString(project.workingDirectory),
    agentIds: Array.isArray(project.agentIds)
      ? project.agentIds.filter((id): id is string => typeof id === "string")
      : [],
    createdAt: asString(project.createdAt),
  };
}

export async function createProject(
  config: Config,
  input: CreateProjectInput = {},
  options: RequestOptions = {},
): Promise<CreateProjectResult> {
  // Validate before the request, so a bad argument costs no write attempt.
  const body = {
    name: requireFilledText(input.name, "name"),
    workingDirectory: requireFilledText(input.workingDirectory, "working_directory"),
  };
  const project = await sendJson<ApiProject>(config, "POST", "/api/projects", body, options);
  if (project === null || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("the product returned a non-object response for POST /api/projects");
  }
  return { project: detail(project) };
}

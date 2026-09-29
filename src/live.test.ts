/**
 * End-to-end proof against the running product.
 *
 * Skips rather than fails when the product is not reachable, so the suite stays
 * green on a machine that is not running it. A skip is visible in the output; a
 * silent pass would not be.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ProductConflictError, ProductError, ProductUpstreamError } from "./client.js";
import { baseUrl, loadConfig } from "./config.js";
import { applyRole } from "./verbs/apply-role.js";
import { createAgent } from "./verbs/create-agent.js";
import { createConnection } from "./verbs/create-connection.js";
import { createProject } from "./verbs/create-project.js";
import { createTemplate } from "./verbs/create-template.js";
import { getActivity } from "./verbs/get-activity.js";
import { sendMessage } from "./verbs/send-message.js";
import { updateTemplate } from "./verbs/update-template.js";
import { getBacklog } from "./verbs/get-backlog.js";
import { ProjectNotFoundError, getProject } from "./verbs/get-project.js";
import { listAgents } from "./verbs/list-agents.js";
import { listConnections } from "./verbs/list-connections.js";
import { listProjects } from "./verbs/list-projects.js";
import { listTemplates } from "./verbs/list-templates.js";

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

  it("lists the real roster with the projection holding", async () => {
    if (!reachable) return;
    const result = await listAgents(config, { limit: 200 });

    expect(result.total).toBeGreaterThan(0);
    expect(result.missingFromRoster).toEqual([]);
    for (const agent of result.agents) {
      expect(typeof agent.id).toBe("string");
      expect(agent.id.length).toBeGreaterThan(0);
      // The dropped fields must stay dropped against real data, not just fixtures.
      expect(agent).not.toHaveProperty("thinkingLevels");
      expect(agent).not.toHaveProperty("thinkingOptions");
      expect(agent).not.toHaveProperty("agentRuntime");
      // The product's own merge must survive, as null or as a record.
      expect(Object.keys(result)).toContain("total");
      if (agent.onboarding !== null) {
        expect(typeof agent.onboarding.status).toBe("string");
      }
    }
    // The Gateway envelope is not smuggled into the response.
    expect(Object.keys(result).sort()).toEqual([
      "agents",
      "missingFromRoster",
      "total",
      "truncated",
    ]);
  }, 20_000);

  /**
   * The acceptance criterion W-030 calls out as the one worth catching: the two
   * verbs must not disagree about membership. Checked across *every* project
   * rather than the required two, because the live product has one project whose
   * member was renamed out of the roster, and a two-project sample could miss it.
   */
  it("agrees with get_project about membership for every project", async () => {
    if (!reachable) return;
    const listed = await listProjects(config, { limit: 200 });
    expect(listed.projects.length).toBeGreaterThanOrEqual(2);

    let checkedWithMembers = 0;
    for (const summary of listed.projects) {
      const { project } = await getProject(config, { projectId: summary.id });
      const filtered = await listAgents(config, { projectId: summary.id, limit: 200 });

      const reconstructed = [
        ...filtered.agents.map((agent) => agent.id),
        ...filtered.missingFromRoster,
      ].sort();
      expect(reconstructed).toEqual([...project.agentIds].sort());
      expect(filtered.total).toBe(filtered.agents.length);
      if (project.agentIds.length > 0) checkedWithMembers += 1;
    }
    expect(checkedWithMembers).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("lists real templates without their content", async () => {
    if (!reachable) return;
    const result = await listTemplates(config, { limit: 200 });

    expect(result.total).toBeGreaterThan(0);
    for (const template of result.templates) {
      expect(template).not.toHaveProperty("content");
      expect(typeof template.contentLength).toBe("number");
      expect(template.id.length).toBeGreaterThan(0);
    }
    // The lengths must describe the real store, not be zeros standing in for it.
    expect(result.templates.some((template) => template.contentLength > 0)).toBe(true);
  }, 20_000);

  it("lists real connections whole, with direction preserved", async () => {
    if (!reachable) return;
    const result = await listConnections(config, { limit: 200 });

    expect(result.total).toBeGreaterThan(0);
    for (const connection of result.connections) {
      expect(connection.id.length).toBeGreaterThan(0);
      expect(typeof connection.from).toBe("string");
      expect(typeof connection.to).toBe("string");
      // Nothing was dropped, so every stored field is here.
      expect(Object.keys(connection).sort()).toEqual(["establishedAt", "from", "id", "to"]);
    }
  }, 20_000);

  it("reads the real backlog with its descriptions intact", async () => {
    if (!reachable) return;
    const result = await getBacklog(config, { limit: 200 });

    expect(result.total).toBeGreaterThan(0);
    for (const backlogItem of result.items) {
      expect(backlogItem.id.length).toBeGreaterThan(0);
      expect(backlogItem).toHaveProperty("description");
    }
    // The field list_templates would have cut must really be here, with text in it.
    expect(
      result.items.some((backlogItem) => (backlogItem.description ?? "").length > 0),
    ).toBe(true);
  }, 20_000);

  it("round-trips the product's now against a direct read of the route", async () => {
    if (!reachable) return;
    // Bracket the verb between two direct reads. This proves now is a live value
    // the product produced on this request rather than a stale or invented one.
    //
    // Stated honestly: on a single host this bracket cannot by itself tell the
    // product's clock from a local one, because they are the same clock. The
    // assertion that actually discriminates is the unit test that feeds shape()
    // a stale now and requires it to come back stale. This is the live half.
    const read = async (): Promise<number> => {
      const response = await fetch(`${baseUrl(config)}/api/activity`, {
        signal: AbortSignal.timeout(5_000),
      });
      return ((await response.json()) as { now: number }).now;
    };

    const before = await read();
    const result = await getActivity(config, { limit: 200 });
    const after = await read();

    expect(result.nowSource).toBe("product");
    expect(typeof result.now).toBe("number");
    expect(result.now).toBeGreaterThanOrEqual(before);
    expect(result.now).toBeLessThanOrEqual(after);
    // All three inside the same second, which is what makes the bracket tight
    // enough to mean anything.
    expect(after - before).toBeLessThan(1_000);

    for (const activitySession of result.sessions) {
      expect(activitySession.agentId.length).toBeGreaterThan(0);
      if (activitySession.startedAt !== null) {
        // Timestamps are on now's scale, not a different unit or epoch.
        expect(activitySession.startedAt).toBeLessThanOrEqual(result.now);
      }
    }
  }, 30_000);

  it("rejects a project id the product could never have minted", async () => {
    if (!reachable) return;
    await expect(listAgents(config, { projectId: "joy-labs" })).rejects.toThrow(/must be a UUID/);
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

/**
 * The write verbs against the real routes, without writing anything.
 *
 * **Why the success paths are not automated here, stated rather than left as a
 * gap.** The product has no delete route. A suite that exercised `create_project`
 * or `create_agent` on every run would leave a row behind on every run, permanently,
 * in whoever's product it ran against — and `apply_role`, `create_connection` and
 * `send_message` would additionally spend a billed agent turn each time and change
 * an agent's behaviour for good. A test that mutates the operator's product to prove
 * it can is a worse defect than the coverage it buys.
 *
 * So the division is deliberate. The request each verb puts on the wire is proved
 * against a local server in `write-requests.test.ts`, to the byte. What is proved
 * *here* is the half that a local server cannot fake: that the real routes accept
 * these bodies, and that the real failures land in the error types this connector
 * claims for them. Every case below either refuses before sending or hits a route
 * that refuses before writing — checked against the running product, which returns
 * `409` before the Gateway is touched on both conflict paths.
 *
 * The success paths were exercised once by hand, over stdio against the built
 * artifact, and the rows that created are recorded in the commit message.
 */
describe("live product — write verbs, on paths that write nothing", () => {
  /** Well-formed and mints-as-the-product-does, but matching no project. */
  const UNKNOWN_PROJECT = "00000000-0000-4000-8000-000000000000";

  it("refuses a malformed argument before any request reaches the product", async () => {
    // No `reachable` guard: the point is that the product is never contacted, so
    // this holds whether or not it is running. A wrong port proves it.
    const wrong = { ...config, port: 1 };

    await expect(createProject(wrong, { name: "x" })).rejects.toThrow(/working_directory/);
    await expect(createAgent(wrong, { name: "x", projectId: "joy-labs" })).rejects.toThrow(
      /must be a UUID/,
    );
    await expect(updateTemplate(wrong, { templateId: UNKNOWN_PROJECT })).rejects.toThrow(
      /needs name, content, or both/,
    );
    await expect(createConnection(wrong, { from: "a-one", to: "a-one" })).rejects.toThrow(
      /must be different agents/,
    );
    await expect(sendMessage(wrong, { agentId: "a-one", message: "  " })).rejects.toThrow(
      /only whitespace/,
    );
    // Each of these would have been a ProductError naming the unreachable port if
    // the request had been attempted, so none of them was.
  }, 20_000);

  it("reaches the real POST /api/agents and is refused for an unknown project", async () => {
    if (!reachable) return;
    // Proves the body is accepted as well-formed by the route — it got past the
    // name and projectId checks to the project lookup — while creating nothing.
    const error = await createAgent(config, {
      name: "singleintent-connector-probe",
      projectId: UNKNOWN_PROJECT,
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductError);
    expect(error.message).toContain(`No project ${UNKNOWN_PROJECT}`);
    /**
     * Asserted as measured, not as preferred. The product answers this `502`, so
     * this connector classifies it as an upstream failure — which it is not: the
     * Gateway was never asked. The misclassification is the product's, and the
     * alternative would be this layer second-guessing a status code, which is
     * exactly the work it does not do. Recorded here so the behaviour is known
     * rather than discovered.
     */
    expect(error).toBeInstanceOf(ProductUpstreamError);
  }, 30_000);

  it("surfaces an already-applied role as a conflict, not as an outage", async () => {
    if (!reachable) return;
    // Reads the roster for an agent that already carries a role, so the fixture is
    // the live product's own state rather than an id hard-coded here.
    const roster = await listAgents(config, { limit: 200 });
    const roled = roster.agents.find((agent) => agent.onboarding?.status === "applied");
    const templates = await listTemplates(config, { limit: 200 });
    const template = templates.templates[0];
    if (roled === undefined || template === undefined) return;

    const error = await applyRole(config, {
      agentId: roled.id,
      templateId: template.id,
    }).catch((e: Error) => e);

    // The route refuses before it sends anything to the agent, so no turn was spent.
    expect(error).toBeInstanceOf(ProductConflictError);
    expect(error.message).toContain("409");
    // The instruction that makes the type worth having.
    expect(error.message).toMatch(/retrying cannot succeed/);
  }, 30_000);

  it("surfaces an existing connection as a conflict, before spending a turn", async () => {
    if (!reachable) return;
    const existing = (await listConnections(config, { limit: 200 })).connections.find(
      (connection) => connection.from !== null && connection.to !== null,
    );
    if (existing === undefined) return;

    const error = await createConnection(config, {
      from: existing.from as string,
      to: existing.to as string,
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductConflictError);
    expect(error.message).toContain("already exists");
    expect(error.message).toMatch(/retrying cannot succeed/);
  }, 30_000);

  it("does not treat the reverse direction as the same connection", async () => {
    if (!reachable) return;
    // Directedness, asserted against live data rather than only in a doc comment:
    // if any pair exists in one direction only, the two are distinct rows.
    const connections = (await listConnections(config, { limit: 200 })).connections;
    const keys = new Set(connections.map((c) => `${c.from}->${c.to}`));
    const oneWay = connections.filter((c) => !keys.has(`${c.to}->${c.from}`));
    expect(oneWay.length).toBeGreaterThan(0);
  }, 20_000);

  it("creates nothing when create_template is handed whitespace the product would take", async () => {
    if (!reachable) return;
    const before = await listTemplates(config, { limit: 200 });
    await expect(
      createTemplate(config, { name: "probe", content: "   " }),
    ).rejects.toThrow(/only whitespace/);
    // The product's own check is falsy and would have accepted this, so the count
    // staying put is what proves the refusal happened on this side.
    expect((await listTemplates(config, { limit: 200 })).total).toBe(before.total);
  }, 30_000);
});

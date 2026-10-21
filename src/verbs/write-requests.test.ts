/**
 * What each write verb puts on the wire.
 *
 * This is the file that holds the governing rule to account: a write verb is
 * argument validation plus one request. So every case here asserts the request —
 * method, path, body — against a real server rather than a mocked `fetch`, and the
 * count of requests is asserted too, because "one call" is half of the rule and the
 * half that a convenience refactor would quietly break.
 *
 * The two assertions with the most leverage:
 *
 * - **`update_template` sends omitted fields as absent, not as null.** The product
 *   applies each field only when it is not undefined, so an omitted argument that
 *   arrived as `null` would overwrite rather than leave alone. That is a silent
 *   destructive bug: the call succeeds, the response looks right, and the other
 *   field has been erased. The test reads the raw body text, because a parsed body
 *   cannot tell an absent key from one holding undefined.
 * - **A refused argument produces no request at all.** Asserting the throw is not
 *   enough; the point of validating early is that nothing was sent.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config.js";
import { applyRole } from "./apply-role.js";
import {
  createAgent,
  CreateAgentPartialError,
  CREATE_AGENT_TIMEOUT_MS,
} from "./create-agent.js";
import { ProductUpstreamError } from "../client.js";
import { createConnection } from "./create-connection.js";
import { createProject } from "./create-project.js";
import { createTemplate } from "./create-template.js";
import { sendMessage } from "./send-message.js";
import { updateTemplate } from "./update-template.js";

type Captured = { method: string; url: string; raw: string; contentType?: string };

let running: Server | undefined;
let seen: Captured[] = [];

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
  seen = [];
});

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => resolve(raw));
  });

/** A server that records every request and answers each with the same body. */
async function capturing(responseBody: unknown, status = 200): Promise<Config> {
  const server = createServer(async (req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      raw: await readBody(req),
      contentType: req.headers["content-type"],
    });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  running = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { ...loadConfig({}), host: "127.0.0.1", port };
}

const only = (): Captured => {
  // One request per verb is the rule, so this is an assertion, not a convenience.
  expect(seen).toHaveLength(1);
  return seen[0] as Captured;
};

const body = (): Record<string, unknown> => JSON.parse(only().raw) as Record<string, unknown>;

const UUID = "1634aa11-2222-4333-8444-555566667777";

describe("create_project", () => {
  it("POSTs both fields to /api/projects as JSON", async () => {
    const config = await capturing({ id: UUID, name: "mob2", workingDirectory: "/tmp/mob2" });
    await createProject(config, { name: "mob2", workingDirectory: "/tmp/mob2" });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/projects");
    expect(only().contentType).toBe("application/json");
    expect(body()).toEqual({ name: "mob2", workingDirectory: "/tmp/mob2" });
  }, 20_000);

  it("maps the snake_case argument name into the product's camelCase", async () => {
    const config = await capturing({ id: UUID });
    await createProject(config, { name: "n", workingDirectory: "/tmp/x" });
    expect(Object.keys(body()).sort()).toEqual(["name", "workingDirectory"]);
  }, 20_000);

  it.each([
    ["a missing name", { workingDirectory: "/tmp/x" }],
    ["a missing working directory", { name: "n" }],
    ["a whitespace-only name", { name: "  ", workingDirectory: "/tmp/x" }],
  ])("sends nothing when given %s", async (_label, input) => {
    const config = await capturing({});
    await expect(createProject(config, input)).rejects.toThrow();
    expect(seen).toEqual([]);
  }, 20_000);
});

describe("create_agent", () => {
  it("POSTs to /api/agents and drops the optional fields it was not given", async () => {
    const config = await capturing({ agentId: "new-agent" });
    await createAgent(config, { name: "New Agent", projectId: UUID });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/agents");
    // The optional keys must be absent, not null: the product branches on presence.
    expect(body()).toEqual({ name: "New Agent", projectId: UUID });
  }, 20_000);

  it("passes the optional fields through when they are given", async () => {
    const config = await capturing({ agentId: "new-agent" });
    await createAgent(config, {
      name: "New Agent",
      projectId: UUID,
      model: "anthropic/claude-opus-5",
    });
    expect(body()).toEqual({
      name: "New Agent",
      projectId: UUID,
      model: "anthropic/claude-opus-5",
    });
  }, 20_000);

  /**
   * The decision this verb records. `templateId` and `content` take the product's
   * richer path, which writes a pending onboarding record that nothing in this
   * surface can finish. They must not reach the product even if a caller passes
   * them, and `additionalProperties: false` on the schema is the other half.
   */
  it.each(["templateId", "content", "workspaceSubpath"])("never sends %s, whatever it is handed", async (field) => {
    const config = await capturing({ agentId: "new-agent" });
    await createAgent(config, {
      name: "New Agent",
      projectId: UUID,
      [field]: "smuggled",
    } as Parameters<typeof createAgent>[1]);
    expect(body()).not.toHaveProperty(field);
    expect(Object.keys(body()).sort()).toEqual(["name", "projectId"]);
  }, 20_000);

  it.each([
    ["a non-UUID project id", { name: "n", projectId: "mob2" }],
    ["no project id", { name: "n" }],
    ["no name", { projectId: UUID }],
  ])("sends nothing when given %s", async (_label, input) => {
    const config = await capturing({});
    await expect(createAgent(config, input)).rejects.toThrow();
    expect(seen).toEqual([]);
  }, 20_000);

  it("fails rather than returning a blank id when the product sends none", async () => {
    const config = await capturing({ ok: true });
    await expect(createAgent(config, { name: "n", projectId: UUID })).rejects.toThrow(
      /returned no agentId/,
    );
  }, 20_000);

  it("lifts the agentId out and keeps the product's result whole", async () => {
    const config = await capturing({ agentId: "new-agent", workspace: "/tmp/mob2" });
    const result = await createAgent(config, { name: "n", projectId: UUID });
    expect(result.agentId).toBe("new-agent");
    expect(result.created).toEqual({ agentId: "new-agent", workspace: "/tmp/mob2" });
    // A verified create is a plain success: nothing partial is claimed.
    expect(result).not.toHaveProperty("partial");
    expect(result).not.toHaveProperty("warning");
  }, 20_000);

  /** SCRUM-190: the product's 200 when OpenClaw's roster never showed the agent. */
  const ROSTER_UNVERIFIED = {
    outcome: "partial",
    state: "partial",
    partial: true,
    ready: false,
    code: "openclaw-roster-readback-timeout",
    openclawAgentCreated: true,
    agentId: "new-agent",
    createdAgentId: "new-agent",
    rosterUnverified: true,
    projectMembershipVerified: true,
    membershipBasis: "gateway-create-response",
    verification: { openclawRosterVerified: false, projectMembershipVerified: true },
    nextAction: {
      code: "verify-openclaw-roster",
      message: "Re-read agents.list; do not create the agent again.",
    },
  };

  it("surfaces a roster-unverified 200 as partial, never as a plain success", async () => {
    const config = await capturing(ROSTER_UNVERIFIED);
    const result = await createAgent(config, { name: "n", projectId: UUID });
    expect(result).toMatchObject({
      agentId: "new-agent",
      partial: true,
      rosterUnverified: true,
      nextAction: { code: "verify-openclaw-roster" },
    });
    expect(result.warning).toMatch(/Partial create: agent new-agent/);
    expect(result.warning).toMatch(/openclaw-roster-readback-timeout/);
    expect(result.warning).toMatch(/Do not call create_agent again/);
    expect(result.warning).toMatch(/do not create the agent again/);
    expect(result.created).toEqual(ROSTER_UNVERIFIED);
  }, 20_000);

  it("treats verification.openclawRosterVerified false alone as partial", async () => {
    const config = await capturing({
      agentId: "new-agent",
      verification: { openclawRosterVerified: false },
    });
    const result = await createAgent(config, { name: "n", projectId: UUID });
    expect(result).toMatchObject({ partial: true, rosterUnverified: true });
    expect(result.warning).toMatch(/Re-read it with list_agents/);
  }, 20_000);

  it("names the created agent and the delete action on the orphan 502, even past 400 chars", async () => {
    const orphan = {
      outcome: "partial",
      partial: true,
      code: "openclaw-roster-mismatch",
      error:
        "OpenClaw created the agent, but fresh roster identity/workspace did not match; " +
        "project access was not changed.",
      openclawAgentCreated: true,
      agentId: null,
      createdAgentId: "orphan-agent",
      createdWorkspace: "/tmp/ws/orphan-agent",
      nextAction: {
        code: "delete-agent",
        message:
          "OpenClaw created agent orphan-agent, but agents.list reports a missing or " +
          "different workspace, so it was not added to the project. Delete it with " +
          "DELETE /api/agents/orphan-agent (route DELETE /api/agents/:id), then create " +
          "it again. Do not attach it to a project.",
        route: "DELETE /api/agents/:id",
        path: "/api/agents/orphan-agent",
      },
    };
    // The client used to parse only the first 400 characters, which dropped this.
    expect(JSON.stringify(orphan).length).toBeGreaterThan(400);
    const config = await capturing(orphan, 502);
    const error = await createAgent(config, { name: "n", projectId: UUID }).catch((e) => e);
    expect(error).toBeInstanceOf(CreateAgentPartialError);
    expect(error).toMatchObject({
      status: 502,
      code: "openclaw-roster-mismatch",
      createdAgentId: "orphan-agent",
      nextAction: { code: "delete-agent", path: "/api/agents/orphan-agent" },
    });
    expect(error.message).toMatch(/OpenClaw DID create agent orphan-agent/);
    expect(error.message).toMatch(/Do not call create_agent again/);
    expect(error.message).toMatch(/DELETE \/api\/agents\/orphan-agent/);
    expect(error.message).toMatch(/cannot delete agents/);
  }, 20_000);

  it("leaves a 502 that created nothing as an ordinary upstream failure", async () => {
    const config = await capturing({ error: "Gateway down", code: "gateway-unavailable" }, 502);
    const error = await createAgent(config, { name: "n", projectId: UUID }).catch((e) => e);
    expect(error).toBeInstanceOf(ProductUpstreamError);
    expect(error).not.toBeInstanceOf(CreateAgentPartialError);
  }, 20_000);

  it("allows the product's whole create, roster poll included, before timing out", () => {
    // 5 s roster poll, up to ~2 s overrun on its last read, plus create and the
    // post-create steps; the 10 s default could abort a create that completed.
    expect(CREATE_AGENT_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("waits past the client default for a slow create", async () => {
    // The server answers after 10.5 s: past DEFAULT_TIMEOUT_MS, within this verb's.
    const server = createServer(async (req, res) => {
      await readBody(req);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ agentId: "slow-agent" }));
      }, 10_500);
    });
    running = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const result = await createAgent(
      { ...loadConfig({}), host: "127.0.0.1", port },
      { name: "n", projectId: UUID },
    );
    expect(result.agentId).toBe("slow-agent");
  }, 20_000);
});

describe("create_template", () => {
  it("POSTs name and content to /api/templates", async () => {
    const config = await capturing({ id: UUID, name: "Role", content: "text" });
    await createTemplate(config, { name: "Role", content: "text" });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/templates");
    expect(body()).toEqual({ name: "Role", content: "text" });
  }, 20_000);

  it("refuses whitespace-only content, which the product would accept", async () => {
    // The product's check is falsy, so "   " creates a template that then becomes
    // an agent's whole role. This is the one place being stricter is worth it.
    const config = await capturing({});
    await expect(createTemplate(config, { name: "Role", content: "   " })).rejects.toThrow(
      /content cannot be only whitespace/,
    );
    expect(seen).toEqual([]);
  }, 20_000);
});

describe("update_template", () => {
  it("PUTs to the id's path", async () => {
    const config = await capturing({ id: UUID, name: "Renamed", content: "old" });
    await updateTemplate(config, { templateId: UUID, name: "Renamed" });

    expect(only().method).toBe("PUT");
    expect(only().url).toBe(`/api/templates/${UUID}`);
  }, 20_000);

  /**
   * The assertion this file exists for. Reading the raw text, because
   * `JSON.parse('{"name":"x"}')` and a parsed body holding `content: undefined`
   * are indistinguishable — and the difference between them is whether the
   * template's text survives the call.
   */
  it("omits an unsent field from the JSON entirely, rather than sending null", async () => {
    const config = await capturing({ id: UUID, name: "Renamed", content: "kept" });
    await updateTemplate(config, { templateId: UUID, name: "Renamed" });

    expect(only().raw).toBe('{"name":"Renamed"}');
    expect(only().raw).not.toContain("content");
    expect(only().raw).not.toContain("null");
  }, 20_000);

  it("omits name the same way when only content is sent", async () => {
    const config = await capturing({ id: UUID, name: "kept", content: "new" });
    await updateTemplate(config, { templateId: UUID, content: "new" });

    expect(only().raw).toBe('{"content":"new"}');
    expect(only().raw).not.toContain("name");
  }, 20_000);

  it("sends both when both are given", async () => {
    const config = await capturing({ id: UUID, name: "n", content: "c" });
    await updateTemplate(config, { templateId: UUID, name: "n", content: "c" });
    expect(body()).toEqual({ name: "n", content: "c" });
  }, 20_000);

  it("reports which fields were sent, which the response alone cannot say", async () => {
    const config = await capturing({ id: UUID, name: "n", content: "c" });
    expect((await updateTemplate(config, { templateId: UUID, name: "n" })).changed).toEqual([
      "name",
    ]);
    seen = [];
    expect((await updateTemplate(config, { templateId: UUID, content: "c" })).changed).toEqual([
      "content",
    ]);
  }, 20_000);

  it("refuses a call with neither field, without sending it", async () => {
    // The product would accept this and rewrite the store with no change.
    const config = await capturing({});
    await expect(updateTemplate(config, { templateId: UUID })).rejects.toThrow(
      /needs name, content, or both/,
    );
    expect(seen).toEqual([]);
  }, 20_000);

  it("refuses an id that would redirect the path, without sending it", async () => {
    const config = await capturing({});
    await expect(
      updateTemplate(config, { templateId: "../agents", name: "n" }),
    ).rejects.toThrow(/must be a UUID/);
    expect(seen).toEqual([]);
  }, 20_000);
});

describe("apply_role", () => {
  it("POSTs both ids to /api/agent-roles", async () => {
    const config = await capturing({ run: { runId: "r", status: "completed" }, roleRecord: {} });
    await applyRole(config, { agentId: "mob2-eng-manager", templateId: UUID });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/agent-roles");
    expect(body()).toEqual({ agentId: "mob2-eng-manager", templateId: UUID });
  }, 20_000);

  it("sends nothing for a malformed agent id, so no turn is spent", async () => {
    const config = await capturing({});
    await expect(applyRole(config, { agentId: "has/slash", templateId: UUID })).rejects.toThrow(
      /must be an agent id/,
    );
    expect(seen).toEqual([]);
  }, 20_000);
});

describe("create_connection", () => {
  it("POSTs from and to, in that direction", async () => {
    const config = await capturing({ run: { runId: "r", status: "completed" }, connection: {} });
    await createConnection(config, { from: "a-one", to: "b-two" });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/connections");
    expect(body()).toEqual({ from: "a-one", to: "b-two" });
  }, 20_000);

  it("refuses a self-connection without spending a turn on it", async () => {
    const config = await capturing({});
    await expect(createConnection(config, { from: "a-one", to: "a-one" })).rejects.toThrow(
      /must be different agents/,
    );
    expect(seen).toEqual([]);
  }, 20_000);

  it.each([
    ["from", { from: "has/slash", to: "b-two" }],
    ["to", { from: "a-one", to: "has/slash" }],
  ])("names %s in the refusal, since they are not interchangeable", async (label, input) => {
    const config = await capturing({});
    await expect(createConnection(config, input)).rejects.toThrow(
      new RegExp(`^${label} must be an agent id`),
    );
    expect(seen).toEqual([]);
  }, 20_000);
});

describe("send_message", () => {
  it("POSTs the agent id and message to /api/chat", async () => {
    const config = await capturing({ run: { runId: "r", status: "completed" } });
    await sendMessage(config, { agentId: "mob2-eng-manager", message: "status?" });

    expect(only().method).toBe("POST");
    expect(only().url).toBe("/api/chat");
    expect(body()).toEqual({ agentId: "mob2-eng-manager", message: "status?" });
  }, 20_000);

  it("refuses a whitespace-only message, which would wake an agent to read nothing", async () => {
    const config = await capturing({});
    await expect(sendMessage(config, { agentId: "mob2-eng-manager", message: " \n" })).rejects.toThrow(
      /message cannot be only whitespace/,
    );
    expect(seen).toEqual([]);
  }, 20_000);

  it("sends a message that is only punctuation, which is content", async () => {
    const config = await capturing({ run: { runId: "r", status: "completed" } });
    await sendMessage(config, { agentId: "a-one", message: "?" });
    expect(body()).toEqual({ agentId: "a-one", message: "?" });
  }, 20_000);
});

describe("every write verb sends exactly one request", () => {
  /**
   * The rule stated once over all seven. Each `only()` above asserts it per verb;
   * this asserts it as the property, so a verb added later that reads before it
   * writes fails here even if its own file forgets to check.
   */
  it("makes one request per successful call", async () => {
    const config = await capturing({
      id: UUID,
      agentId: "new-agent",
      name: "n",
      content: "c",
      run: { runId: "r", status: "completed" },
      roleRecord: {},
      connection: {},
    });

    const calls: (() => Promise<unknown>)[] = [
      () => createProject(config, { name: "n", workingDirectory: "/tmp/x" }),
      () => createAgent(config, { name: "n", projectId: UUID }),
      () => createTemplate(config, { name: "n", content: "c" }),
      () => updateTemplate(config, { templateId: UUID, name: "n" }),
      () => applyRole(config, { agentId: "a-one", templateId: UUID }),
      () => createConnection(config, { from: "a-one", to: "b-two" }),
      () => sendMessage(config, { agentId: "a-one", message: "hi" }),
    ];

    for (const call of calls) {
      seen = [];
      await call();
      expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(7);
  }, 40_000);
});

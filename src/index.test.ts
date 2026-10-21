import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argsDigest, TICKET_TTL_MS } from "./call-ticket.js";
import { defaultTicketsDir } from "./call-ticket.js";
import entry, { defaultTicketDeps, issueCallTicket, singleIntentVerb, type TicketDeps } from "./index.js";

const STATE = "/Users/example/.openclaw-si";
const NOW = Date.now();
const ARGS = { projectId: "p", title: "T", intent: "I" };
const CTX = { agentId: "joylabs-backend-dev", sessionKey: "agent:joylabs-backend-dev:main", runId: "run-7" };
let root: string;
let dir: string;
let nonces: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "si-hook-"));
  dir = join(root, ".call-tickets");
  nonces = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = (over: Partial<TicketDeps> = {}): TicketDeps => ({
  engineStateDir: () => STATE,
  ticketsDir: () => dir,
  now: () => NOW,
  nonce: () => `nonce-${++nonces}`,
  ...over,
});

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const readTicket = (key: string) => JSON.parse(readFileSync(join(dir, `${hash(key)}.json`), "utf8"));

const WORKITEM_VERBS = ["create_workitem", "workitem_set_state", "workitem_estimate", "workitem_note"];
/** SCRUM-185: the other write verbs, ticketed the same way. */
const OTHER_WRITE_VERBS = [
  "send_message",
  "apply_role",
  "create_agent",
  "create_project",
  "create_template",
  "update_template",
  "create_connection",
];
/** Each of the seven on both runtimes' tool names. */
const OTHER_WRITE_TOOLS = OTHER_WRITE_VERBS.flatMap((verb) => [`mcp__singleintent__${verb}`, `singleintent__${verb}`]);

const blocked = (result: unknown, code: string) => {
  expect(result).toMatchObject({ block: true });
  expect((result as { blockReason: string }).blockReason).toContain(`[${code}]`);
};

describe("before_tool_call call ticket: native path (claude-cli, Codex)", () => {
  it.each([...WORKITEM_VERBS, ...OTHER_WRITE_VERBS].map((verb) => `mcp__singleintent__${verb}`))(
    "writes a ticket keyed by the tool call id and does not rewrite params on %s",
    (toolName) => {
      const params = { ...ARGS };
      const result = issueCallTicket({ toolName, params, toolCallId: "toolu_01" }, CTX, deps());
      expect(result).toBeUndefined();
      expect(params).toEqual(ARGS);
      expect(readTicket("toolu_01")).toEqual({
        v: 1,
        agentId: CTX.agentId,
        engineStateDir: STATE,
        sessionKey: CTX.sessionKey,
        runId: CTX.runId,
        verb: singleIntentVerb(toolName),
        argsDigest: argsDigest(ARGS),
        keyDigest: hash("toolu_01"),
        expiresAt: NOW + TICKET_TTL_MS,
      });
    },
  );

  it("stores the file 0600 in a 0700 dir, named by the key's hash", () => {
    issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "call_abc" }, CTX, deps());
    expect(readdirSync(dir)).toEqual([`${hash("call_abc")}.json`]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${hash("call_abc")}.json`)).mode & 0o777).toBe(0o600);
  });

  it("records null origin fields when the host supplies none", () => {
    issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, { agentId: "a" }, deps());
    expect(readTicket("t")).toMatchObject({ agentId: "a", sessionKey: null, runId: null });
  });

  it("blocks with no-tool-call-id when the host supplies no call id", () => {
    blocked(issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS }, CTX, deps()), "no-tool-call-id");
  });

  it("blocks with model-ticket-id when the model supplies its own ticketId", () => {
    const result = issueCallTicket(
      { toolName: "mcp__singleintent__create_workitem", params: { ...ARGS, ticketId: "forged" }, toolCallId: "t" },
      CTX,
      deps(),
    );
    blocked(result, "model-ticket-id");
    expect(() => readdirSync(dir)).toThrow();
  });

  it("succeeds when a duplicate hook copy finds its own identical ticket (EEXIST)", () => {
    const event = { toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" };
    expect(issueCallTicket(event, CTX, deps())).toBeUndefined();
    expect(issueCallTicket(event, CTX, deps({ now: () => NOW + 2 }))).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("blocks with call-ticket-conflict when a different ticket holds the call id", () => {
    issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, CTX, deps());
    blocked(
      issueCallTicket(
        { toolName: "mcp__singleintent__create_workitem", params: { ...ARGS, title: "Other" }, toolCallId: "t" },
        CTX,
        deps(),
      ),
      "call-ticket-conflict",
    );
    blocked(
      issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, { agentId: "other" }, deps()),
      "call-ticket-conflict",
    );
  });

  it("blocks with call-key-reused once the call id's ticket was claimed", () => {
    issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, CTX, deps());
    writeFileSync(join(dir, `${hash("t")}.used`), JSON.stringify({ expiresAt: NOW + TICKET_TTL_MS }));
    rmSync(join(dir, `${hash("t")}.json`));
    blocked(
      issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, CTX, deps()),
      "call-key-reused",
    );
  });

  it("blocks with call-ticket-write-failed when the ticket cannot be written", () => {
    // A safe dir (0500 is owner-only) that this user cannot write in.
    mkdirSync(dir, { mode: 0o500 });
    blocked(
      issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, CTX, deps()),
      "call-ticket-write-failed",
    );
    chmodSync(dir, 0o700);
  });

  const native = () =>
    issueCallTicket({ toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "t" }, CTX, deps());

  it("blocks with call-ticket-dir-unsafe when the tickets dir is a symlink", () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, dir);
    const result = native();
    blocked(result, "call-ticket-dir-unsafe");
    expect((result as { blockReason: string }).blockReason).toContain(`${dir} is unsafe: it is a symlink`);
    expect(readdirSync(real)).toEqual([]);
  });

  it("blocks with call-ticket-dir-unsafe when the tickets path is not a directory", () => {
    writeFileSync(dir, "not a directory");
    const result = native();
    blocked(result, "call-ticket-dir-unsafe");
    expect((result as { blockReason: string }).blockReason).toContain("it is not a directory");
  });

  it.each([0o750, 0o705, 0o777])("blocks with call-ticket-dir-unsafe on an existing dir with mode %o", (mode) => {
    mkdirSync(dir);
    chmodSync(dir, mode);
    const result = native();
    blocked(result, "call-ticket-dir-unsafe");
    expect((result as { blockReason: string }).blockReason).toContain("group and other bits must be clear");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("blocks with call-ticket-dir-unsafe on an existing dir owned by another user", () => {
    mkdirSync(dir, { mode: 0o700 });
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      const result = native();
      blocked(result, "call-ticket-dir-unsafe");
      expect((result as { blockReason: string }).blockReason).toContain(`owned by uid ${uid}, not ${uid + 1}`);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("before_tool_call call ticket: embedded path (OpenClaw's MCP client)", () => {
  it.each([...WORKITEM_VERBS, ...OTHER_WRITE_VERBS].map((verb) => `singleintent__${verb}`))(
    "adds only ticketId on %s, keyed by a fresh nonce",
    (toolName) => {
      const result = issueCallTicket({ toolName, params: { ...ARGS }, toolCallId: "call_mockA1" }, CTX, deps());
      expect(result).toEqual({ params: { ...ARGS, ticketId: "nonce-1" } });
      expect(readTicket("nonce-1")).toMatchObject({
        agentId: CTX.agentId,
        verb: singleIntentVerb(toolName),
        argsDigest: argsDigest(ARGS),
      });
      // Not keyed by the host's call id: OpenClaw's client never sends it on.
      expect(readdirSync(dir)).toEqual([`${hash("nonce-1")}.json`]);
    },
  );

  it("uses a different nonce per call", () => {
    const event = { toolName: "singleintent__create_workitem", params: ARGS };
    const a = issueCallTicket(event, CTX, deps()) as { params: Record<string, unknown> };
    const b = issueCallTicket(event, CTX, deps()) as { params: Record<string, unknown> };
    expect(a.params.ticketId).not.toBe(b.params.ticketId);
  });

  it("the default nonce is 256 random bits", () => {
    const result = issueCallTicket({ toolName: "singleintent__create_workitem", params: ARGS }, CTX, {
      ...deps(),
      nonce: defaultTicketDeps.nonce,
    }) as { params: { ticketId: string } };
    expect(Buffer.from(result.params.ticketId, "base64url")).toHaveLength(32);
  });

  it("writes one ticket for tool_call: none for the outer call, one for the inner", () => {
    expect(issueCallTicket({ toolName: "tool_call", params: { id: "singleintent__create_workitem", args: ARGS }, toolCallId: "call_tcA1" }, CTX, deps())).toBeUndefined();
    expect(() => readdirSync(dir)).toThrow();
    const inner = issueCallTicket(
      { toolName: "singleintent__create_workitem", params: ARGS, toolCallId: "tool_call:call_tcA1:singleintent__create_workitem:1" },
      CTX,
      deps(),
    );
    expect(inner).toEqual({ params: { ...ARGS, ticketId: "nonce-1" } });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("blocks with model-ticket-id rather than overwrite a model-supplied ticketId", () => {
    blocked(
      issueCallTicket({ toolName: "singleintent__create_workitem", params: { ...ARGS, ticketId: "forged" } }, CTX, deps()),
      "model-ticket-id",
    );
  });
});

describe("before_tool_call call ticket: both paths", () => {
  it.each(["mcp__singleintent__create_workitem", "singleintent__workitem_set_state"])(
    "blocks with no-agent-id when the host did not identify the agent (%s)",
    (toolName) => {
      blocked(issueCallTicket({ toolName, params: ARGS, toolCallId: "t" }, {}, deps()), "no-agent-id");
      expect(() => readdirSync(dir)).toThrow();
    },
  );

  it.each([
    ["mcp__singleintent__create_workitem", "actingAgentId"],
    ["mcp__singleintent__workitem_estimate", "actingEngineStateDir"],
    ["singleintent__create_workitem", "actingSessionKey"],
    ["singleintent__workitem_set_state", "actingRunId"],
    ["mcp__singleintent__workitem_note", "actingAgentId"],
    ["singleintent__workitem_note", "actingSessionKey"],
  ])("blocks %s carrying %s with acting-args-refused", (toolName, key) => {
    const result = issueCallTicket({ toolName, params: { ...ARGS, [key]: "forged" }, toolCallId: "t" }, CTX, deps());
    blocked(result, "acting-args-refused");
    expect((result as { blockReason: string }).blockReason).toContain(key);
  });

  it.each(["mcp__singleintent__workitem_note", "singleintent__workitem_note"])(
    "blocks %s with model-ticket-id when the model supplies its own ticketId",
    (toolName) => {
      blocked(
        issueCallTicket({ toolName, params: { ...ARGS, ticketId: "forged" }, toolCallId: "t" }, CTX, deps()),
        "model-ticket-id",
      );
      expect(() => readdirSync(dir)).toThrow();
    },
  );

  it.each([
    ["mcp__singleintent__create_workitem", "origin", { sessionKey: "agent:other:main", runId: "r" }],
    ["mcp__singleintent__workitem_set_state", "sessionKey", "agent:other:main"],
    ["mcp__singleintent__workitem_estimate", "runId", "forged"],
    ["singleintent__create_workitem", "origin", { sessionKey: "agent:joylabs-backend-dev:main" }],
    ["singleintent__workitem_set_state", "sessionKey", "agent:other:main"],
    ["singleintent__workitem_estimate", "runId", "forged"],
    ["mcp__singleintent__workitem_note", "origin", { sessionKey: "agent:other:main" }],
    ["singleintent__workitem_note", "sessionKey", "agent:other:main"],
  ])("blocks %s carrying a model %s with origin-args-refused, writing no ticket (SCRUM-148)", (toolName, key, value) => {
    const result = issueCallTicket({ toolName, params: { ...ARGS, [key]: value }, toolCallId: "t" }, CTX, deps());
    blocked(result, "origin-args-refused");
    expect((result as { blockReason: string }).blockReason).toContain(key);
    expect(() => readdirSync(dir)).toThrow();
  });

  it.each([
    "mcp__singleintent__list_workitems",
    "mcp__singleintent__get_workitem",
    "singleintent__list_projects",
    "mcp__singleintent__list_templates",
    "mcp__other__create_project",
    "mcp__other__create_workitem",
    "create_workitem",
    "exec",
  ])("leaves %s alone, writing nothing", (toolName) => {
    expect(issueCallTicket({ toolName, params: { actingAgentId: "x", ticketId: "y" }, toolCallId: "t" }, {}, deps())).toBeUndefined();
    expect(() => readdirSync(dir)).toThrow();
  });

  it("parses both runtimes' tool names", () => {
    expect(singleIntentVerb("mcp__singleintent__create_workitem")).toBe("create_workitem");
    expect(singleIntentVerb("singleintent__create_workitem")).toBe("create_workitem");
    expect(singleIntentVerb("mcp__singleintentx__create_workitem")).toBeUndefined();
  });
});

/**
 * SCRUM-185: the seven other write verbs take the same hook path as the
 * work-item writes, on claude-cli/Codex (`mcp__`) and embedded (`singleintent__`)
 * tool names alike.
 */
describe("before_tool_call call ticket: the other write verbs (SCRUM-185)", () => {
  const PARAMS = { name: "x", content: "y" };

  it.each(OTHER_WRITE_TOOLS)("tickets %s for the calling agent and verb", (toolName) => {
    const result = issueCallTicket({ toolName, params: { ...PARAMS }, toolCallId: "toolu_185" }, CTX, deps());
    const native = toolName.startsWith("mcp__");
    expect(result).toEqual(native ? undefined : { params: { ...PARAMS, ticketId: "nonce-1" } });
    expect(readTicket(native ? "toolu_185" : "nonce-1")).toMatchObject({
      agentId: CTX.agentId,
      engineStateDir: STATE,
      verb: singleIntentVerb(toolName),
      argsDigest: argsDigest(PARAMS),
    });
  });

  it.each(OTHER_WRITE_TOOLS)("blocks %s with no-agent-id, writing no ticket", (toolName) => {
    blocked(issueCallTicket({ toolName, params: PARAMS, toolCallId: "t" }, {}, deps()), "no-agent-id");
    expect(() => readdirSync(dir)).toThrow();
  });

  it.each(OTHER_WRITE_TOOLS.flatMap((toolName) => ["actingAgentId", "actingEngineStateDir"].map((key) => [toolName, key])))(
    "blocks %s carrying %s with acting-args-refused",
    (toolName, key) => {
      const result = issueCallTicket({ toolName, params: { ...PARAMS, [key]: "forged" }, toolCallId: "t" }, CTX, deps());
      blocked(result, "acting-args-refused");
      expect((result as { blockReason: string }).blockReason).toContain(key);
      expect(() => readdirSync(dir)).toThrow();
    },
  );

  it.each(
    OTHER_WRITE_TOOLS.flatMap((toolName) =>
      (
        [
          ["origin", { sessionKey: "agent:other:main" }],
          ["sessionKey", "agent:other:main"],
          ["runId", "forged"],
        ] as const
      ).map(([key, value]) => [toolName, key, value] as const),
    ),
  )("blocks %s carrying a model %s with origin-args-refused", (toolName, key, value) => {
    blocked(issueCallTicket({ toolName, params: { ...PARAMS, [key]: value }, toolCallId: "t" }, CTX, deps()), "origin-args-refused");
    expect(() => readdirSync(dir)).toThrow();
  });

  it.each(OTHER_WRITE_TOOLS)("blocks %s with model-ticket-id when the model supplies its own ticketId", (toolName) => {
    blocked(issueCallTicket({ toolName, params: { ...PARAMS, ticketId: "forged" }, toolCallId: "t" }, CTX, deps()), "model-ticket-id");
    expect(() => readdirSync(dir)).toThrow();
  });

  it.each(OTHER_WRITE_VERBS)("blocks mcp__singleintent__%s with no-tool-call-id when the host supplies none", (verb) => {
    blocked(issueCallTicket({ toolName: `mcp__singleintent__${verb}`, params: PARAMS }, CTX, deps()), "no-tool-call-id");
  });

  it("says writes, not work-item writes, in the block reason", () => {
    const result = issueCallTicket({ toolName: "mcp__singleintent__send_message", params: PARAMS, toolCallId: "t" }, {}, deps());
    expect((result as { blockReason: string }).blockReason).toMatch(/^SingleIntent write blocked \[no-agent-id\]: writes are attributed/);
  });
});

describe("plugin registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function registerHook(rootDir?: string): (event: unknown, ctx: unknown) => unknown {
    const hooks: [string, (event: unknown, ctx: unknown) => unknown][] = [];
    const api = {
      rootDir,
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        hooks.push([name, handler]);
      },
      runtime: {
        state: {
          resolveStateDir: () => {
            throw new Error("the hook must not use api.runtime.state.resolveStateDir");
          },
        },
      },
    };
    entry.register(api as never);
    expect(hooks.map(([name]) => name)).toEqual(["before_tool_call", "after_tool_call"]);
    return hooks[0]![1];
  }

  it("registers observer hooks; a read verb writes nothing and returns undefined", async () => {
    expect(await registerHook()({ toolName: "mcp__singleintent__list_projects", params: {} }, { agentId: "a" })).toBeUndefined();
  });

  it("defaults to dirname(resolveConfigPath()) and the plugin root's ticket dir", () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${STATE}/openclaw.json`);
    expect(defaultTicketDeps.engineStateDir()).toBe(STATE);
    expect(defaultTicketDeps.ticketsDir()).toBe(defaultTicketsDir());
  });

  it("writes tickets under the Gateway-reported api.rootDir, not this module's path", async () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${STATE}/openclaw.json`);
    const result = await registerHook(root)(
      { toolName: "mcp__singleintent__create_workitem", params: ARGS, toolCallId: "toolu_reg" },
      { agentId: "a" },
    );
    expect(result).toBeUndefined();
    expect(readTicket("toolu_reg")).toMatchObject({ agentId: "a", engineStateDir: STATE });
  });

  it("issues a workitem_note ticket through the registered handler on both paths (SCRUM-170)", async () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${STATE}/openclaw.json`);
    const hook = registerHook(root);
    expect(
      await hook({ toolName: "mcp__singleintent__workitem_note", params: ARGS, toolCallId: "toolu_note" }, { agentId: "a" }),
    ).toBeUndefined();
    expect(readTicket("toolu_note")).toMatchObject({ agentId: "a", verb: "workitem_note", argsDigest: argsDigest(ARGS) });
    const embedded = await hook({ toolName: "singleintent__workitem_note", params: ARGS }, { agentId: "b" }) as {
      params: { ticketId: string };
    };
    expect(readTicket(embedded.params.ticketId)).toMatchObject({ agentId: "b", verb: "workitem_note" });
  });

  it("blocks through the registered handler without an agent id", async () => {
    blocked(await registerHook()({ toolName: "mcp__singleintent__create_workitem", params: {}, toolCallId: "t" }, {}), "no-agent-id");
  });
});

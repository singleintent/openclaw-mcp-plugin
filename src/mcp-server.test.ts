import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "./config.js";
import { ENV_PREFIX, INSTANCE_FILE_NAME, envVar } from "./names.js";
import { SERVER_NAME, TOOLS, createServer } from "./mcp-server.js";
import { NOT_REVERSIBLE } from "./verbs/write-args.js";

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

const pkg = readJson("../package.json");
const manifest = readJson("../openclaw.plugin.json");

describe("work-item MCP tool contract", () => {
  const tool = (name: string): (typeof TOOLS)[number] => {
    const found = TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error("missing tool: " + name);
    return found;
  };

  const properties = (name: string): Record<string, { enum?: string[]; type?: string }> =>
    (tool(name).inputSchema as { properties: Record<string, { enum?: string[]; type?: string }> }).properties;

  it("exposes list, get, create, and exactly one state-changing tool", () => {
    for (const name of ["list_workitems", "get_workitem", "create_workitem", "workitem_set_state"]) {
      expect(TOOLS.map((entry) => entry.name)).toContain(name);
    }
    const stateTools = TOOLS.filter((entry) => /change[s]? a work record.s state|state-changing/i.test(entry.description ?? ""));
    expect(stateTools.map((entry) => entry.name)).toEqual(["workitem_set_state"]);
    expect(tool("workitem_set_state").description).toMatch(/only MCP tool that changes/);
  });

  it("requires explicit project scope on every work-item operation", () => {
    expect((tool("list_workitems").inputSchema as { required: string[] }).required).toContain("projectId");
    expect((tool("get_workitem").inputSchema as { required: string[] }).required).toEqual(["projectId", "itemId"]);
    expect((tool("create_workitem").inputSchema as { required: string[] }).required).toContain("projectId");
    expect((tool("workitem_set_state").inputSchema as { required: string[] }).required).toEqual(["projectId", "itemId", "state"]);
  });

  it("accepts only server MVP state targets and never exposes actor or timestamp inputs", () => {
    const schema = tool("workitem_set_state").inputSchema as { additionalProperties: boolean; properties: Record<string, { enum?: string[] }> };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["projectId", "itemId", "state", "reason", "outcome", "evidence", "eventId"]);
    expect(schema.properties.state?.enum).toEqual(["dispatched", "acknowledged", "started", "blocked", "completed", "failed", "canceled"]);
    for (const key of ["actor", "agentId", "timestamp", "at"]) expect(schema.properties).not.toHaveProperty(key);
  });

  it("offers create_workitem an optional t-shirt estimate", () => {
    expect(properties("create_workitem").estimate?.enum).toEqual(["XS", "S", "M", "L", "XL"]);
    expect((tool("create_workitem").inputSchema as { required: string[] }).required).not.toContain("estimate");
  });

  it("documents the stable event id needed to retry writes safely", () => {
    expect(tool("create_workitem").description).toMatch(/reuse the same UUIDv7 eventId/);
    expect(tool("workitem_set_state").description).toMatch(/reuse the same UUIDv7 eventId/);
    expect(properties("workitem_set_state")).toHaveProperty("eventId");
  });
});

describe("manifest wiring", () => {
  it("points the manifest at the built server, by a plugin-root-relative path", () => {
    const mcpServers = manifest.mcpServers as Record<
      string,
      { transport: string; command: string; args: string[] }
    >;
    expect(mcpServers[SERVER_NAME]).toMatchObject({
      transport: "stdio",
      command: "node",
      args: ["./dist/mcp-server.js"],
    });
  });

  /**
   * The one line that makes the config file per-instance, and the one token that
   * can do it. `${CLAUDE_PLUGIN_ROOT}` expands to this package's install root;
   * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` do not expand for an npm-installed
   * native plugin and would be written into the environment literally, which is a
   * path no file will ever be at. This asserts the working token is the one used.
   */
  it("hands the subprocess a per-instance config path through manifest env", () => {
    const server = (manifest.mcpServers as Record<string, { env?: Record<string, string> }>)[
      SERVER_NAME
    ];
    expect(server.env).toEqual({
      [envVar("CONFIG")]: `\${CLAUDE_PLUGIN_ROOT}/${INSTANCE_FILE_NAME}`,
    });
  });

  it("uses no placeholder that stays literal for this plugin format", () => {
    const env = JSON.stringify(
      (manifest.mcpServers as Record<string, { env?: Record<string, string> }>)[SERVER_NAME].env ??
        {},
    );
    expect(env).not.toMatch(/\$\{PLUGIN_ROOT\}/);
    expect(env).not.toMatch(/\$\{PLUGIN_DATA\}/);
  });

  // Two retired names now: the original code name, and the brand this repo
  // launched under before the org was renamed to singleintent.
  it.each([/joy.?labs/i, /singleinstinct/i])(
    "names no string matching the retired name %s",
    (retired) => {
      expect(JSON.stringify({ pkg, manifest })).not.toMatch(retired);
    },
  );
});

/**
 * The published surface, held to the same standard as the manifest.
 *
 * `README.md` is the npm package page and the doc comments below compile into
 * `dist/`, so both reach readers who have no access to the product's source. Two
 * things must stay out of them: the retired name, and the product's internals —
 * where it keeps its files and which module writes them. Neither is actionable by
 * anyone reading npm, and the first is simply wrong.
 *
 * Scoped to non-test sources on purpose. The two negative tests that assert
 * `"joy-labs"` is rejected as a project id have to name it to test it, and they
 * are not published.
 */
/**
 * The write surface, held to the three promises its descriptions make.
 *
 * These are description tests, which is unusual and deliberate. A tool description is
 * the only documentation a model reads before calling, and for these seven verbs the
 * things it has to know — that this cannot be undone, that it costs an agent turn,
 * that retrying will never work — are not inferable from the schema and are not
 * recoverable after the call. A description that loses one of them is a real defect
 * with no other detector.
 */
describe("the write verbs", () => {
  const WRITE_VERBS = [
    "create_project",
    "create_agent",
    "create_template",
    "update_template",
    "apply_role",
    "create_connection",
    "send_message",
  ];

  const tool = (name: string): (typeof TOOLS)[number] => {
    const found = TOOLS.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no tool named ${name}`);
    return found;
  };

  it("advertises all existing writes alongside the work-item tools", () => {
    for (const name of WRITE_VERBS) expect(TOOLS.map((t) => t.name)).toContain(name);
    expect(TOOLS).toHaveLength(18);
  });

  it("each declare their required arguments, so a model cannot omit one", () => {
    // Unlike the reads, where every argument is optional, a write with a missing
    // argument is a wasted round trip at best.
    for (const name of WRITE_VERBS) {
      const required = (tool(name).inputSchema as { required?: string[] }).required ?? [];
      expect(required.length, `${name} declares no required arguments`).toBeGreaterThan(0);
    }
  });

  it("take snake_case arguments, matching the read verbs", () => {
    for (const name of WRITE_VERBS) {
      const properties = (tool(name).inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {};
      for (const argument of Object.keys(properties)) {
        expect(argument, `${name} takes ${argument}`).toBe(argument.toLowerCase());
        expect(argument, `${name} takes ${argument}`).not.toMatch(/[A-Z]/);
      }
    }
  });

  /**
   * Six of the seven cannot be undone, and each says so in the same words. The
   * exception is `update_template`, which can be called again with the previous
   * values — and it says *that*, so the absence is a statement rather than a gap.
   */
  it.each(["create_project", "create_agent", "create_template", "apply_role", "create_connection"])(
    "%s says it cannot be undone, and why",
    (name) => {
      expect(tool(name).description).toContain(NOT_REVERSIBLE);
    },
  );

  it("update_template says it is reversible rather than staying silent", () => {
    const description = tool("update_template").description ?? "";
    expect(description).not.toContain(NOT_REVERSIBLE);
    expect(description).toMatch(/can be undone/);
  });

  it("send_message says the message survives a timeout, since resending repeats work", () => {
    // The one irreversibility that is not about a stored record: the agent has
    // already read it.
    const description = tool("send_message").description ?? "";
    expect(description).toMatch(/still delivered/);
    expect(description).toMatch(/get_activity/);
  });

  it.each(["apply_role", "create_connection", "send_message"])(
    "%s warns that it spends a real agent turn and can take minutes",
    (name) => {
      const description = tool(name).description ?? "";
      expect(description).toMatch(/minutes/);
      expect(description).toMatch(/turn|Blocks/);
    },
  );

  it("apply_role says a second call can never succeed", () => {
    // The verb most likely to be retried, so the description has to pre-empt it
    // rather than leaving the 409 to teach it.
    const description = tool("apply_role").description ?? "";
    expect(description).toMatch(/once/);
    expect(description).toMatch(/retrying never helps|always fails/);
  });

  it("create_connection says it is directed, so a caller knows one call is one way", () => {
    expect(tool("create_connection").description).toMatch(/[Dd]irected/);
  });

  it("create_agent points at apply_role rather than leaving the role unmentioned", () => {
    // The two fields that would have taken the product's onboarding path are not in
    // this schema; the description has to say what to use instead.
    const create = tool("create_agent");
    const properties = (create.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toEqual(["name", "project_id", "workspace_subpath", "model"]);
    expect(create.description).toMatch(/apply_role/);
  });

  it.each(["template_id", "content"])(
    "create_agent's schema does not offer %s, which would strand an agent",
    (field) => {
      const properties = (tool("create_agent").inputSchema as {
        properties?: Record<string, unknown>;
      }).properties ?? {};
      expect(Object.keys(properties)).not.toContain(field);
    },
  );
});

describe("the published surface carries no product internals", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));

  const shipped = (): { name: string; text: string }[] => [
    { name: "README.md", text: readFileSync(join(dir, "../README.md"), "utf8") },
    ...readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
  ];

  it("reads more than the README, so a passing run means something", () => {
    expect(shipped().length).toBeGreaterThan(5);
  });

  /**
   * The product's code name, which this connector never had a reason to publish.
   *
   * Only this one name, deliberately. `singleinstinct` — the brand this repo
   * launched under — is still named truthfully in two shipped files: `names.ts`
   * records the rename as the reason the brand strings are centralised, and
   * `list-agents.ts` cites a live project and agent whose real ids still carry it.
   * Those are accurate statements about a rename and about data, not stale
   * references, and the identity guard above already holds the package and
   * manifest to not carrying it. Widening this case would only catch them.
   */
  it("names no retired product code name", () => {
    expect(shipped().filter((file) => /joy.?labs/i.test(file.text)).map((f) => f.name)).toEqual([]);
  });

  /**
   * The product's storage layer, by the two shapes it took here: a `lib/…js`
   * module path, and a dot-directory under `~`. Both described where the product
   * keeps its state, which is a fact about the product's API rather than about
   * this connector.
   */
  it.each([/\blib\/[a-z0-9-]+\.js\b/i, /~\/\.[a-z]/i])(
    "points at no product-internal path %s",
    (internal) => {
      expect(shipped().filter((file) => internal.test(file.text)).map((f) => f.name)).toEqual([]);
    },
  );
});

describe("server construction", () => {
  it("builds without a transport", () => {
    expect(createServer(() => loadConfig({}))).toBeDefined();
  });

  it("advertises every verb with an input schema", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      // additionalProperties:false keeps a typo in an argument name an error
      // rather than a silently ignored field.
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    }
  });
});

/**
 * The product writes the config file as the last step of installing this plugin,
 * and the Gateway may already have started this process by then. A startup read
 * would lose that race silently and then be wrong for its whole lifetime, so the
 * read happens per call. These drive a real client over the in-memory transport
 * pair rather than asserting on internals, because what matters is what a caller
 * receives.
 */
describe("config is resolved per tool call", () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), "si-callsite-"));

  const connected = async (
    resolveConfig: () => Config,
  ): Promise<{ call: () => Promise<Record<string, unknown>>; close: () => Promise<void> }> => {
    const server = createServer(resolveConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "si-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      call: async () =>
        (await client.callTool({ name: "list_projects", arguments: {} })) as Record<
          string,
          unknown
        >,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };

  /** The text of a tool result, whatever its content shape. */
  const textOf = (result: Record<string, unknown>): string =>
    JSON.stringify(result.content ?? result);

  it("does not resolve config while constructing the server", () => {
    expect(() =>
      createServer(() => {
        throw new Error("resolved too early");
      }),
    ).not.toThrow();
  });

  it("surfaces a resolver failure as a tool error, not a dead transport", async () => {
    const { call, close } = await connected(() => {
      throw new Error("instance.json is not valid JSON: boom");
    });
    try {
      const first = await call();
      expect(first.isError).toBe(true);
      expect(textOf(first)).toContain("not valid JSON");
      // The transport must still be alive: a bad file is a per-call failure, so a
      // corrected file would be picked up without the Gateway recycling anything.
      const second = await call();
      expect(second.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("reads a config file written after the server was constructed", async () => {
    const path = join(scratch(), "instance.json");
    const { call, close } = await connected(() => loadConfig({ [`${ENV_PREFIX}CONFIG`]: path }));
    try {
      // The file does not exist yet, which is the state the race produces.
      writeFileSync(path, JSON.stringify({ host: "127.0.0.1", port: 1 }));
      const result = await call();
      expect(result.isError).toBe(true);
      // The host could only come from the file, and the file was written after
      // construction — so the read happened at call time.
      expect(textOf(result)).toContain("http://127.0.0.1:1/api/projects");
    } finally {
      await close();
    }
  });

  it("names the file when it is present but malformed", async () => {
    const path = join(scratch(), "instance.json");
    writeFileSync(path, "{ not json");
    const { call, close } = await connected(() => loadConfig({ [`${ENV_PREFIX}CONFIG`]: path }));
    try {
      const result = await call();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(path);
      expect(textOf(result)).toContain("not valid JSON");
    } finally {
      await close();
    }
  });
});

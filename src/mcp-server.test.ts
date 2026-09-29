import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SERVER_NAME, TOOLS, createServer } from "./mcp-server.js";
import { NOT_REVERSIBLE } from "./verbs/write-args.js";

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

const pkg = readJson("../package.json");
const manifest = readJson("../openclaw.plugin.json");

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

  it("are all advertised, alongside the seven reads", () => {
    for (const name of WRITE_VERBS) expect(TOOLS.map((t) => t.name)).toContain(name);
    expect(TOOLS).toHaveLength(14);
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
    expect(createServer(loadConfig({}))).toBeDefined();
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

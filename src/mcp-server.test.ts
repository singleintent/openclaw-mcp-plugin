import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SERVER_NAME, TOOLS, createServer } from "./mcp-server.js";

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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, createServer } from "./mcp-server.js";

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

describe("server construction", () => {
  it("builds without a transport", () => {
    expect(createServer()).toBeDefined();
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION, TOOLS, createServer } from "./mcp-server.js";

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

const pkg = readJson("../package.json");
const manifest = readJson("../openclaw.plugin.json");

describe("manifest and server agree", () => {
  it("advertises the version declared in package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("advertises the version declared in the manifest", () => {
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  // The mcpServers key is the tool prefix and is a separate string from `id`.
  // Setting them equal is a deliberate choice; this test makes drift fail loudly.
  it("uses one string for the plugin id and the MCP server key", () => {
    const mcpServers = manifest.mcpServers as Record<string, unknown>;
    expect(Object.keys(mcpServers)).toEqual([SERVER_NAME]);
    expect(manifest.id).toBe(SERVER_NAME);
  });

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

  it("names no string containing the retired code name", () => {
    expect(JSON.stringify({ pkg, manifest })).not.toMatch(/joy.?labs/i);
  });
});

describe("server construction", () => {
  it("builds without a transport", () => {
    expect(createServer()).toBeDefined();
  });

  // Guards the scaffold's central claim: no product verb is invented here.
  it("exposes an empty verb surface", () => {
    expect(TOOLS).toEqual([]);
  });
});

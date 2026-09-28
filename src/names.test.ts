import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRAND,
  CONFIG_DIR_NAME,
  ENV_PREFIX,
  SERVER_NAME,
  SERVER_VERSION,
  envVar,
} from "./names.js";

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

const pkg = readJson("../package.json");
const manifest = readJson("../openclaw.plugin.json");

// These are written out rather than derived, so that the env var names stay
// greppable. That only stays safe if something checks they agree with BRAND.
describe("brand-derived strings agree with BRAND", () => {
  it("derives the env prefix", () => {
    expect(ENV_PREFIX).toBe(`${BRAND.toUpperCase()}_`);
  });

  it("derives the config directory", () => {
    expect(CONFIG_DIR_NAME).toBe(`.${BRAND}`);
  });

  it("derives the server name", () => {
    expect(SERVER_NAME).toBe(BRAND);
  });

  it("builds qualified env var names", () => {
    expect(envVar("HOST")).toBe("SINGLEINTENT_HOST");
  });
});

describe("BRAND agrees with the published metadata", () => {
  it("matches the manifest id", () => {
    expect(manifest.id).toBe(BRAND);
  });

  // The mcpServers key is the tool prefix and is a separate string from `id`.
  // They are equal by choice, not by requirement; this fails if they drift.
  it("matches the single mcpServers key", () => {
    expect(Object.keys(manifest.mcpServers as Record<string, unknown>)).toEqual([BRAND]);
  });

  it("matches the npm scope", () => {
    expect(pkg.name).toBe(`@${BRAND}/openclaw-mcp-plugin`);
  });

  it("agrees on version across package.json, the manifest and the server", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});

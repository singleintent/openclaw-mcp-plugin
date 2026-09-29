import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The version, held across every file that states it.
 *
 * Four files state it and they cannot read each other: npm publishes
 * `package.json`, `openclaw plugins inspect` reports `Recorded version` from
 * `openclaw.plugin.json`, `npm ci` fails on a `package-lock.json` that disagrees
 * with `package.json`, and `SERVER_VERSION` is what the MCP handshake advertises.
 *
 * **The failure this prevents is specific and quiet.** Bump `package.json` alone and
 * everything still builds, the tests pass, and npm publishes `0.1.1` — while the
 * Gateway reports whatever the manifest still says. The install record then names a
 * version the registry does not have, and nothing anywhere reports an error.
 *
 * The three-way assertion above predates this block and already covered the first,
 * second and fourth. These add the two it did not: the lockfile, and the version
 * quoted in the README's install-verification output, which is the number a consumer
 * compares their own handshake against.
 */
describe("every file that states the version agrees", () => {
  const lock = readJson("../package-lock.json");
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );

  it("is a plain semver, so a bump cannot leave a range or a tag behind", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches package-lock.json, in both places npm writes it", () => {
    // `npm version` keeps these in step; a hand-edited package.json does not, and
    // the symptom is `npm ci` failing rather than anything mentioning the version.
    expect(lock.version).toBe(SERVER_VERSION);
    const root = (lock.packages as Record<string, { version?: string }>)[""];
    expect(root?.version).toBe(SERVER_VERSION);
  });

  it("matches the version quoted in the README's expected handshake output", () => {
    // The README tells a consumer what `initialize` should return. If that quotes a
    // version the server no longer reports, the documented way to verify an install
    // fails for a correct install — the worst kind of stale doc, because it makes a
    // working thing look broken.
    const quoted = /"serverInfo":\{"name":"[^"]+","version":"([^"]+)"\}/.exec(readme);
    expect(quoted?.[1], "no serverInfo version found in README.md").toBe(SERVER_VERSION);
  });

  /**
   * Guards the other direction: a fifth copy.
   *
   * Every assertion above compares a known file against `SERVER_VERSION`. None of
   * them can see a version literal written into some *other* source, which would
   * then drift at the next bump with nothing watching it. So this scans the shipped
   * sources instead of listing them, and `names.ts` is the only one allowed to say
   * the number. `handshake.test.ts` held such a copy until this bump and now derives
   * it, which is what makes the expectation reachable.
   */
  it("is written into exactly one shipped source, which is names.ts", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    expect(sources.length).toBeGreaterThan(5);

    const holders = sources.filter((name) =>
      readFileSync(join(dir, name), "utf8").includes(`"${SERVER_VERSION}"`),
    );
    expect(holders).toEqual(["names.ts"]);
  });
});

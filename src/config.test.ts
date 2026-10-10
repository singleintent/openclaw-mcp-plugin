import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  baseUrl,
  configFilePath,
  loadConfig,
} from "./config.js";
import { ENV_PREFIX } from "./names.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "si-config-"));

/** An env with no HOME so an absent config file is the baseline. */
const bare = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  [`${ENV_PREFIX}CONFIG`]: join(scratch(), "absent.json"),
  ...extra,
});

describe("defaults", () => {
  it("defaults to loopback and the product port", () => {
    const config = loadConfig(bare());
    expect(config).toMatchObject({ host: DEFAULT_HOST, port: DEFAULT_PORT });
    expect(config.sources).toMatchObject({ host: "default", port: "default" });
  });

  it("treats an absent config file as normal", () => {
    expect(() => loadConfig(bare())).not.toThrow();
  });

  /**
   * Absent-but-named is the state a fresh install passes through, and the state a
   * reinstall leaves behind until the product rewrites the file. It is recorded
   * rather than thrown on, because this process cannot tell a default port that
   * happens to be right from one that is wrong — only the product can — and
   * failing closed would break an install that never had a file at all.
   */
  it("records that a named config file was absent", () => {
    const path = join(scratch(), "instance.json");
    const config = loadConfig({ [`${ENV_PREFIX}CONFIG`]: path });
    expect(config.configFile).toEqual({ path, present: false, explicit: true });
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it("records a present config file as present", () => {
    const path = join(scratch(), "instance.json");
    writeFileSync(path, JSON.stringify({ port: 4321 }));
    expect(loadConfig({ [`${ENV_PREFIX}CONFIG`]: path }).configFile).toEqual({
      path,
      present: true,
      explicit: true,
    });
  });

  it("marks the default path as not explicit", () => {
    // No SINGLEINTENT_CONFIG: whatever the default path resolves to, nothing
    // pointed this process at it, so an absent file there means nothing is wrong.
    expect(loadConfig({}).configFile.explicit).toBe(false);
  });

  it("builds a loopback base URL", () => {
    expect(baseUrl(loadConfig(bare()))).toBe(`http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });
});

describe("host and port are both overridable", () => {
  // The deprecated connector allowed only the port; that is the defect.
  it("takes host from the environment", () => {
    const config = loadConfig(bare({ [`${ENV_PREFIX}HOST`]: "product.internal" }));
    expect(config.host).toBe("product.internal");
    expect(config.sources.host).toBe(`${ENV_PREFIX}HOST`);
  });

  it("takes port from the environment", () => {
    expect(loadConfig(bare({ [`${ENV_PREFIX}PORT`]: "8080" })).port).toBe(8080);
  });

  it("lets the environment win over the config file", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ host: "from.file", port: 1111 }));
    const config = loadConfig({
      [`${ENV_PREFIX}CONFIG`]: path,
      [`${ENV_PREFIX}HOST`]: "from.env",
    });
    expect(config.host).toBe("from.env");
    expect(config.port).toBe(1111); // file still supplies what env omits
    expect(config.sources).toMatchObject({ host: `${ENV_PREFIX}HOST`, port: path });
  });
});

describe("failures are loud and name the cause", () => {
  it("rejects a malformed config file instead of using defaults", () => {
    const path = join(scratch(), "config.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig({ [`${ENV_PREFIX}CONFIG`]: path })).toThrow(/not valid JSON/);
  });

  it("rejects a non-object config file", () => {
    const path = join(scratch(), "config.json");
    writeFileSync(path, "[]");
    expect(() => loadConfig({ [`${ENV_PREFIX}CONFIG`]: path })).toThrow(/must contain a JSON object/);
  });

  it.each(["0", "70000", "not-a-port", "80.5"])("rejects the invalid port %s", (port) => {
    expect(() => loadConfig(bare({ [`${ENV_PREFIX}PORT`]: port }))).toThrow(/integer port/);
  });

  it("rejects an unreadable token file rather than running unauthenticated", () => {
    const path = join(scratch(), "missing-token");
    expect(() => loadConfig(bare({ [`${ENV_PREFIX}TOKEN_FILE`]: path }))).toThrow(
      /cannot be read/,
    );
  });

  it("rejects an empty token file", () => {
    const path = join(scratch(), "empty-token");
    writeFileSync(path, "   \n");
    expect(() => loadConfig(bare({ [`${ENV_PREFIX}TOKEN_FILE`]: path }))).toThrow(/is empty/);
  });
});

describe("the auth slot", () => {
  it("is unset by default, so no credential is invented", () => {
    const config = loadConfig(bare());
    expect(config.token).toBeUndefined();
    expect(config.sources.token).toBe("unset");
  });

  it("reads a token from a file, keeping the secret out of config", () => {
    const path = join(scratch(), "token");
    writeFileSync(path, "  s3cret\n");
    const config = loadConfig(bare({ [`${ENV_PREFIX}TOKEN_FILE`]: path }));
    expect(config.token).toBe("s3cret");
    expect(config.sources.token).toBe(`${ENV_PREFIX}TOKEN_FILE`);
  });

  it("ignores a token in the config file: instance.json carries the port only (SCRUM-144)", () => {
    const path = join(scratch(), "instance.json");
    writeFileSync(path, JSON.stringify({ port: 5180, token: "retired-shared-token" }));
    const config = loadConfig({ [`${ENV_PREFIX}CONFIG`]: path });
    expect(config.port).toBe(5180);
    expect(config.token).toBeUndefined();
    expect(config).not.toHaveProperty("token");
    expect(config.sources.token).toBe(`ignored: ${path} "token"`);
  });

  it("still takes an explicit TOKEN over an ignored config-file token", () => {
    const path = join(scratch(), "instance.json");
    writeFileSync(path, JSON.stringify({ port: 5180, token: "retired-shared-token" }));
    const config = loadConfig({ [`${ENV_PREFIX}CONFIG`]: path, [`${ENV_PREFIX}TOKEN`]: "from-env" });
    expect(config.token).toBe("from-env");
    expect(config.sources.token).toBe(`${ENV_PREFIX}TOKEN`);
  });

  it("prefers TOKEN_FILE over TOKEN", () => {
    const path = join(scratch(), "token");
    writeFileSync(path, "from-file");
    const config = loadConfig(
      bare({ [`${ENV_PREFIX}TOKEN_FILE`]: path, [`${ENV_PREFIX}TOKEN`]: "from-env" }),
    );
    expect(config.token).toBe("from-file");
  });
});

describe("config file location", () => {
  it("honours the explicit override", () => {
    expect(configFilePath({ [`${ENV_PREFIX}CONFIG`]: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("otherwise sits under the home directory", () => {
    expect(configFilePath({})).toMatch(/\.singleintent\/config\.json$/);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigPath } from "openclaw/plugin-sdk/state-paths";
import {
  readWorkitemToken,
  resolveTokenDir,
  withoutActingArgs,
  WorkitemCredentialError,
} from "./workitem-token.js";

const AGENT = "joylabs-backend-dev";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "si-token-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveTokenDir", () => {
  const PRINCIPALS = "SINGLEINTENT_WORKITEM_PRINCIPALS_FILE";

  const CONFIG = "OPENCLAW_CONFIG_PATH";

  it("prefers the principals-file override, resolved the way the product resolves it", () => {
    const env = { [PRINCIPALS]: "rel/dir/workitem-principals.json", [CONFIG]: "/env/state/openclaw.json" };
    expect(resolveTokenDir("/hook/state", env)).toBe(
      join(dirname(resolve("rel/dir/workitem-principals.json")), "singleintent", "workitem-tokens"),
    );
  });

  it("uses the hook's engine state dir ahead of OPENCLAW_CONFIG_PATH", () => {
    expect(resolveTokenDir("/hook/state", { [CONFIG]: "/env/state/openclaw.json" })).toBe(
      "/hook/state/singleintent/workitem-tokens",
    );
  });

  it("falls back to dirname(OPENCLAW_CONFIG_PATH) when the hook supplied none", () => {
    expect(resolveTokenDir(undefined, { [CONFIG]: "/env/state/openclaw.json" })).toBe(
      "/env/state/singleintent/workitem-tokens",
    );
  });

  it("does not resolve a dir from OPENCLAW_STATE_DIR alone", () => {
    expect(resolveTokenDir(undefined, { OPENCLAW_STATE_DIR: "/env/state" })).toBeUndefined();
  });

  it("treats empty overrides as unset", () => {
    expect(resolveTokenDir("/hook/state", { [PRINCIPALS]: "" })).toBe(
      "/hook/state/singleintent/workitem-tokens",
    );
    expect(resolveTokenDir(undefined, { [CONFIG]: " " })).toBeUndefined();
  });

  it("resolves nothing rather than guess from cwd or a relative dir", () => {
    expect(resolveTokenDir(undefined, {})).toBeUndefined();
    expect(resolveTokenDir("relative/state", { [CONFIG]: "also/relative.json" })).toBeUndefined();
    expect(resolveTokenDir(42, {})).toBeUndefined();
  });
});

describe("readWorkitemToken", () => {
  function provision(agentId: string, contents: string): string {
    const dir = join(root, "singleintent", "workitem-tokens");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, agentId), contents, { mode: 0o600 });
    return join(dir, agentId);
  }

  const refusal = (fn: () => unknown): WorkitemCredentialError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkitemCredentialError);
      return error as WorkitemCredentialError;
    }
    throw new Error("expected a refusal");
  };

  it("reads the token from dirname(OPENCLAW_CONFIG_PATH) when the hook supplied no dir", () => {
    provision(AGENT, "tok");
    expect(
      readWorkitemToken({ actingAgentId: AGENT }, { OPENCLAW_CONFIG_PATH: join(root, "openclaw.json") }),
    ).toEqual({ agentId: AGENT, token: "tok" });
  });

  it("re-reads the file on every call", () => {
    const path = provision(AGENT, "first");
    const args = { actingAgentId: AGENT, actingEngineStateDir: root };
    expect(readWorkitemToken(args, {}).token).toBe("first");
    writeFileSync(path, "second");
    expect(readWorkitemToken(args, {}).token).toBe("second");
    rmSync(path);
    expect(refusal(() => readWorkitemToken(args, {})).code).toBe("no-agent-token");
  });

  it("reads and trims the acting agent's token", () => {
    provision(AGENT, "tok\n");
    expect(readWorkitemToken({ actingAgentId: AGENT, actingEngineStateDir: root }, {})).toEqual({
      agentId: AGENT,
      token: "tok",
    });
  });

  it.each([undefined, "", 42])("refuses a missing acting agent %j as no-acting-agent", (agentId) => {
    const error = refusal(() => readWorkitemToken({ actingAgentId: agentId, actingEngineStateDir: root }, {}));
    expect(error).toMatchObject({ code: "no-acting-agent", agentId: undefined, path: undefined });
    expect(error).not.toHaveProperty("status");
    expect(error.message).toContain("no acting agent");
  });

  it.each([".", "..", "a/b", "a\\b", "a\0b", "../x"])(
    "refuses the unsafe agent id %j before touching the filesystem",
    (agentId) => {
      const error = refusal(() => readWorkitemToken({ actingAgentId: agentId, actingEngineStateDir: root }, {}));
      expect(error).toMatchObject({ code: "unsafe-agent-id", agentId });
      expect(error).not.toHaveProperty("status");
      expect(error.message).toContain(JSON.stringify(agentId));
    },
  );

  it("names the agent and the expected path when the file is missing", () => {
    const error = refusal(() => readWorkitemToken({ actingAgentId: AGENT, actingEngineStateDir: root }, {}));
    const path = join(root, "singleintent", "workitem-tokens", AGENT);
    expect(error).toMatchObject({ code: "no-agent-token", agentId: AGENT, path });
    expect(error).not.toHaveProperty("status");
    expect(error.message).toContain(AGENT);
    expect(error.message).toContain(`${path} does not exist`);
  });

  it("names the agent and the expected path when the file is empty", () => {
    const path = provision(AGENT, " \n");
    const error = refusal(() => readWorkitemToken({ actingAgentId: AGENT, actingEngineStateDir: root }, {}));
    expect(error).toMatchObject({ code: "no-agent-token", agentId: AGENT, path });
    expect(error.message).toContain(`${path} is empty`);
  });

  it("names the agent when no engine state dir resolves", () => {
    const error = refusal(() => readWorkitemToken({ actingAgentId: AGENT }, {}));
    expect(error).toMatchObject({ code: "no-engine-state-dir", agentId: AGENT, path: undefined });
    expect(error).not.toHaveProperty("status");
    expect(error.message).toContain(`/workitem-tokens/${AGENT}`);
  });

  it("does not consult the instance token env when the agent's file is missing", () => {
    provision("someone-else", "other");
    const error = refusal(() =>
      readWorkitemToken(
        { actingAgentId: AGENT, actingEngineStateDir: root },
        { SINGLEINTENT_TOKEN: "instance", SINGLEINTENT_TOKEN_FILE: join(root, "x") },
      ),
    );
    expect(error.code).toBe("no-agent-token");
  });

  it("strips only the acting arguments", () => {
    expect(withoutActingArgs({ actingAgentId: "a", actingEngineStateDir: "/s", projectId: "p" })).toEqual({
      projectId: "p",
    });
  });
});

/**
 * The plugin's token dir and the product's must be the same directory: the
 * directory of the Gateway's config path. The hook stamps
 * `dirname(resolveConfigPath())` from the public `state-paths` subpath; this pins
 * what that yields for the si profile's env.
 */
describe("engine state dir agreement", () => {
  it("dirname(resolveConfigPath) is the si profile dir", () => {
    const env = { OPENCLAW_CONFIG_PATH: "/Users/shamas/.openclaw-si/openclaw.json" };
    expect(dirname(resolveConfigPath(env))).toBe("/Users/shamas/.openclaw-si");
  });

  it("the server's OPENCLAW_CONFIG_PATH fallback lands in the same directory as the hook", () => {
    const env = { OPENCLAW_CONFIG_PATH: "/Users/shamas/.openclaw-si/openclaw.json" };
    expect(resolveTokenDir(undefined, env)).toBe(
      resolveTokenDir(dirname(resolveConfigPath(env)), {}),
    );
  });
});

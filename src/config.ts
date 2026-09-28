/**
 * Config resolution for the MCP subprocess.
 *
 * The subprocess resolves its own config because plugin config cannot reach it.
 * Three paths were tested against OpenClaw 2026.9.5 and all are closed: manifest
 * `mcpServers.env` takes no templating, the only runtime MCP hook resolves
 * `url`/`headers` for HTTP transports rather than stdio env, and the child does
 * not inherit the Gateway environment — it receives exactly HOME, LOGNAME, PATH,
 * SHELL, USER and __CF_USER_TEXT_ENCODING, plus whatever the server definition
 * declares.
 *
 * Overriding `mcp.servers.singleintent` in openclaw.json is NOT the intended
 * path: that override replaces the manifest definition wholesale instead of
 * merging, so setting only `env` there drops `command` and OpenClaw skips the
 * server with "command is missing and its url is missing" — a silent
 * disabling. It remains available for consumers who restate the whole block.
 *
 * Precedence, highest first:
 *   1. environment variables (manifest `env` supplies HOST and PORT defaults)
 *   2. the config file, at $SINGLEINTENT_CONFIG or $HOME/.singleintent/config.json
 *   3. the built-in defaults below
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, envVar } from "./names.js";

/**
 * Loopback is the default, not a hardcoded value. The deprecated connector built
 * `http://127.0.0.1:${port}` with the host baked in, so only the port could ever
 * be overridden; a consumer running the product anywhere else had no path at all.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The port the product answers on today. It is also Vite's default dev port, so
 * it collides on developer machines and a stale process squatting it serves a
 * stale build — which is exactly why the override has to exist.
 */
export const DEFAULT_PORT = 5173;

export type Config = {
  host: string;
  port: number;
  /** Absent until the product grows auth; see SCRUM-8. */
  token?: string;
  /** Where each value came from, for diagnostics. */
  sources: Record<string, string>;
};

type FileConfig = {
  host?: unknown;
  port?: unknown;
  token?: unknown;
};

export const configFilePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env[envVar("CONFIG")] ?? join(homedir(), CONFIG_DIR_NAME, "config.json");

function readConfigFile(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {}; // Absent is normal: env and defaults suffice.
    throw new Error(`cannot read config file ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Loud, and naming the cause: a malformed file must not fall back to
    // defaults and appear to work against the wrong host.
    throw new Error(`config file ${path} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must contain a JSON object`);
  }
  return parsed as FileConfig;
}

function resolvePort(value: unknown, origin: string): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${origin} must be an integer port between 1 and 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = configFilePath(env);
  const file = readConfigFile(path);
  const sources: Record<string, string> = {};

  let host = DEFAULT_HOST;
  sources.host = "default";
  if (typeof file.host === "string" && file.host.length > 0) {
    host = file.host;
    sources.host = path;
  }
  const hostEnv = env[envVar("HOST")];
  if (hostEnv !== undefined && hostEnv !== "") {
    host = hostEnv;
    sources.host = envVar("HOST");
  }

  let port = DEFAULT_PORT;
  sources.port = "default";
  if (file.port !== undefined) {
    port = resolvePort(file.port, `${path} "port"`);
    sources.port = path;
  }
  const portEnv = env[envVar("PORT")];
  if (portEnv !== undefined && portEnv !== "") {
    port = resolvePort(portEnv, envVar("PORT"));
    sources.port = envVar("PORT");
  }

  const token = resolveToken(env, file, path, sources);

  return { host, port, ...(token === undefined ? {} : { token }), sources };
}

/**
 * The auth slot. Every product route is unauthenticated today (SCRUM-8), so this
 * resolves to undefined and no Authorization header is sent. The slot exists so
 * that adding auth later is not a breaking change to this config contract.
 *
 * TOKEN_FILE is the preferred form and the reason it exists is worth stating:
 * SecretRef support covers only `plugins.entries.<id>.config`, the one surface a
 * stdio subprocess cannot read. A path is not a secret, so pointing at a file
 * keeps the credential out of openclaw.json. That is weaker than SecretRef.
 */
function resolveToken(
  env: NodeJS.ProcessEnv,
  file: FileConfig,
  path: string,
  sources: Record<string, string>,
): string | undefined {
  const tokenFile = env[envVar("TOKEN_FILE")];
  if (tokenFile !== undefined && tokenFile !== "") {
    let contents: string;
    try {
      contents = readFileSync(tokenFile, "utf8");
    } catch (error) {
      throw new Error(
        `${envVar("TOKEN_FILE")} points at ${tokenFile}, which cannot be read: ${String(error)}`,
      );
    }
    const trimmed = contents.trim();
    if (trimmed.length === 0) {
      throw new Error(`${envVar("TOKEN_FILE")} points at ${tokenFile}, which is empty`);
    }
    sources.token = envVar("TOKEN_FILE");
    return trimmed;
  }

  const tokenEnv = env[envVar("TOKEN")];
  if (tokenEnv !== undefined && tokenEnv !== "") {
    sources.token = envVar("TOKEN");
    return tokenEnv;
  }

  if (typeof file.token === "string" && file.token.length > 0) {
    sources.token = path;
    return file.token;
  }

  sources.token = "unset";
  return undefined;
}

/** Base URL for the product. No scheme override yet; adding one is additive. */
export const baseUrl = (config: Config): string => `http://${config.host}:${config.port}`;

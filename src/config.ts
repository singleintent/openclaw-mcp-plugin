/**
 * Config resolution for the MCP subprocess.
 *
 * Plugin config cannot reach this subprocess, but the manifest can hand it a
 * path, and that is how the config file becomes per-instance. Measured against
 * OpenClaw 2026.9.5:
 *
 *  - Manifest `mcpServers.env` values ARE templated, by exactly one token.
 *    `${CLAUDE_PLUGIN_ROOT}` expands to this package's own install root, which is
 *    inside the engine's state directory, so each engine's copy of this plugin
 *    resolves a different path. The loader knows two other tokens,
 *    `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, and both stay literal here: they are
 *    gated on a plugin-data directory that only Agent-Plugins-format bundles
 *    (root `plugin.json` plus `mcp.json`) are given, and that format cannot be
 *    installed from npm — the npm install path validates `openclaw.extensions`
 *    and never reaches the bundle branch. An earlier revision of this comment
 *    said `env` took no templating; that was measured with `${PLUGIN_ROOT}`,
 *    which genuinely does nothing, and the conclusion was wrong.
 *  - The child does not inherit the Gateway environment. It receives exactly
 *    HOME, LOGNAME, PATH, SHELL, USER and __CF_USER_TEXT_ENCODING, plus whatever
 *    the server definition declares.
 *  - The only runtime MCP hook resolves `url`/`headers` for HTTP transports
 *    rather than stdio env.
 *
 * Overriding `mcp.servers.singleintent` in openclaw.json replaces the manifest
 * definition wholesale rather than merging: the manifest-derived map and the
 * configured map are combined by a shallow spread keyed by server name, so an
 * override that sets only `env` yields a definition with no `command` and the
 * server is skipped with "command is missing and its url is missing" — a silent
 * disabling. `openclaw config set` ACCEPTS such an entry; a write succeeding says
 * nothing about the server resolving, and the two layers must not be confused.
 * The route stays available to a consumer who restates the whole block.
 *
 * The file the manifest names lives inside the install root, so a reinstall
 * removes it: the managed npm project directory is content-addressed and a new
 * version gets a new directory. That is accepted rather than overlooked. Install
 * is the moment the binding is made, the product rewrites the file as the last
 * step of install, and its health check reports the gap in between. Nothing here
 * treats an absent file as fatal — see `configFile` on Config for what is
 * recorded instead.
 *
 * Precedence, highest first:
 *   1. environment variables
 *   2. the config file, at $SINGLEINTENT_CONFIG — which the manifest points at
 *      this package's install root — or $HOME/.singleintent/config.json when
 *      nothing sets it
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
 *
 * The override is currently forward-looking rather than immediately useful: the
 * product binds loopback only (`web/server.mjs:50` hardcodes `HOST`) and rejects
 * any Host header outside 127.0.0.1, localhost and [::1]. So pointing this at a
 * remote host needs a product-side change first. Having the override costs
 * nothing now and adding one later would be a breaking config change.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The product's own port, chosen and defended rather than inherited: Vite was
 * deliberately moved to 5174 so the product server could keep 5173
 * (`web/server.mjs:47`, `ui/vite.config.js`). The resemblance to Vite's default
 * is what makes it look accidental; it is the opposite.
 *
 * The product honours `PORT`, so the override here exists to follow it.
 */
export const DEFAULT_PORT = 5173;

export type Config = {
  host: string;
  port: number;
  /** Absent until the product grows auth; see SCRUM-8. */
  token?: string;
  /** Where each value came from, for diagnostics. */
  sources: Record<string, string>;
  /** The file consulted, and whether it was there. */
  configFile: ConfigFileOrigin;
};

/**
 * Provenance for the config file, carried so a failure can name it.
 *
 * `present: false` with `explicit: true` is the one combination worth acting on,
 * and it is why this is recorded rather than inferred at the call site: something
 * deliberately pointed this process at a file and the file is not there, so the
 * port in use is the built-in default — which belongs to whichever product
 * instance happens to hold it, not to no instance at all. That is strictly worse
 * than having no port, and it is invisible from the values alone, because a
 * defaulted port and a correctly-defaulted port are the same integer.
 *
 * Deliberately not an error at load time. The default path is unset for anyone
 * who installed this plugin without the product, and for them an absent file is
 * normal; failing closed would break that install to protect a case this process
 * cannot detect anyway. Whether the port reaches the right instance is only
 * answerable by the product, and its health check is what answers it.
 */
export type ConfigFileOrigin = {
  path: string;
  /** False when the file was absent, which is not an error. */
  present: boolean;
  /** True when $SINGLEINTENT_CONFIG named the path, rather than the default. */
  explicit: boolean;
};

type FileConfig = {
  host?: unknown;
  port?: unknown;
  token?: unknown;
};

export const configFilePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env[envVar("CONFIG")] ?? join(homedir(), CONFIG_DIR_NAME, "config.json");

function readConfigFile(path: string): { file: FileConfig; present: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent is normal: env and defaults suffice. The absence is reported rather
    // than swallowed, so a later failure can say the file was looked for.
    if (code === "ENOENT") return { file: {}, present: false };
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
  return { file: parsed as FileConfig, present: true };
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
  const { file, present } = readConfigFile(path);
  const configFile: ConfigFileOrigin = {
    path,
    present,
    explicit: env[envVar("CONFIG")] !== undefined,
  };
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

  return { host, port, ...(token === undefined ? {} : { token }), sources, configFile };
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

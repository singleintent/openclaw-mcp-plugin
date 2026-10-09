/**
 * Every brand-derived string, in one place.
 *
 * The org was renamed once already (`singleinstinct` → `singleintent`). The env
 * prefix and the config directory are public contract from first publish, so a
 * further rename stops being one edit and becomes a breaking change for every
 * consumer. Keeping them here means the edit stays single until that point.
 *
 * These are written out rather than derived from BRAND at runtime so that
 * `SINGLEINTENT_HOST` is greppable in this repo and in a consumer's shell
 * history. src/names.test.ts asserts they stay consistent with BRAND.
 */

/** Product name, lowercase. Manifest `id` and `mcpServers` key both equal this. */
export const BRAND = "singleintent";

/** Prefix for every environment variable this plugin reads. Public contract. */
export const ENV_PREFIX = "SINGLEINTENT_";

/** Directory under $HOME holding the optional config file. Public contract. */
export const CONFIG_DIR_NAME = ".singleintent";

/**
 * Name of the per-instance config file the manifest points `SINGLEINTENT_CONFIG`
 * at, resolved against this package's own install root.
 *
 * Public contract in the strongest sense of any string here: it is the entire
 * agreement between this package and the product. The product writes this file at
 * install; this package reads whatever path it was handed. Neither side computes
 * the other's layout, which is the point — every alternative required one of them
 * to encode the other's directory shape, and both shapes have moved.
 */
export const INSTANCE_FILE_NAME = "instance.json";

/** Name the MCP handshake advertises; OpenClaw prefixes tools with it. */
export const SERVER_NAME = BRAND;

/**
 * The version the MCP handshake advertises, and the third copy of a string that
 * also lives in `package.json`, `openclaw.plugin.json` and `package-lock.json`.
 *
 * Four copies is not a design anyone would choose; it is what the formats force.
 * npm publishes `package.json`, `openclaw plugins inspect` reports the manifest's,
 * `npm ci` fails on a lockfile that disagrees with either, and this constant is
 * what a caller sees over stdio. None of the four can read another at build time
 * without giving up something: importing `package.json` here would need
 * `resolveJsonModule` and would put the whole manifest in `dist/`.
 *
 * So they are kept in step by assertion instead, in `src/names.test.ts`, which
 * covers all four and the README's quoted handshake output. That test is the reason
 * writing the version by hand in four places is safe rather than reckless — a bump
 * that misses one fails the suite before it can reach a registry.
 */
export const SERVER_VERSION = "0.1.3";

/** Fully qualified name of an env var this plugin reads. */
export const envVar = (suffix: string): string => `${ENV_PREFIX}${suffix}`;

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

/** Name the MCP handshake advertises; OpenClaw prefixes tools with it. */
export const SERVER_NAME = BRAND;

/** Kept in step with package.json and the manifest by src/names.test.ts. */
export const SERVER_VERSION = "0.1.0";

/** Fully qualified name of an env var this plugin reads. */
export const envVar = (suffix: string): string => `${ENV_PREFIX}${suffix}`;

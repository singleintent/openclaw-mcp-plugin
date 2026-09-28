/**
 * HTTP client for the product API.
 *
 * Every route is unauthenticated today (SCRUM-8). The Authorization header is
 * sent only when a token resolves, so adding auth later changes no call site.
 */
import { baseUrl, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./names.js";

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Where to get the product, for the one failure that means the caller may not
 * have it at all.
 *
 * The install story is two artifacts: this plugin comes from the store, the
 * product is downloaded separately. So "plugin installed, product not running" is
 * the **normal first state**, not an edge case, and an error that only says
 * "cannot reach 127.0.0.1:5173" is a precise diagnostic for someone who already
 * has the product and a dead end for someone who does not. SCRUM-6's instruction
 * is that the failure should be the on-ramp.
 *
 * **The root, and nothing deeper.** Verified 2026-09-28: the root returns `200`,
 * while `/install`, `/download`, `/get-started` and `/docs` all return `404`. A
 * guessed path would put a dead link inside an error message, which is worse than
 * no link. `www` is also avoided — it resolves to the same addresses as the apex
 * but its TLS certificate does not cover the name, so an `https://www.` link
 * fails certificate validation.
 *
 * **Known gap:** there is no install or download page at that domain yet; the root
 * serves a placeholder. The link is honest — "here is the product" — but cannot
 * yet complete the journey. This constant is the single place to re-point when a
 * real page exists, which is the reason it is a constant rather than inline text.
 */
export const PRODUCT_SITE_URL = "https://singleintent.com";

export class ProductError extends Error {}

/**
 * The product answered, but something it depends on did not.
 *
 * This distinction is not decorative. The product splits its own failures by
 * where they came from: routes that proxy the OpenClaw Gateway (`/api/agents`,
 * `/api/activity`) fail `502`, while routes backed by its own flat-file store
 * (`/api/projects`, `/api/templates`, `/api/connections`, `/api/backlog`) fail
 * `500`. "The product is up but the Gateway is down" is a genuinely different
 * state from "the product is down" — different owner, different fix — and
 * flattening both into "unreachable" throws away the only signal that tells them
 * apart. A subclass rather than a flag, so a caller can branch on the type and
 * every existing `catch (ProductError)` still catches it.
 *
 * Unreachability is a third state again, and stays on `ProductError` proper:
 * nothing answered at all, so there is no upstream to blame.
 */
export class ProductUpstreamError extends ProductError {}

/** Statuses that mean the responder failed on behalf of something further up. */
const UPSTREAM_STATUSES = new Set([502, 503, 504]);

export type RequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function getJson<T>(
  config: Config,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = `${baseUrl(config)}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `${SERVER_NAME}-openclaw-mcp-plugin/${SERVER_VERSION}`,
  };
  if (config.token !== undefined) {
    headers.authorization = `Bearer ${config.token}`;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, options.signal]);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    // Name the endpoint. "fetch failed" with no URL is the least useful
    // diagnostic a consumer can receive when the product simply is not running.
    //
    // This is the only branch that gets the site link, and the reason is that it
    // is the only one where *not having the product* is a live possibility.
    // Nothing answered, so nothing proves the product is installed. The branches
    // below all had the product answer, which settles that question — see the
    // comment on each.
    const reason = signal.aborted ? `timed out after ${timeoutMs}ms` : String(error);
    throw new ProductError(
      `cannot reach the product at ${url} (${reason}). ` +
        `Is it running, and are host and port correct? ` +
        `host=${config.sources.host} port=${config.sources.port}. ` +
        `If you do not have the SingleIntent product yet, get it at ` +
        `${PRODUCT_SITE_URL} — the plugin and the product are separate downloads.`,
    );
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 400);
    const detail = `${url} returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
    if (UPSTREAM_STATUSES.has(response.status)) {
      // Deliberately no site link. The product answered this request, so the
      // caller demonstrably has it; telling them to go and download it would be
      // actively wrong advice pointing at the wrong component. The message
      // already sends them to the Gateway, which is the thing that failed.
      throw new ProductUpstreamError(
        `${detail}. The product is running and answered this request; the upstream ` +
          `it proxies — the OpenClaw Gateway — is what failed. Check the Gateway, ` +
          `not the product at host=${config.sources.host} port=${config.sources.port}.`,
      );
    }
    // Also no link: a non-upstream status means the product is running and
    // refused this request. Whatever is wrong, it is not a missing install.
    throw new ProductError(detail);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    // No link here either, for the same reason: a 2xx that is not JSON came from
    // something that answered on the configured port. That is a wrong-endpoint or
    // wrong-version problem, not a missing product.
    throw new ProductError(`${url} did not return valid JSON: ${String(error)}`);
  }
}

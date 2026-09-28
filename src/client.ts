/**
 * HTTP client for the product API.
 *
 * Every route is unauthenticated today (SCRUM-8). The Authorization header is
 * sent only when a token resolves, so adding auth later changes no call site.
 */
import { baseUrl, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./names.js";

export const DEFAULT_TIMEOUT_MS = 10_000;

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
    const reason = signal.aborted ? `timed out after ${timeoutMs}ms` : String(error);
    throw new ProductError(
      `cannot reach the product at ${url} (${reason}). ` +
        `Is it running, and are host and port correct? ` +
        `host=${config.sources.host} port=${config.sources.port}`,
    );
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 400);
    const detail = `${url} returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
    if (UPSTREAM_STATUSES.has(response.status)) {
      throw new ProductUpstreamError(
        `${detail}. The product is running and answered this request; the upstream ` +
          `it proxies — the OpenClaw Gateway — is what failed. Check the Gateway, ` +
          `not the product at host=${config.sources.host} port=${config.sources.port}.`,
      );
    }
    throw new ProductError(detail);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProductError(`${url} did not return valid JSON: ${String(error)}`);
  }
}

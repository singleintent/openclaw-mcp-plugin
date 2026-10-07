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

/** A non-2xx response from the product, retaining its machine-readable contract. */
export class ProductApiError extends ProductError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

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
export class ProductUpstreamError extends ProductApiError {}

/**
 * The product answered, and refused because the thing asked for is already done.
 *
 * Only the write routes can produce this, and it is the failure a caller is most
 * likely to reach by retrying: `apply_role` refuses an agent that already has a
 * role record in any state, and `create_connection` refuses a pair that already
 * exists. Both answer `409`.
 *
 * Separated from `ProductError` for the same reason `ProjectNotFoundError` is
 * separated on the read side: "this was already done" and "the product is broken"
 * call for opposite responses — stop, versus try again — and a caller that cannot
 * tell them apart will retry the one request where retrying is never right. A
 * subclass, so existing `catch (ProductError)` still catches it.
 */
export class ProductConflictError extends ProductApiError {}

/** Statuses that mean the responder failed on behalf of something further up. */
const UPSTREAM_STATUSES = new Set([502, 503, 504]);

/**
 * The one sentence that turns "wrong port" from a hunt into a reading.
 *
 * Something pointed this process at a config file and the file was not there, so
 * the port above is the built-in default. On a machine running one product that
 * is also the right answer, which is exactly why this needs saying: the values
 * alone cannot distinguish a default that happens to be correct from a binding
 * that was never written. Said only when a file was explicitly named and missing,
 * so an install that never had one stays quiet.
 */
function unboundInstance(config: Config): string {
  const { path, present, explicit } = config.configFile;
  if (present || !explicit) return "";
  return (
    ` No instance binding was found at ${path}, so that port is this plugin's ` +
    `built-in default rather than a port any product told it to use — reinstall ` +
    `the connector from the product to write the binding.`
  );
}

export type RequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** The write methods the product exposes. No DELETE: it has no delete route. */
export type WriteMethod = "POST" | "PUT";

async function request<T>(
  config: Config,
  method: "GET" | WriteMethod,
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<T> {
  const url = `${baseUrl(config)}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `${SERVER_NAME}-openclaw-mcp-plugin/${SERVER_VERSION}`,
  };
  if (config.token !== undefined) {
    headers.authorization = `Bearer ${config.token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, options.signal]);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      // JSON.stringify drops keys whose value is undefined, which is the
      // behaviour `update_template` depends on: an omitted argument has to reach
      // the product as genuinely absent, because the product applies each field
      // only if it is not undefined. Sending null instead would overwrite.
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
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
    // A write that timed out is not a write that did not happen. The request
    // reached the product or it did not, and from here there is no way to tell;
    // the product may still be working and may still commit. Retrying is how a
    // caller turns one uncertain write into two certain ones, so the message says
    // to check first. Only on a timeout: if the connection was refused outright,
    // nothing was received and there is nothing to have half-done.
    const uncertain =
      method !== "GET" && signal.aborted
        ? ` The ${method} may still be in progress on the product and may still ` +
          `complete — check with the matching read verb before retrying, because ` +
          `retrying would write twice.`
        : "";
    throw new ProductError(
      `cannot reach the product at ${url} (${reason}).${uncertain} ` +
        `Is it running, and are host and port correct? ` +
        `host=${config.sources.host} port=${config.sources.port}.${unboundInstance(config)} ` +
        `If you do not have the SingleIntent product yet, get it at ` +
        `${PRODUCT_SITE_URL} — the plugin and the product are separate downloads.`,
    );
  }

  if (!response.ok) {
    const rawBody = (await response.text().catch(() => "")).slice(0, 400);
    let responseBody: unknown;
    try {
      responseBody = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      responseBody = undefined;
    }
    const bodyRecord =
      typeof responseBody === "object" && responseBody !== null
        ? (responseBody as Record<string, unknown>)
        : undefined;
    const apiMessage = typeof bodyRecord?.error === "string" ? bodyRecord.error : undefined;
    const code = typeof bodyRecord?.code === "string" ? bodyRecord.code : undefined;
    const bodyText = apiMessage
      ? `: ${apiMessage}${code ? ` (code: ${code})` : ""}`
      : rawBody
        ? `: ${rawBody}`
        : "";
    const detail = `${url} returned ${response.status} ${response.statusText}${bodyText}`;
    if (response.status === 503 && code === "auth-unavailable") {
      throw new ProductApiError(
        `${detail}. The work-item credential mapping is unavailable or unsafe; an operator must repair it before writes can proceed.`,
        response.status,
        code,
        responseBody,
      );
    }
    if (UPSTREAM_STATUSES.has(response.status)) {
      // Deliberately no site link. The product answered this request, so the
      // caller demonstrably has it; pointing at a download page would be wrong.
      throw new ProductUpstreamError(
        `${detail}. The product is running and answered this request; the upstream ` +
          `it proxies — the OpenClaw Gateway — is what failed. Check the Gateway, ` +
          `not the product at host=${config.sources.host} port=${config.sources.port}.`,
        response.status,
        code,
        responseBody,
      );
    }
    if (response.status === 409) {
      throw new ProductConflictError(
        `${detail}. For a 409, retrying cannot succeed unchanged; read the current record before deciding what to do next.`,
        response.status,
        code,
        responseBody,
      );
    }
    // Preserve status and the product's code for typed callers.
    throw new ProductApiError(detail, response.status, code, responseBody);
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

export async function getJson<T>(
  config: Config,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(config, "GET", path, undefined, options);
}

/**
 * A write: the body in, the product's JSON out, and nothing in between.
 *
 * One function for POST and PUT rather than two, because the method is the only
 * thing that differs and a second wrapper would be a second place for the header
 * and error handling to drift.
 */
export async function sendJson<T>(
  config: Config,
  method: WriteMethod,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(config, method, path, body, options);
}

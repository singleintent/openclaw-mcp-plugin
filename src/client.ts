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
    throw new ProductError(
      `${url} returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProductError(`${url} did not return valid JSON: ${String(error)}`);
  }
}

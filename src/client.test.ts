/**
 * Which failures carry the on-ramp link, and — more importantly — which do not.
 *
 * The link is right on exactly one branch: nothing answered, so nothing proves the
 * caller has the product at all. Every other branch had the product answer, which
 * settles that question, and pointing those callers at a download page would be
 * confidently wrong advice about the wrong component.
 *
 * The absence assertions are the point of this file. A link creeping into the 502
 * message is the regression that would never announce itself — the message would
 * still look helpful while sending a Gateway problem to a download page.
 *
 * Each case runs against a real local server rather than a mocked `fetch`, so the
 * branch is selected by a real response the way it is in production. The
 * unreachable case binds a port and closes it, so "nothing listening" is a fact
 * rather than a stub's opinion.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_SITE_URL, ProductError, ProductUpstreamError, getJson } from "./client.js";
import { loadConfig, type Config } from "./config.js";

let running: Server | undefined;

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

/** Start a server that answers everything the same way, and point a config at it. */
async function serving(
  handler: (respond: (status: number, body: string, type?: string) => void) => void,
): Promise<Config> {
  const server = createServer((_req, res) => {
    handler((status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
  });
  running = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { ...loadConfig({}), host: "127.0.0.1", port };
}

/** A port that was bound and then released, so nothing is listening on it. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("nothing answered — the one branch that gets the link", () => {
  it("names the URL, the reason, the provenance and the site", async () => {
    const config = { ...loadConfig({}), host: "127.0.0.1", port: await deadPort() };

    await expect(getJson(config, "/api/projects")).rejects.toThrow(ProductError);
    const error = await getJson(config, "/api/projects").catch((e: Error) => e);
    const message = error.message;

    expect(message).toContain(`http://127.0.0.1:${config.port}/api/projects`);
    expect(message).toContain("cannot reach the product");
    expect(message).toContain("host=");
    expect(message).toContain("port=");
    expect(message).toContain(PRODUCT_SITE_URL);
    // The reason someone might not have it, which is the actual insight.
    expect(message).toContain("separate downloads");
  }, 20_000);

  it("is a plain ProductError, not an upstream one", async () => {
    const config = { ...loadConfig({}), host: "127.0.0.1", port: await deadPort() };
    const error = await getJson(config, "/api/agents").catch((e: Error) => e);
    expect(error).toBeInstanceOf(ProductError);
    expect(error).not.toBeInstanceOf(ProductUpstreamError);
  }, 20_000);
});

describe("the product answered — no link, and this is what can silently regress", () => {
  it("omits the link from a 502, and still points at the Gateway", async () => {
    const config = await serving((respond) =>
      respond(502, JSON.stringify({ error: "gateway unreachable" })),
    );
    const error = await getJson(config, "/api/agents").catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductUpstreamError);
    // The assertion the item calls out: absence, stated explicitly.
    expect(error.message).not.toContain(PRODUCT_SITE_URL);
    expect(error.message).not.toContain("singleintent.com");
    // And the message still does its real job.
    expect(error.message).toContain("the OpenClaw Gateway");
    expect(error.message).toContain("502");
  }, 20_000);

  it.each([503, 504])("omits the link from %i as well", async (status) => {
    const config = await serving((respond) => respond(status, "{}"));
    const error = await getJson(config, "/api/activity").catch((e: Error) => e);
    expect(error).toBeInstanceOf(ProductUpstreamError);
    expect(error.message).not.toContain("singleintent.com");
  }, 20_000);

  it("omits the link from a 500, which means the product refused", async () => {
    const config = await serving((respond) =>
      respond(500, JSON.stringify({ error: "store read failed" })),
    );
    const error = await getJson(config, "/api/backlog").catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductError);
    expect(error).not.toBeInstanceOf(ProductUpstreamError);
    expect(error.message).not.toContain("singleintent.com");
    expect(error.message).toContain("500");
  }, 20_000);

  it("omits the link from a 404", async () => {
    const config = await serving((respond) => respond(404, "not found", "text/plain"));
    const error = await getJson(config, "/api/nope").catch((e: Error) => e);
    expect(error.message).not.toContain("singleintent.com");
  }, 20_000);

  it("omits the link when a 200 is not JSON", async () => {
    // Something answered on the port; that is a wrong endpoint, not a missing
    // install, so a download link would be the wrong advice.
    const config = await serving((respond) => respond(200, "<html>hello</html>", "text/html"));
    const error = await getJson(config, "/api/projects").catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductError);
    expect(error.message).not.toContain("singleintent.com");
    expect(error.message).toContain("did not return valid JSON");
  }, 20_000);
});

describe("the URL lives in exactly one place", () => {
  /**
   * Scans the shipped sources rather than trusting the constant to be the only
   * copy. The failure this prevents is someone adding the link to a second error
   * message by hand: the link would then be right in two places and wrong in one
   * of them the moment a real install page exists and the constant is re-pointed.
   * Test files are excluded — assertions naturally name the domain.
   */
  it("appears exactly once across the shipped sources", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    expect(sources.length).toBeGreaterThan(5);

    const hits = sources.flatMap((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      const count = text.split("https://singleintent.com").length - 1;
      return count > 0 ? [`${name}:${count}`] : [];
    });
    expect(hits).toEqual(["client.ts:1"]);
  });

  it("is the constant, and the constant is the apex with no path", () => {
    expect(PRODUCT_SITE_URL).toBe("https://singleintent.com");
    // No trailing slash and no guessed path: every deeper path 404s today.
    expect(PRODUCT_SITE_URL).not.toMatch(/\/$/);
    expect(new URL(PRODUCT_SITE_URL).pathname).toBe("/");
    // Not www: it resolves to the same addresses but its certificate does not
    // cover the name, so an https://www. link fails validation.
    expect(PRODUCT_SITE_URL).not.toContain("www.");
  });
});

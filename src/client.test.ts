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
import {
  PRODUCT_SITE_URL,
  ProductConflictError,
  ProductError,
  ProductUpstreamError,
  getJson,
  sendJson,
} from "./client.js";
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

  /**
   * The failure this exists for: the manifest named a config file, the product has
   * not written it, and the port in the message is therefore this plugin's default
   * rather than anyone's instance. Without the sentence the message is accurate and
   * useless — it names a port that looks configured, because a default port and a
   * correct port are the same integer.
   */
  it("says the instance binding is missing when a named file is absent", async () => {
    const config: Config = {
      ...loadConfig({}),
      host: "127.0.0.1",
      port: await deadPort(),
      configFile: { path: "/nowhere/instance.json", present: false, explicit: true },
    };
    const error = await getJson(config, "/api/projects").catch((e: Error) => e);
    expect(error.message).toContain("No instance binding was found at /nowhere/instance.json");
    expect(error.message).toContain("built-in default");
  }, 20_000);

  it("stays quiet when no config file was named", async () => {
    const config: Config = {
      ...loadConfig({}),
      host: "127.0.0.1",
      port: await deadPort(),
      configFile: { path: "/nowhere/config.json", present: false, explicit: false },
    };
    const error = await getJson(config, "/api/projects").catch((e: Error) => e);
    expect(error.message).not.toContain("No instance binding");
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

/**
 * The write side of the error surface: the two branches a read can never reach.
 *
 * Both are about what a caller should do next, which is the only thing an error on a
 * write is for. A conflict means stop. A timeout means find out before repeating,
 * because the write may have landed.
 */
describe("a write that conflicts", () => {
  it("is its own type, so a caller can tell it from a broken product", async () => {
    const config = await serving((respond) =>
      respond(409, JSON.stringify({ error: "role already applied", status: "applied" })),
    );
    const error = await sendJson(config, "POST", "/api/agent-roles", { agentId: "a" }).catch(
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(ProductConflictError);
    // A subclass, so code that already catches ProductError still does.
    expect(error).toBeInstanceOf(ProductError);
  }, 20_000);

  it("carries the product's own account of what already exists", async () => {
    const config = await serving((respond) =>
      respond(409, JSON.stringify({ error: "role already applied", status: "applied" })),
    );
    const error = await sendJson(config, "POST", "/api/agent-roles", {}).catch((e: Error) => e);

    expect(error.message).toContain("role already applied");
    expect(error.message).toContain("409");
  }, 20_000);

  it("says retrying cannot succeed, which is the point of separating it", async () => {
    // This is the failure a model is most likely to answer by trying again.
    const config = await serving((respond) => respond(409, "{}"));
    const error = await sendJson(config, "POST", "/api/connections", {}).catch((e: Error) => e);

    expect(error.message).toMatch(/retrying cannot succeed/);
    expect(error.message).not.toContain(PRODUCT_SITE_URL);
  }, 20_000);

  it("does not make a conflict look like an upstream failure", async () => {
    const config = await serving((respond) => respond(409, "{}"));
    const error = await sendJson(config, "POST", "/api/connections", {}).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(ProductUpstreamError);
  }, 20_000);
});

describe("a write that timed out may still have been written", () => {
  /** Nothing listening, so the deadline is reached rather than simulated. */
  const stalling = async (): Promise<Config> => {
    const server = createServer(() => {
      // Accept the connection and never answer, which is what a long agent turn
      // looks like from here.
    });
    running = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { ...loadConfig({}), host: "127.0.0.1", port };
  };

  it.each(["POST", "PUT"] as const)("warns that a %s may still complete", async (method) => {
    const config = await stalling();
    const error = await sendJson(config, method, "/api/chat", {}, { timeoutMs: 150 }).catch(
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(ProductError);
    expect(error.message).toContain("timed out after 150ms");
    expect(error.message).toContain("may still");
    // The instruction that follows from it, without which the warning is noise.
    expect(error.message).toMatch(/check with the matching read verb before retrying/);
    expect(error.message).toContain("write twice");
  }, 20_000);

  it("says nothing of the kind on a read, which cannot have changed anything", async () => {
    const config = await stalling();
    const error = await getJson(config, "/api/projects", { timeoutMs: 150 }).catch(
      (e: Error) => e,
    );

    expect(error.message).toContain("timed out after 150ms");
    expect(error.message).not.toContain("may still");
    expect(error.message).not.toContain("write twice");
  }, 20_000);

  it("says nothing of the kind when the connection was refused outright", async () => {
    // Nothing was received, so there is nothing to have half-done. Warning here
    // would teach a caller to distrust a failure that is unambiguous.
    const config = { ...loadConfig({}), host: "127.0.0.1", port: await deadPort() };
    const error = await sendJson(config, "POST", "/api/projects", {}).catch((e: Error) => e);

    expect(error).toBeInstanceOf(ProductError);
    expect(error.message).not.toContain("may still");
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

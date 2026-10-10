import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config.js";
import { ProductApiError, ProductConflictError } from "../client.js";
import {
  WorkitemReadError,
  createWorkitem,
  generateUuidV7,
  getWorkitem,
  listWorkitems,
  workitemSetState,
} from "./workitems.js";

const PROJECT = "1634aa11-2222-4333-8444-555566667777";
const ITEM = "019b1234-5678-7abc-8def-0123456789ab";
const EVENT = "019b1234-5678-7abc-8def-0123456789ac";
let server: Server | undefined;
let requests: { method: string; url: string; body: string; authorization?: string }[] = [];
let responseStatus = 200;
let responseBody: unknown;

const item = {
  id: ITEM,
  title: "Task",
  intent: "Do it",
  state: "open",
  updatedAtFrom: "ledger",
};
const event = {
  id: EVENT,
  type: "created",
  actor: "agent-from-server",
  at: "2026-10-08T00:00:00Z",
};
const detail = (extra: Record<string, unknown> = {}) => ({
  readOk: true,
  project: PROJECT,
  found: true,
  item,
  events: [event],
  ledger: { deduplicated: 0 },
  event,
  deduplicated: false,
  ...extra,
});

async function config(): Promise<Config> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw,
        authorization: req.headers.authorization as string | undefined,
      });
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  responseStatus = 200;
  responseBody = detail();
  return {
    ...loadConfig({}),
    host: "127.0.0.1",
    port: (server.address() as { port: number }).port,
  };
}

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  requests = [];
  responseStatus = 200;
  responseBody = undefined;
});

describe("project-scoped work-item reads", () => {
  it("lists from the required project endpoint and keeps the typed list envelope", async () => {
    const cfg = await config();
    responseBody = {
      readOk: true,
      project: PROJECT,
      items: [item],
      store: {},
      index: {},
    };
    const result = await listWorkitems(cfg, { projectId: PROJECT });
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "/api/workitems?project=" + PROJECT,
    });
    expect(result.items[0]?.intent).toBe("Do it");
  });

  it("gets detail and history using both item and project scope", async () => {
    const cfg = await config();
    const result = await getWorkitem(cfg, { projectId: PROJECT, itemId: ITEM });
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "/api/workitems/" + ITEM + "?project=" + PROJECT,
    });
    expect(result.events).toEqual([event]);
    expect(result.item?.intent).toBe("Do it");
  });

  it("returns a typed found=false result for a missing item", async () => {
    const cfg = await config();
    responseStatus = 404;
    responseBody = {
      readOk: true,
      project: PROJECT,
      found: false,
      item: null,
      events: [],
    };
    await expect(
      getWorkitem(cfg, { projectId: PROJECT, itemId: ITEM }),
    ).resolves.toMatchObject({ found: false, item: null });
  });

  it("surfaces readOk=false as a typed read error, not an empty list", async () => {
    const cfg = await config();
    responseBody = {
      readOk: false,
      project: PROJECT,
      items: [],
      reason: "store is missing",
    };
    await expect(
      listWorkitems(cfg, { projectId: PROJECT }),
    ).rejects.toBeInstanceOf(WorkitemReadError);
    await expect(listWorkitems(cfg, { projectId: PROJECT })).rejects.toThrow(
      /store is missing/,
    );
  });

  it("refuses missing or malformed project scope before HTTP", async () => {
    const cfg = await config();
    await expect(listWorkitems(cfg, { projectId: undefined })).rejects.toThrow(
      /projectId/,
    );
    await expect(
      getWorkitem(cfg, { projectId: PROJECT, itemId: "not-an-id" }),
    ).rejects.toThrow(/itemId/);
    expect(requests).toEqual([]);
  });
});

describe("work-item writes", () => {
  it("forwards a configured bearer token without placing it in JSON", async () => {
    const cfg = { ...(await config()), token: "test-workitem-secret" };
    await createWorkitem(cfg, { projectId: PROJECT, title: "Task", intent: "Do it", eventId: EVENT });
    expect(requests[0]?.authorization).toBe("Bearer test-workitem-secret");
    expect(requests[0]?.body).not.toContain("test-workitem-secret");
  });

  it("sends create payload with project and stable event id, never actor or time", async () => {
    const cfg = await config();
    const result = await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      eventId: EVENT,
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/workitems?project=" + PROJECT,
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      eventId: EVENT,
      title: "Task",
      intent: "Do it",
    });
    expect(result.item.state).toBe("open");
    expect(result.event.actor).toBe("agent-from-server");
  });

  it("sends an optional estimate on create, and only when given (SCRUM-150)", async () => {
    const cfg = await config();
    await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      estimate: "M",
      eventId: EVENT,
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      eventId: EVENT,
      title: "Task",
      intent: "Do it",
      estimate: "M",
    });
    await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      estimate: undefined,
      eventId: EVENT,
    });
    expect(JSON.parse(requests[1]!.body)).not.toHaveProperty("estimate");
  });

  it("leaves estimate validation to the server and keeps its 400 invalid-estimate", async () => {
    const cfg = await config();
    responseStatus = 400;
    responseBody = {
      error: "estimate must be one of XS, S, M, L, XL",
      code: "invalid-estimate",
    };
    const error = await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      estimate: "XXL",
      eventId: EVENT,
    }).catch((value: unknown) => value);
    expect(JSON.parse(requests[0]!.body).estimate).toBe("XXL");
    expect(error).toBeInstanceOf(ProductApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid-estimate" });
    expect((error as Error).message).toContain(
      "estimate must be one of XS, S, M, L, XL",
    );
  });

  it("generates a UUIDv7 when the optional id is omitted", async () => {
    const cfg = await config();
    await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
    });
    expect(JSON.parse(requests[0]!.body).eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generateUuidV7(0)).toMatch(
      /^00000000-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("reuses exactly the supplied event id and body on retries", async () => {
    const cfg = await config();
    await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      eventId: EVENT,
    });
    responseStatus = 200;
    responseBody = detail({ deduplicated: true });
    const retry = await createWorkitem(cfg, {
      projectId: PROJECT,
      title: "Task",
      intent: "Do it",
      eventId: EVENT,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(JSON.parse(requests[1]!.body).eventId).toBe(EVENT);
    expect(retry.deduplicated).toBe(true);
  });

  it("sets one allowed target state with optional metadata and no caller actor/time", async () => {
    const cfg = await config();
    await workitemSetState(cfg, {
      projectId: PROJECT,
      itemId: ITEM,
      state: "blocked",
      reason: "Waiting",
      evidence: "issue-42",
      eventId: EVENT,
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/workitems/" + ITEM + "/state?project=" + PROJECT,
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      eventId: EVENT,
      state: "blocked",
      reason: "Waiting",
      evidence: "issue-42",
    });
  });

  it("reuses the same state event id and exact request body on retry", async () => {
    const cfg = await config();
    const input = {
      projectId: PROJECT,
      itemId: ITEM,
      state: "started",
      eventId: EVENT,
    };
    await workitemSetState(cfg, input);
    responseBody = detail({ deduplicated: true });
    await workitemSetState(cfg, input);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(JSON.parse(requests[1]!.body).eventId).toBe(EVENT);
  });

  it("validates only MVP transition targets and required reason/outcome before HTTP", async () => {
    const cfg = await config();
    await expect(
      workitemSetState(cfg, {
        projectId: PROJECT,
        itemId: ITEM,
        state: "open",
        eventId: EVENT,
      }),
    ).rejects.toThrow(/state must be one of/);
    await expect(
      workitemSetState(cfg, {
        projectId: PROJECT,
        itemId: ITEM,
        state: "blocked",
        eventId: EVENT,
      }),
    ).rejects.toThrow(/reason is required/);
    await expect(
      workitemSetState(cfg, {
        projectId: PROJECT,
        itemId: ITEM,
        state: "completed",
        eventId: EVENT,
      }),
    ).rejects.toThrow(/outcome is required/);
    expect(requests).toEqual([]);
  });

  it("sends dispatched and acknowledged with an optional reason and nothing else (SCRUM-150)", async () => {
    const cfg = await config();
    await workitemSetState(cfg, {
      projectId: PROJECT,
      itemId: ITEM,
      state: "dispatched",
      reason: "Handed to backend",
      eventId: EVENT,
    });
    await workitemSetState(cfg, {
      projectId: PROJECT,
      itemId: ITEM,
      state: "acknowledged",
      eventId: EVENT,
    });
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["POST", "/api/workitems/" + ITEM + "/state?project=" + PROJECT],
      ["POST", "/api/workitems/" + ITEM + "/state?project=" + PROJECT],
    ]);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      eventId: EVENT,
      state: "dispatched",
      reason: "Handed to backend",
    });
    expect(JSON.parse(requests[1]!.body)).toEqual({
      eventId: EVENT,
      state: "acknowledged",
    });
  });

  const dispatchRefusals: [string, Record<string, unknown>, number, string, string][] = [
    [
      "outcome or evidence on a dispatch event (400 invalid-body)",
      { state: "dispatched", outcome: "Done", evidence: "log" },
      400,
      "invalid-body",
      "dispatched takes no outcome or evidence",
    ],
    [
      "acknowledged without an earlier dispatch (409)",
      { state: "acknowledged" },
      409,
      "invalid-transition",
      "acknowledged requires a prior dispatched event",
    ],
    [
      "dispatched on a started item (409)",
      { state: "dispatched" },
      409,
      "invalid-transition",
      "dispatched is not allowed: the item has already started",
    ],
    [
      "acknowledged on a terminal item (409)",
      { state: "acknowledged" },
      409,
      "invalid-transition",
      "acknowledged is not allowed: the item is completed",
    ],
    [
      // Mocked: the server returns this once Backend's SCRUM-144 commit lands.
      "a per-agent caller that is not the assignee (403 not-assignee)",
      { state: "acknowledged" },
      403,
      "not-assignee",
      "only the assignee can acknowledge this item",
    ],
  ];

  for (const [label, extra, status, code, message] of dispatchRefusals) {
    it(`passes the server's ${label} through unchanged`, async () => {
      const cfg = await config();
      responseStatus = status;
      responseBody = { error: message, code };
      const error = await workitemSetState(cfg, {
        projectId: PROJECT,
        itemId: ITEM,
        eventId: EVENT,
        ...extra,
      } as Parameters<typeof workitemSetState>[1]).catch((value: unknown) => value);
      expect(requests).toHaveLength(1);
      const sent = JSON.parse(requests[0]!.body);
      for (const [key, value] of Object.entries(extra)) expect(sent[key]).toBe(value);
      expect(error).toBeInstanceOf(ProductApiError);
      if (status === 409) expect(error).toBeInstanceOf(ProductConflictError);
      expect(error).toMatchObject({ status, code });
      expect((error as Error).message).toContain(message);
    });
  }

  it("exposes useful typed API conflict errors with server code and status", async () => {
    const cfg = await config();
    responseStatus = 409;
    responseBody = {
      error: "transition open -> completed is not allowed",
      code: "invalid-transition",
    };
    const error = await workitemSetState(cfg, {
      projectId: PROJECT,
      itemId: ITEM,
      state: "completed",
      outcome: "Done",
      eventId: EVENT,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProductConflictError);
    expect(error).toBeInstanceOf(ProductApiError);
    expect(error).toMatchObject({ status: 409, code: "invalid-transition" });
    expect((error as Error).message).toContain(
      "transition open -> completed is not allowed",
    );
  });
});

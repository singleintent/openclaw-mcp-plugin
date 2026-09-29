/**
 * What each write verb returns, tested on the mappers directly.
 *
 * Grouped by verb in one file rather than split into six, for the same reason
 * `write-requests.test.ts` is one file: the six mappers apply a single rule, and the
 * cases worth writing are the ones where they must not agree — where a field is kept
 * in one verb and dropped in another. Those read as a contrast here and would read
 * as six unrelated files apart.
 *
 * The rule under test: bounded scalars pass through, unbounded text is dropped
 * unless it is the answer to the verb's question. Each verb below is a decision
 * about that second clause.
 */
import { describe, expect, it } from "vitest";
import { shape as applyRoleShape, summarize as roleSummarize } from "./apply-role.js";
import { shape as connectionShape, summarize as connectionSummarize } from "./create-connection.js";
import { detail as projectDetail } from "./create-project.js";
import { detail as templateDetail } from "./create-template.js";
import { shape as messageShape } from "./send-message.js";
import { detail as updatedTemplateDetail } from "./update-template.js";

describe("create_project returns the whole record, including the id", () => {
  it("passes all five fields through", () => {
    expect(
      projectDetail({
        id: "p-1",
        name: "mob2",
        workingDirectory: "/tmp/mob2",
        agentIds: [],
        createdAt: "2026-09-29T00:00:00.000Z",
      }),
    ).toEqual({
      id: "p-1",
      name: "mob2",
      workingDirectory: "/tmp/mob2",
      agentIds: [],
      createdAt: "2026-09-29T00:00:00.000Z",
    });
  });

  it("returns an empty agentIds for a new project rather than omitting it", () => {
    // The shape has to match get_project's, so a caller can hold one type.
    expect(projectDetail({ id: "p-1", name: "n" }).agentIds).toEqual([]);
  });

  it("keeps absent optional fields as null, not as empty strings", () => {
    const project = projectDetail({ id: "p-1", name: "n" });
    expect(project.workingDirectory).toBeNull();
    expect(project.createdAt).toBeNull();
  });

  it("drops non-string entries from agentIds rather than passing them through", () => {
    expect(projectDetail({ id: "p", name: "n", agentIds: ["a", 5, null, "b"] }).agentIds).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("create_template returns content, where list_templates drops it", () => {
  /**
   * The contrast that justifies the discriminator. `list_templates` cuts `content`
   * because a row without it still identifies a template well enough to choose one.
   * On a create, `content` is the confirmation of what was stored — and it is the
   * argument the caller just sent, so returning it costs them nothing they do not
   * already hold. A length would answer a question nobody asked.
   */
  it("echoes the stored content rather than a length of it", () => {
    const template = templateDetail({ id: "t-1", name: "Role", content: "the role text" });
    expect(template.content).toBe("the role text");
    expect(template).not.toHaveProperty("contentLength");
  });

  it("returns exactly the three fields the product stores", () => {
    expect(Object.keys(templateDetail({ id: "t", name: "n", content: "c" })).sort()).toEqual([
      "content",
      "id",
      "name",
    ]);
  });

  it("returns empty strings for absent required fields, not null", () => {
    // These three are always present on a successful create, so a null would be a
    // failure signal rather than a value; "" keeps the type simple for the caller.
    expect(templateDetail({})).toEqual({ id: "", name: "", content: "" });
  });
});

describe("update_template returns the text after the update", () => {
  it("carries the full stored content, which is how a partial update is confirmed", () => {
    expect(updatedTemplateDetail({ id: "t", name: "Renamed", content: "untouched" })).toEqual({
      id: "t",
      name: "Renamed",
      content: "untouched",
    });
  });
});

describe("apply_role keeps the record and drops the conversation", () => {
  it("keeps every field of the role record", () => {
    expect(
      roleSummarize({
        status: "applied",
        templateId: "t-1",
        templateName: "Role",
        content: "the role text",
        custom: false,
        appliedAt: "2026-09-29T00:00:00.000Z",
      }),
    ).toEqual({
      status: "applied",
      templateId: "t-1",
      templateName: "Role",
      content: "the role text",
      custom: false,
      appliedAt: "2026-09-29T00:00:00.000Z",
    });
  });

  /**
   * `content` is kept here and this is the one place it is not obviously right, so
   * it is worth stating: the record holds the copy this agent now carries. Editing
   * the template later will not change it, and there is no re-apply, so this
   * response is the only place the applied text is ever reported.
   */
  it("keeps the applied content, because it is the only record of what was applied", () => {
    expect(roleSummarize({ content: "applied text" }).content).toBe("applied text");
  });

  it("reduces the run to proof it ran, dropping what the agent said", () => {
    const result = applyRoleShape({
      ack: { runId: "r-1" },
      run: {
        runId: "r-1",
        status: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "understood" }] },
      },
      roleRecord: { status: "applied" },
    });

    expect(result.turn).toEqual({ runId: "r-1", status: "completed" });
    // The agent's reply to being handed its role is conversation, not result.
    expect(JSON.stringify(result)).not.toContain("understood");
    expect(Object.keys(result).sort()).toEqual(["roleRecord", "turn"]);
  });

  it("returns a null role record rather than inventing one", () => {
    // A turn that ran without a record written is a real state and the caller has
    // to be able to see it; an empty object would read as a record.
    expect(applyRoleShape({ run: { runId: "r", status: "failed" } }).roleRecord).toBeNull();
    expect(applyRoleShape({ roleRecord: null, run: {} }).roleRecord).toBeNull();
  });

  it("keeps custom as a boolean and null when absent, not false when absent", () => {
    expect(roleSummarize({ custom: true }).custom).toBe(true);
    expect(roleSummarize({ custom: false }).custom).toBe(false);
    // Absent is not the same as "not custom", and guessing would be a fact invented.
    expect(roleSummarize({}).custom).toBeNull();
  });
});

describe("create_connection keeps the row and drops the introduction", () => {
  it("keeps all four stored fields", () => {
    expect(
      connectionSummarize({
        id: "c-1",
        from: "a-one",
        to: "b-two",
        establishedAt: "2026-09-29T00:00:00.000Z",
      }),
    ).toEqual({
      id: "c-1",
      from: "a-one",
      to: "b-two",
      establishedAt: "2026-09-29T00:00:00.000Z",
    });
  });

  it("preserves direction rather than normalising the pair", () => {
    const one = connectionSummarize({ id: "c", from: "a-one", to: "b-two" });
    const other = connectionSummarize({ id: "c", from: "b-two", to: "a-one" });
    expect(one.from).not.toBe(other.from);
  });

  it("drops the introduction the two agents exchanged", () => {
    const result = connectionShape({
      run: {
        runId: "r-1",
        status: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "hello I am agent a" }] },
      },
      connection: { id: "c-1", from: "a-one", to: "b-two" },
    });

    expect(result.introduction).toEqual({ runId: "r-1", status: "completed" });
    expect(JSON.stringify(result)).not.toContain("hello I am agent a");
    expect(Object.keys(result).sort()).toEqual(["connection", "introduction"]);
  });

  it("returns a null connection when the turn ran but nothing was recorded", () => {
    expect(connectionShape({ run: { runId: "r", status: "failed" } }).connection).toBeNull();
  });
});

describe("send_message keeps the reply, which is the opposite choice", () => {
  /**
   * The contrast with the two verbs above, and the reason the shaping rule is a rule
   * rather than a habit: the same unbounded text is dropped there and kept here,
   * because there it is a third party's conversation and here it is the answer.
   */
  it("returns the reply text, the status and the run id and nothing else", () => {
    expect(
      messageShape({
        ack: { runId: "r-1" },
        run: {
          runId: "r-1",
          status: "completed",
          message: { role: "assistant", content: [{ type: "text", text: "all clear" }] },
        },
      }),
    ).toEqual({ runId: "r-1", status: "completed", reply: "all clear" });
  });

  it("returns a null reply with a terminal status, which is not an error", () => {
    const result = messageShape({ run: { runId: "r-1", status: "completed" } });
    expect(result.reply).toBeNull();
    // The status is what tells this apart from a failed turn, so it must survive.
    expect(result.status).toBe("completed");
  });

  it("keeps the run id after a failure, so the turn can still be looked up", () => {
    expect(messageShape({ ack: { runId: "r-9" }, run: { status: "failed" } })).toEqual({
      runId: "r-9",
      status: "failed",
      reply: null,
    });
  });

  it("drops the assembly detail around the reply", () => {
    const result = messageShape({
      run: {
        runId: "r-1",
        status: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "text" }] },
        ...{ seq: 4, timestamp: 12345, acceptedFinalMessageIdentities: ["x"] },
      },
    } as Parameters<typeof messageShape>[0]);

    expect(Object.keys(result).sort()).toEqual(["reply", "runId", "status"]);
    expect(JSON.stringify(result)).not.toContain("12345");
  });
});

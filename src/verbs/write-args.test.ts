/**
 * The validators, tested for the thing that makes them worth having: each refusal
 * happens before a request exists, and each message names the argument.
 *
 * The messages are asserted, not just the throw. A validator that refuses the right
 * values with "invalid input" has moved the failure earlier and thrown the useful
 * half away — the caller still has to guess which of four arguments was wrong.
 */
import { describe, expect, it } from "vitest";
import {
  NOT_REVERSIBLE,
  optionalText,
  requireAgentId,
  requireFilledText,
  requireText,
  requireUuid,
} from "./write-args.js";

const UUID = "1634aa11-2222-4333-8444-555566667777";

describe("requireText", () => {
  it("accepts a non-empty string unchanged", () => {
    expect(requireText("mob2", "name")).toBe("mob2");
  });

  it.each([undefined, null, "", 0, 7, [], {}, true])("refuses %o", (value) => {
    expect(() => requireText(value, "name")).toThrow(/name is required/);
  });

  it("names the argument and shows what it got", () => {
    expect(() => requireText(42, "working_directory")).toThrow(
      /working_directory is required, got 42/,
    );
  });

  /**
   * Whitespace passes here on purpose. `requireText` is the check for "present",
   * and there are arguments where a space is a legitimate character; the stricter
   * check is a separate function so each call site picks one deliberately.
   */
  it("accepts whitespace, which is what requireFilledText is for", () => {
    expect(requireText("   ", "name")).toBe("   ");
  });
});

describe("requireFilledText", () => {
  it("accepts text with content", () => {
    expect(requireFilledText(" mob2 ", "name")).toBe(" mob2 ");
  });

  it("preserves surrounding whitespace rather than trimming it", () => {
    // Trimming would be this layer editing an argument, which is work it does not
    // do. The check is on whether anything is there, not on how it is spaced.
    expect(requireFilledText("  role text  ", "content")).toBe("  role text  ");
  });

  it.each(["", " ", "\t", "\n", "   \n\t "])("refuses %j as empty", (value) => {
    expect(() => requireFilledText(value, "content")).toThrow(
      /content (is required|cannot be only whitespace)/,
    );
  });

  it("says whitespace-only rather than missing, which are different mistakes", () => {
    expect(() => requireFilledText("   ", "content")).toThrow(
      /content cannot be only whitespace/,
    );
  });
});

describe("optionalText", () => {
  it.each([undefined, null])("maps %o to undefined, so the key is dropped", (value) => {
    expect(optionalText(value, "name")).toBeUndefined();
  });

  it("passes a real value through", () => {
    expect(optionalText("new name", "name")).toBe("new name");
  });

  it("still refuses a present value of the wrong type", () => {
    // Optional means "may be absent", not "may be anything".
    expect(() => optionalText(12, "name")).toThrow(/name is required, got 12/);
  });

  it("refuses an empty string rather than treating it as absent", () => {
    // "" and absent mean different things to the product: absent leaves a field
    // alone, "" would set it to nothing. Collapsing them here would make
    // update_template silently destructive.
    expect(() => optionalText("", "name")).toThrow(/name is required/);
  });
});

describe("requireAgentId", () => {
  it.each(["mob2-eng-manager", "a", "A1_b-c", "agent0"])("accepts %s", (id) => {
    expect(requireAgentId(id)).toBe(id);
  });

  it.each([
    ["-leading-dash", "must start alphanumeric"],
    ["has/slash", "no path separators"],
    ["has.dot", "no dots"],
    ["has:colon", "no colons"],
    ["has space", "no spaces"],
    ["", "not empty"],
  ])("refuses %j (%s)", (id) => {
    expect(() => requireAgentId(id)).toThrow();
  });

  it("refuses an id longer than the Gateway can mint", () => {
    expect(() => requireAgentId("a".repeat(65))).toThrow(/must be an agent id/);
  });

  it("accepts the longest id the Gateway can mint", () => {
    const longest = `a${"b".repeat(63)}`;
    expect(longest).toHaveLength(64);
    expect(requireAgentId(longest)).toBe(longest);
  });

  it("uses the label it was given, so from and to stay distinguishable", () => {
    expect(() => requireAgentId("has/slash", "from")).toThrow(/^from must be an agent id/);
    expect(() => requireAgentId("has/slash", "to")).toThrow(/^to must be an agent id/);
  });

  it("defaults the label to agent_id, matching the tool schema", () => {
    expect(() => requireAgentId("has/slash")).toThrow(/^agent_id must be an agent id/);
  });
});

describe("requireUuid", () => {
  it("accepts a UUID as the product mints them", () => {
    expect(requireUuid(UUID, "template_id")).toBe(UUID);
  });

  it("accepts either case, because the product's own pattern does", () => {
    expect(requireUuid(UUID.toUpperCase(), "template_id")).toBe(UUID.toUpperCase());
  });

  it.each(["not-a-uuid", "joy-labs", "1634aa11-2222-4333-8444", `${UUID}x`])(
    "refuses %j",
    (value) => {
      expect(() => requireUuid(value, "template_id")).toThrow(/template_id must be a UUID/);
    },
  );

  /**
   * The case that matters beyond tidiness: `update_template` interpolates this id
   * into a URL path, so a value carrying `/` or `..` would address a different
   * route than the caller asked for. The pattern makes that unreachable.
   */
  it.each(["../agents", "a/../../api/agents", "..%2f..", "x/y"])(
    "refuses %j, which would redirect the PUT path",
    (value) => {
      expect(() => requireUuid(value, "template_id")).toThrow(/must be a UUID/);
    },
  );
});

describe("NOT_REVERSIBLE", () => {
  it("names the reason, not just the fact", () => {
    // A caller told only "cannot be undone" will look for the delete verb. Told
    // there is no delete route, they stop looking.
    expect(NOT_REVERSIBLE).toMatch(/no delete route/);
    expect(NOT_REVERSIBLE).toMatch(/cannot be undone/);
  });
});

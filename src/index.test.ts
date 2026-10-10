import { afterEach, describe, expect, it, vi } from "vitest";
import entry, { singleIntentVerb, stampActingAgent } from "./index.js";

const STATE = "/Users/example/.openclaw-si";
const stateDir = () => STATE;

describe("before_tool_call acting-agent stamp", () => {
  it.each([
    "mcp__singleintent__create_workitem",
    "singleintent__workitem_set_state",
    "mcp__singleintent__workitem_estimate",
    "singleintent__workitem_estimate",
  ])(
    "overwrites forged acting arguments on %s",
    (toolName) => {
      const result = stampActingAgent(
        {
          toolName,
          params: { projectId: "p", actingAgentId: "forged", actingEngineStateDir: "/tmp/forged" },
        },
        { agentId: "joylabs-backend-dev" },
        stateDir,
      );
      expect(result).toEqual({
        params: { projectId: "p", actingAgentId: "joylabs-backend-dev", actingEngineStateDir: STATE },
      });
    },
  );

  it.each([
    "mcp__singleintent__list_workitems",
    "mcp__singleintent__get_workitem",
    "singleintent__create_project",
    "mcp__other__create_workitem",
    "create_workitem",
    "exec",
  ])("leaves %s alone", (toolName) => {
    expect(
      stampActingAgent({ toolName, params: { actingAgentId: "x" } }, { agentId: "a" }, stateDir),
    ).toBeUndefined();
  });

  it("blocks a write when the host did not identify the agent", () => {
    const result = stampActingAgent(
      { toolName: "mcp__singleintent__create_workitem", params: { actingAgentId: "forged" } },
      {},
      stateDir,
    );
    expect(result).toMatchObject({ block: true });
    expect((result as { blockReason: string }).blockReason).toMatch(/calling agent/);
  });

  it("parses both runtimes' tool names", () => {
    expect(singleIntentVerb("mcp__singleintent__create_workitem")).toBe("create_workitem");
    expect(singleIntentVerb("singleintent__create_workitem")).toBe("create_workitem");
    expect(singleIntentVerb("mcp__singleintentx__create_workitem")).toBeUndefined();
  });
});

describe("plugin registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function registerHook(): (event: unknown, ctx: unknown) => unknown {
    const hooks: [string, (event: unknown, ctx: unknown) => unknown][] = [];
    const api = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        hooks.push([name, handler]);
      },
      runtime: {
        state: {
          resolveStateDir: () => {
            throw new Error("the hook must not use api.runtime.state.resolveStateDir");
          },
        },
      },
    };
    entry.register(api as never);
    expect(hooks.map(([name]) => name)).toEqual(["before_tool_call"]);
    return hooks[0]![1];
  }

  it("registers only the before_tool_call hook, stamping dirname(resolveConfigPath())", () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${STATE}/openclaw.json`);
    const result = registerHook()(
      { toolName: "mcp__singleintent__create_workitem", params: {} },
      { agentId: "a" },
    );
    expect(result).toEqual({ params: { actingAgentId: "a", actingEngineStateDir: STATE } });
  });

  it("overwrites a model-supplied actingEngineStateDir with the Gateway's", () => {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${STATE}/openclaw.json`);
    const result = registerHook()(
      {
        toolName: "mcp__singleintent__workitem_set_state",
        params: { actingAgentId: "forged", actingEngineStateDir: "/tmp/attacker", state: "done" },
      },
      { agentId: "a" },
    );
    expect(result).toEqual({
      params: { actingAgentId: "a", actingEngineStateDir: STATE, state: "done" },
    });
  });
});

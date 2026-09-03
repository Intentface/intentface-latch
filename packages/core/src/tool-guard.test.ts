import { describe, expect, it, vi } from "vitest";
import {
  evaluateGuards,
  guardedApprovalPolicy,
  type ToolGuard,
  type ToolGuardTurnContext,
} from "./tool-guard.js";

type P = { orgId: string; userId: string };

const ctx: ToolGuardTurnContext<P> = {
  principal: { orgId: "o1", userId: "u1" },
  chatId: "sub_child",
  rootChatId: "slack2_A1_C1_1.0",
  runId: "run_1",
  agent: "helper",
  trigger: "chat",
};

const call = (toolName: string, input: unknown = {}) => ({
  toolCall: { toolName, input, toolCallId: `tc_${toolName}` },
});

const allow: ToolGuard<P> = () => ({ allow: true });
const denyPost: ToolGuard<P> = ({ tool }) =>
  tool === "post_to_channel" ? { allow: false, reason: "scoped to this channel" } : { allow: true };

describe("evaluateGuards", () => {
  it("AND-composes: the first denial wins, later guards do not run", async () => {
    const later = vi.fn(() => ({ allow: true }) as const);
    const d = await evaluateGuards([allow, denyPost, later], {
      ...ctx,
      tool: "post_to_channel",
      input: {},
      toolCallId: "tc",
    });
    expect(d).toEqual({ allow: false, reason: "scoped to this channel" });
    expect(later).not.toHaveBeenCalled();
  });

  it("allows when every guard allows (async guards included)", async () => {
    const asyncAllow: ToolGuard<P> = async () => ({ allow: true });
    const d = await evaluateGuards([allow, asyncAllow], {
      ...ctx,
      tool: "web_fetch",
      input: {},
      toolCallId: "tc",
    });
    expect(d).toEqual({ allow: true });
  });
});

describe("guardedApprovalPolicy", () => {
  it("returns the SDK 'denied' status with the reason when a guard denies", async () => {
    const policy = guardedApprovalPolicy([denyPost], { post_to_channel: "user-approval" }, ctx);
    await expect(policy(call("post_to_channel", { channel: "C9" }))).resolves.toEqual({
      type: "denied",
      reason: "scoped to this channel",
    });
  });

  it("delegates to the merged object policy on allow", async () => {
    const policy = guardedApprovalPolicy([denyPost], { create_schedule: "user-approval" }, ctx);
    await expect(policy(call("create_schedule"))).resolves.toBe("user-approval");
    await expect(policy(call("web_fetch"))).resolves.toBe("not-applicable");
  });

  it("works with no base policy (autoApprove turns still get guarded)", async () => {
    const policy = guardedApprovalPolicy([denyPost], undefined, ctx);
    await expect(policy(call("web_fetch"))).resolves.toBe("not-applicable");
    await expect(policy(call("post_to_channel"))).resolves.toMatchObject({ type: "denied" });
  });

  it("chains an agent function policy after the guards", async () => {
    const fn = vi.fn(async () => "user-approval");
    const policy = guardedApprovalPolicy([denyPost], fn, ctx);
    await expect(policy(call("web_fetch"))).resolves.toBe("user-approval");
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(policy(call("post_to_channel"))).resolves.toMatchObject({ type: "denied" });
    expect(fn).toHaveBeenCalledTimes(1); // denied calls never reach the base policy
  });

  it("hands guards the turn context plus the call, scoped by rootChatId", async () => {
    const seen = vi.fn(() => ({ allow: true }) as const);
    const policy = guardedApprovalPolicy([seen], {}, ctx);
    await policy(call("web_fetch", { url: "https://x" }));
    expect(seen).toHaveBeenCalledWith({
      ...ctx,
      tool: "web_fetch",
      input: { url: "https://x" },
      toolCallId: "tc_web_fetch",
    });
  });

  it("runs a per-tool function entry with the SDK's per-tool options (guards still first)", async () => {
    const perTool = vi.fn(async (input: unknown, o: { toolCallId: string; toolContext?: unknown }) =>
      (input as { op: string }).op === "write" ? "user-approval" : "not-applicable",
    );
    const policy = guardedApprovalPolicy([denyPost], { risky: perTool }, ctx);
    await expect(
      policy({ ...call("risky", { op: "write" }), toolsContext: { risky: { tenant: "t" } }, messages: [] }),
    ).resolves.toBe("user-approval");
    expect(perTool).toHaveBeenCalledWith(
      { op: "write" },
      expect.objectContaining({ toolCallId: "tc_risky", toolContext: { tenant: "t" }, messages: [] }),
    );
    await expect(policy(call("risky", { op: "read" }))).resolves.toBe("not-applicable");
    await expect(policy(call("post_to_channel"))).resolves.toMatchObject({ type: "denied" });
  });

  it("honors a tool's own needsApproval when no policy names it", async () => {
    const tools = {
      gated: { needsApproval: true },
      dynamic: { needsApproval: async (input: unknown) => (input as { big: boolean }).big },
      plain: {},
    };
    const policy = guardedApprovalPolicy([allow], { other: "user-approval" }, ctx);
    await expect(policy({ ...call("gated"), tools })).resolves.toBe("user-approval");
    await expect(policy({ ...call("dynamic", { big: true }), tools })).resolves.toBe("user-approval");
    await expect(policy({ ...call("dynamic", { big: false }), tools })).resolves.toBe("not-applicable");
    await expect(policy({ ...call("plain"), tools })).resolves.toBe("not-applicable");
  });
});

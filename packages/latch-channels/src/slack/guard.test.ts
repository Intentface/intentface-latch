import { describe, expect, it, vi } from "vitest";
import type { ToolGuardCall } from "@intentface/latch-core";
import { slackScopeGuard } from "./guard.js";
import type { SlackAuditEvent } from "./audit.js";

type P = { userId: string };

const base = {
  toolCallId: "tc1",
  principal: { userId: "u1" },
  agent: "support",
  trigger: "chat" as const,
  runId: "run_1",
};
const inSlack = (tool: string, input: unknown = {}): ToolGuardCall<P> => ({
  ...base,
  tool,
  input,
  chatId: "sub_child_abc", // a subagent's own chat…
  rootChatId: "slack2_A1_C1_1.0", // …scoped by the Slack root
});

describe("slackScopeGuard", () => {
  it("allows everything when the tree did not start in Slack", async () => {
    const g = slackScopeGuard<P>();
    expect(await 
      g({ ...base, tool: "slack_read_channel", input: { channel: "C9" }, chatId: "web_1", rootChatId: "web_1" }),
    ).toEqual({ allow: true });
  });

  it("denies the removed Slack tools by name, with a model-facing reason and a retry note", async () => {
    const g = slackScopeGuard<P>();
    const d = await g(inSlack("post_to_channel", { channel: "C1", text: "hi" }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("<#C1>");
      expect(d.reason).toContain("will not succeed on retry");
    }
  });

  it("denies a Slack-shaped channel id other than the session's; allows the session's own and non-Slack ids", async () => {
    const g = slackScopeGuard<P>();
    expect(await g(inSlack("some_tool", { channel_id: "C0OTHER12" }))).toMatchObject({
      allow: false,
    });
    expect(await g(inSlack("some_tool", { channelId: "C1" }))).toEqual({ allow: true });
    // Every key is checked — a matching `channel` does not excuse a foreign `channel_id`.
    expect(await g(inSlack("some_tool", { channel: "C1", channel_id: "C0OTHER12" }))).toMatchObject({
      allow: false,
    });
    // Too short / non-id strings are not Slack ids.
    expect(await g(inSlack("some_tool", { channel: "CUSTOM" }))).toEqual({ allow: true });
    // A YouTube-style channel id is not ours to police.
    expect(await g(inSlack("yt_tool", { channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw" }))).toEqual({
      allow: true,
    });
    // Nested fields are a stated exemption (schedules have their own gate).
    expect(await 
      g(inSlack("create_schedule", { deliver_to: { channel: "C0OTHER12" } })),
    ).toEqual({ allow: true });
  });

  it("audits every decision as a tool_call, allow and deny alike", async () => {
    const audit = vi.fn<(e: SlackAuditEvent) => void>();
    const g = slackScopeGuard<P>({ audit });
    await g(inSlack("web_fetch", { url: "https://x" }));
    await g(inSlack("some_tool", { channel: "C0OTHER12" }));
    expect(audit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        action: "tool_call",
        decision: "allow",
        appId: "A1",
        channelId: "C1",
        chatId: "slack2_A1_C1_1.0",
        runId: "run_1",
        meta: { tool: "web_fetch" },
      }),
      expect.objectContaining({
        action: "tool_call",
        decision: "deny",
        reason: "off_channel",
        meta: { tool: "some_tool", channel: "C0OTHER12" },
      }),
    ]);
  });

  it("a throwing audit sink never blocks the decision", async () => {
    const g = slackScopeGuard<P>({
      audit: () => {
        throw new Error("db down");
      },
    });
    expect(await g(inSlack("web_fetch"))).toEqual({ allow: true });
  });
});

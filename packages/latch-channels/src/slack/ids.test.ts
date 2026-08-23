import { describe, expect, it } from "vitest";
import { DM_ROOT, parseSlackChatId, slackChatId } from "./ids.js";

describe("slack chat ids v2", () => {
  it("round-trips a thread chat", () => {
    const id = slackChatId("A0123ABC", "C0456DEF", "1712345678.000100");
    expect(id).toBe("slack2_A0123ABC_C0456DEF_1712345678.000100");
    expect(parseSlackChatId(id)).toEqual({
      app: "A0123ABC",
      channel: "C0456DEF",
      root: "1712345678.000100",
    });
  });

  it("round-trips the un-threaded DM chat", () => {
    const id = slackChatId("A0123ABC", "D0789GHI", DM_ROOT);
    expect(id).toBe("slack2_A0123ABC_D0789GHI_dm");
    expect(parseSlackChatId(id)?.root).toBe(DM_ROOT);
  });

  it("round-trips segments containing the separator and escape chars", () => {
    // Slack ids never contain `_`/`%`, but the id scheme must not silently
    // corrupt if one ever does (custom namespaces, tests).
    const id = slackChatId("my_app%1", "team_chan", "1.2");
    const parsed = parseSlackChatId(id);
    expect(parsed).toEqual({ app: "my_app%1", channel: "team_chan", root: "1.2" });
  });

  it("distinguishes ids that a lossy sanitizer would collide", () => {
    const a = slackChatId("my_app", "C1", "1.2");
    const b = slackChatId("my-app", "C1", "1.2");
    expect(a).not.toBe(b);
    expect(parseSlackChatId(a)?.app).toBe("my_app");
    expect(parseSlackChatId(b)?.app).toBe("my-app");
  });

  it("refuses to mint a malformed root", () => {
    expect(() => slackChatId("A1", "C1", "not-a-ts")).toThrow(/invalid root/);
    expect(() => slackChatId("A1", "C1", "")).toThrow(/invalid root/);
  });

  it("never parses v1 ids — the clean break", () => {
    expect(parseSlackChatId("slack_C0456_1712345678.000100")).toBeNull();
    expect(parseSlackChatId("slack_A012_C0456_1712345678.000100")).toBeNull();
    expect(parseSlackChatId("telegram_123")).toBeNull();
    expect(parseSlackChatId("")).toBeNull();
  });
});

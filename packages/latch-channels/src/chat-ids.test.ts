import { describe, expect, it } from "vitest";
import { parseSlackChatId, slackChatId } from "./slack/slackChannel.js";
import { parseTelegramChatId, telegramChatId } from "./telegram/telegramChannel.js";

/**
 * Chat ids are the one thing an outbound path (a scheduled run pushing into a
 * conversation) and the inbound webhook must agree on exactly, so the build/
 * parse pair is tested as a round trip — including the ids real hosts mint.
 */

describe("telegram chat ids", () => {
  it("round-trips a UUID botRef at epoch 0 and beyond", () => {
    const botRef = "0f1e8b4a-9c2d-4c6e-8a11-2b7d5e3f9a10";
    for (const epoch of [0, 1, 42]) {
      const id = telegramChatId(botRef, "123456789", epoch);
      expect(parseTelegramChatId(id)).toEqual({ botRef, telegramUserId: "123456789", epoch });
    }
  });

  it("epoch 0 has no suffix, so existing conversations never move", () => {
    expect(telegramChatId("bot", "5")).toBe("telegram_bot_5");
    expect(telegramChatId("bot", "5", 0)).toBe("telegram_bot_5");
    expect(telegramChatId("bot", "5", 3)).toBe("telegram_bot_5_t3");
  });

  it("handles a botRef containing underscores", () => {
    const id = telegramChatId("my_bot_ref", "42", 2);
    expect(parseTelegramChatId(id)).toEqual({
      botRef: "my_bot_ref",
      telegramUserId: "42",
      epoch: 2,
    });
  });

  it("rejects ids that aren't ours", () => {
    expect(parseTelegramChatId("slack_C1_1712345678.000100")).toBeNull();
    expect(parseTelegramChatId("chat_abc")).toBeNull();
    expect(parseTelegramChatId("telegram_bot_notanumber")).toBeNull();
    expect(parseTelegramChatId("")).toBeNull();
  });
});

describe("slack chat ids", () => {
  it("round-trips a channel + thread root", () => {
    const id = slackChatId("C012AB3CD", "1712345678.000100");
    expect(id).toBe("slack_C012AB3CD_1712345678.000100");
    expect(parseSlackChatId(id)).toEqual({
      channel: "C012AB3CD",
      root: "1712345678.000100",
    });
  });

  it("rejects ids that aren't ours", () => {
    expect(parseSlackChatId("telegram_bot_5")).toBeNull();
    // No `ts` — a channel id alone isn't a conversation.
    expect(parseSlackChatId("slack_C012AB3CD")).toBeNull();
    expect(parseSlackChatId("")).toBeNull();
  });
});

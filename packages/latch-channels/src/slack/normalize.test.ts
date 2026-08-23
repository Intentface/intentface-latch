import { describe, expect, it } from "vitest";
import { isRenderableUserMessage, normalizeSlackText } from "./normalize.js";

const BOT = "U0BOT";

describe("normalizeSlackText", () => {
  it("removes the bot's mention anywhere, not just leading", () => {
    expect(normalizeSlackText(`<@${BOT}> do the thing`, BOT)).toBe("do the thing");
    expect(normalizeSlackText(`please <@${BOT}> do the thing`, BOT)).toBe("please do the thing");
  });

  it("keeps colleague mentions as readable handles", () => {
    expect(normalizeSlackText("ask <@U0ALICE|alice> about it", BOT)).toBe("ask @alice about it");
    expect(normalizeSlackText("ask <@U0ALICE> about it", BOT)).toBe("ask @U0ALICE about it");
  });

  it("rewrites channels, broadcasts and links", () => {
    expect(normalizeSlackText("post to <#C042|general>", BOT)).toBe("post to #general");
    expect(normalizeSlackText("hey <!here> look", BOT)).toBe("hey @here look");
    expect(normalizeSlackText("see <https://x.test/a|the doc>", BOT)).toBe(
      "see the doc (https://x.test/a)",
    );
    expect(normalizeSlackText("see <https://x.test/a>", BOT)).toBe("see https://x.test/a");
  });

  it("unescapes entities after token rewriting", () => {
    expect(normalizeSlackText("if a &lt; b &amp;&amp; b &gt; c", BOT)).toBe("if a < b && b > c");
    // An escaped angle bracket must never become a parseable token.
    expect(normalizeSlackText("&lt;@U0ALICE&gt;", BOT)).toBe("<@U0ALICE>");
  });

  it("preserves newlines while collapsing mention gaps", () => {
    expect(normalizeSlackText(`line one <@${BOT}>  extra\nline two`, BOT)).toBe(
      "line one extra\nline two",
    );
  });
});

describe("isRenderableUserMessage", () => {
  it("accepts a plain human message", () => {
    expect(isRenderableUserMessage({ user: "U1" }, BOT)).toBe(true);
  });

  it("accepts allowlisted subtypes only", () => {
    expect(isRenderableUserMessage({ user: "U1", subtype: "file_share" }, BOT)).toBe(true);
    expect(isRenderableUserMessage({ user: "U1", subtype: "thread_broadcast" }, BOT)).toBe(true);
    expect(isRenderableUserMessage({ user: "U1", subtype: "message_changed" }, BOT)).toBe(false);
    expect(isRenderableUserMessage({ user: "U1", subtype: "channel_join" }, BOT)).toBe(false);
    expect(isRenderableUserMessage({ user: "U1", subtype: "bot_message" }, BOT)).toBe(false);
  });

  it("rejects the bot itself and other bots", () => {
    expect(isRenderableUserMessage({ user: BOT }, BOT)).toBe(false);
    expect(isRenderableUserMessage({ user: "U1", bot_id: "B99" }, BOT)).toBe(false);
    expect(isRenderableUserMessage({}, BOT)).toBe(false);
  });
});

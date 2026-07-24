import { describe, expect, it, vi } from "vitest";
import type { RenderEvent } from "../types.js";
import { TelegramApiError } from "./api.js";
import {
  MAX_TELEGRAM_TEXT_CHARS,
  renderTelegramStream,
  type TelegramStreamOptions,
} from "./stream.js";

/** A manual clock + an api mock that records every send/edit. */
function harness() {
  let t = 0;
  const sends: { text: string; parse_mode?: string }[] = [];
  const edits: { text: string; parse_mode?: string; message_id: number }[] = [];
  const sleeps: number[] = [];
  const api = {
    sendMessage: vi.fn(async (input: { text: string; parse_mode?: "HTML" }) => {
      sends.push({ text: input.text, parse_mode: input.parse_mode });
      return { messageId: 1 };
    }),
    editMessageText: vi.fn(
      async (input: { text: string; parse_mode?: "HTML"; message_id: number }) => {
        edits.push({
          text: input.text,
          parse_mode: input.parse_mode,
          message_id: input.message_id,
        });
      },
    ),
    sendChatAction: vi.fn(async () => {}),
  };
  const opts: TelegramStreamOptions = {
    api: api as never,
    chatId: 5,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { api, opts, sends, edits, sleeps, advance: (ms: number) => (t += ms) };
}

async function* events(
  seq: (RenderEvent | { advance: number })[],
  clock?: (ms: number) => number,
): AsyncGenerator<RenderEvent> {
  for (const e of seq) {
    if ("advance" in e) {
      clock?.(e.advance);
      continue;
    }
    yield e;
  }
}

describe("renderTelegramStream", () => {
  it("creates the message on first content, throttles edits, final-flushes once", async () => {
    const h = harness();
    const result = await renderTelegramStream(
      events(
        [
          { type: "text-delta", text: "Hello" }, // → sendMessage immediately
          { type: "text-delta", text: " there" }, // within 1.5s, few chars → no edit
          { advance: 2000 },
          { type: "text-delta", text: "!" }, // 2s elapsed → edit
          { type: "finish" },
        ],
        h.advance,
      ),
      h.opts,
    );

    expect(h.api.sendChatAction).toHaveBeenCalled();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.text).toBe("Hello");
    expect(h.edits.map((e) => e.text)).toEqual(["Hello there!"]);
    expect(result.text).toBe("Hello there!");
    expect(result.messageId).toBe(1);
  });

  it("flushes early once enough new chars buffer up", async () => {
    const h = harness();
    await renderTelegramStream(
      events([
        { type: "text-delta", text: "start" },
        { type: "text-delta", text: "x".repeat(600) }, // ≥500 chars → edit despite no time passing
        { type: "finish" },
      ]),
      h.opts,
    );
    expect(h.sends).toHaveLength(1);
    expect(h.edits.length).toBeGreaterThanOrEqual(1);
  });

  it("honors retry_after on 429 and resumes", async () => {
    const h = harness();
    h.api.editMessageText.mockImplementationOnce(async () => {
      throw new TelegramApiError("editMessageText", 429, "flood", 7);
    });
    await renderTelegramStream(
      events(
        [
          { type: "text-delta", text: "a" },
          { advance: 2000 },
          { type: "text-delta", text: "b" },
          { type: "finish" },
        ],
        h.advance,
      ),
      h.opts,
    );
    expect(h.sleeps).toContain(7000);
    expect(h.edits.at(-1)!.text).toBe("ab");
  });

  it("caps at 4000 chars with the truncation notice, in ONE message", async () => {
    const h = harness();
    const big = "y".repeat(MAX_TELEGRAM_TEXT_CHARS + 500);
    const result = await renderTelegramStream(
      events([
        { type: "text-delta", text: big },
        { type: "text-delta", text: "more after cap" },
        { type: "finish" },
      ]),
      h.opts,
    );
    expect(h.sends).toHaveLength(1); // never spills into a second message
    const finalText = (h.edits.at(-1) ?? h.sends[0])!.text;
    expect(finalText).toContain("Response truncated for Telegram");
    expect(finalText.length).toBeLessThan(MAX_TELEGRAM_TEXT_CHARS + 200);
    expect(result.text).toBe(big + "more after cap"); // caller still gets everything
  });

  it("falls back to plain text when HTML parsing fails (400) and stays plain", async () => {
    const h = harness();
    h.api.sendMessage.mockImplementationOnce(async () => {
      throw new TelegramApiError("sendMessage", 400, "can't parse entities");
    });
    await renderTelegramStream(
      events(
        [
          { type: "text-delta", text: "**broken" },
          { advance: 2000 },
          { type: "text-delta", text: " md**" },
          { type: "finish" },
        ],
        h.advance,
      ),
      h.opts,
    );
    // retried send without parse_mode, and later edits stay plain
    expect(h.sends.at(-1)!.parse_mode).toBeUndefined();
    expect(h.edits.every((e) => e.parse_mode === undefined)).toBe(true);
    expect(h.edits.at(-1)!.text).toBe("**broken md**");
  });

  it("folds a tool status line into the draft and clears it at the end", async () => {
    const h = harness();
    await renderTelegramStream(
      events(
        [
          { type: "text-delta", text: "Looking…" },
          { advance: 2000 },
          { type: "tool-start", toolCallId: "t1", toolName: "web_search", input: {} },
          { advance: 2000 },
          { type: "tool-end", toolCallId: "t1", toolName: "web_search" },
          { type: "finish" },
        ],
        h.advance,
      ),
      h.opts,
    );
    const all = [...h.sends.map((s) => s.text), ...h.edits.map((e) => e.text)];
    expect(all.some((t) => t.includes("Running web_search…"))).toBe(true);
    expect(all.at(-1)).not.toContain("Running web_search…");
  });

  it("appends the error to the final message", async () => {
    const h = harness();
    await renderTelegramStream(
      events([
        { type: "text-delta", text: "partial" },
        { type: "error", message: "provider exploded" },
        { type: "finish" },
      ]),
      h.opts,
    );
    expect((h.edits.at(-1) ?? h.sends.at(-1))!.text).toContain("⚠️ provider exploded");
  });

  it("sends only the error when no text arrived", async () => {
    const h = harness();
    await renderTelegramStream(
      events([{ type: "error", message: "boom" }, { type: "finish" }]),
      h.opts,
    );
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.text).toContain("boom");
  });
});

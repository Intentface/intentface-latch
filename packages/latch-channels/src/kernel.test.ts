import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import type { AskSession, AskStateStore } from "./types.js";
import {
  createTurnKernel,
  decodeQuestionData,
  encodeApprovalData,
  splitText,
  withTurnLease,
  type Inbound,
  type Surface,
} from "./kernel.js";

/**
 * The kernel against a FAKE surface: proves the semantics every DM platform
 * inherits — admission, the identity gate, post-at-finish rendering, approvals
 * and questionnaires — without any platform protocol in the way. Telegram's and
 * WhatsApp's own suites cover their parsers and surfaces.
 */

type User = { id: string };
type Ref = { fileId: string; size?: number };
type P = { userId: string };

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const textRun = (text: string) => sseResponse([{ type: "text-delta", id: "1", delta: text }]);

function approvalHistory(approvalId: string, toolName = "web_search"): AppMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: `tool-${toolName}`, state: "approval-requested", input: { q: "x" }, approval: { id: approvalId } }],
    } as unknown as AppMessage,
  ];
}

function askHistory(toolCallId: string, questions: unknown[]): AppMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: "tool-askUser", state: "input-available", toolCallId, input: { questions } }],
    } as unknown as AppMessage,
  ];
}

/** In-memory AskStateStore with the real rev/nonce/"already" fencing. */
function fakeAskState() {
  const rows = new Map<string, AskSession>();
  const store: AskStateStore = {
    get: async (chatId) => rows.get(chatId) ?? null,
    begin: async (chatId, session) => {
      const existing = rows.get(chatId);
      if (existing && existing.toolCallId === session.toolCallId) return "already";
      rows.set(chatId, { ...session, rev: 0 });
      return "started";
    },
    update: async (chatId, toolCallId, rev, patch) => {
      const row = rows.get(chatId);
      if (!row || row.toolCallId !== toolCallId || row.rev !== rev) return null;
      rows.set(chatId, { ...row, ...patch, rev: rev + 1 });
      return rev + 1;
    },
    finish: async (chatId, toolCallId, rev) => {
      const row = rows.get(chatId);
      if (!row || row.toolCallId !== toolCallId || row.rev !== rev) return false;
      rows.delete(chatId);
      return true;
    },
    clear: async (chatId) => {
      const row = rows.get(chatId) ?? null;
      rows.delete(chatId);
      return row;
    },
  };
  return { rows, store };
}

/** A surface that records every call; cards get sequential refs. */
function fakeSurface(opts: { maxTextChars?: number; editable?: boolean } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  let seq = 0;
  const rec = (op: string, ...args: unknown[]) => {
    calls.push({ op, args });
    return String(++seq);
  };
  const surface: Surface<User, Ref> = {
    kind: "fake",
    maxTextChars: opts.maxTextChars ?? 4000,
    chatId: (u, epoch) => (epoch > 0 ? `fake_b1_${u.id}_t${epoch}` : `fake_b1_${u.id}`),
    sendText: async (u, text, o) => rec("text", u.id, text, o?.rich ?? false),
    sendLink: async (u, body, label, url) => void rec("link", u.id, body, label, url),
    sendApproval: async (u, pa, data) => rec("approval", u.id, pa.toolName, data),
    sendQuestion: async (u, session, data) => rec("question", u.id, session.cursor, data),
    answered: async (u, card, a) => void rec("answered", u.id, card, a.answer),
    typing: async (u) => void rec("typing", u.id),
    ack: async (id, text) => void rec("ack", id, text),
    fetchMedia: async (m, maxBytes) =>
      (m.ref.size ?? 0) > maxBytes ? null : { bytes: new Uint8Array([1, 2, 3]), mediaType: m.mediaType },
    ...(opts.editable === false
      ? {}
      : {
          updateQuestion: async (u, card, session) => void rec("update", u.id, card, session.selected),
          settleCard: async (u, card, text) => void rec("settle", u.id, card, text),
          retireCard: async (u, card) => void rec("retire", u.id, card),
        }),
  };
  return {
    surface,
    calls,
    of: (op: string) => calls.filter((c) => c.op === op),
    texts: () => calls.filter((c) => c.op === "text").map((c) => c.args[1] as string),
  };
}

function harness(over: { surface?: ReturnType<typeof fakeSurface>; cfg?: Record<string, unknown> } = {}) {
  const s = over.surface ?? fakeSurface();
  const runtime = {
    handleChat: vi.fn(async (_i: unknown) => textRun("Answer!")),
    applyApproval: vi.fn(async (_i: unknown) => textRun("Resumed.")),
    applyToolResult: vi.fn(async (_i: unknown) => textRun("Thanks!")),
    compactChat: vi.fn(async (_i: unknown) => ({ summary: "Marathon plan.", compacted: 4 })),
    loadHistory: vi.fn(async (): Promise<AppMessage[]> => []),
  };
  const kernel = createTurnKernel<P, User, Ref>(
    {
      agent: "support",
      botRef: "b1",
      runtime,
      authorizeUser: vi.fn(async () => ({ allowed: true, principal: { userId: "u1" } })),
      ...over.cfg,
    },
    s.surface,
  );
  const user: User = { id: "7" };
  const message = (text: string, extra: Partial<Extract<Inbound<User, Ref>, { kind: "message" }>> = {}) =>
    kernel.handleInbound({ kind: "message", user, text, media: [], deliveryKey: `k${Math.random()}`, ...extra });
  const action = (data: string, extra: Partial<Extract<Inbound<User, Ref>, { kind: "action" }>> = {}) =>
    kernel.handleInbound({ kind: "action", user, data, deliveryKey: `k${Math.random()}`, ...extra });
  return { kernel, runtime, user, message, action, ...s };
}

describe("kernel — a message becomes one turn", () => {
  it("runs the agent, posts the answer once at finish as rich text, with typing on", async () => {
    const h = harness();
    await h.message("hi");
    expect(h.runtime.handleChat).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "support", chatId: "fake_b1_7", principal: { userId: "u1" } }),
    );
    expect(h.of("text").map((c) => [c.args[1], c.args[2]])).toEqual([["Answer!", true]]);
    expect(h.of("typing").length).toBeGreaterThanOrEqual(1);
  });

  it("splits a long answer past the surface cap, at paragraph breaks", async () => {
    const h = harness({ surface: fakeSurface({ maxTextChars: 20 }) });
    h.runtime.handleChat.mockResolvedValue(textRun("one one one one\n\ntwo two two two\n\nthree"));
    await h.message("hi");
    expect(h.texts()).toEqual(["one one one one", "two two two two", "three"]);
  });

  it("never rejects: a throwing store is logged, not surfaced to the caller", async () => {
    const h = harness({ cfg: { claimTurn: async () => { throw new Error("db down"); } } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(h.message("hi")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("inbound handling failed"), expect.any(Error));
    err.mockRestore();
  });

  it("core's own busy refusal (chat_busy) reads as 'still working', not as an error", async () => {
    const h = harness();
    h.runtime.handleChat.mockRejectedValue(Object.assign(new Error("busy"), { code: "chat_busy", retryAfterMs: 5000 }));
    await h.message("hi");
    expect(h.texts()).toEqual(["I am still working on the previous message in this chat."]);
  });

  it("drops a delivery the host has already seen", async () => {
    const h = harness({ cfg: { seen: async () => true } });
    await h.message("hi");
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });

  it("refuses an unlinked user with a link, and stashes the message (but never a command)", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      cfg: { authorizeUser: async () => ({ allowed: false, linkUrl: "https://l/x" }), stashPending },
    });
    await h.message("do it", { media: [{ ref: { fileId: "f" }, mediaType: "image/png", name: "a.png" }] });
    await h.message("/new");
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(stashPending).toHaveBeenCalledTimes(1);
    expect(stashPending).toHaveBeenCalledWith(
      expect.objectContaining({ user: h.user, text: "do it", media: [expect.objectContaining({ name: "a.png" })] }),
    );
    expect(h.of("link").map((c) => c.args[3])).toEqual(["https://l/x", "https://l/x"]);
  });

  it("stays silent for silent refusals", async () => {
    const h = harness({ cfg: { authorizeUser: async () => ({ allowed: false, silent: true }) } });
    await h.message("hi");
    expect(h.calls).toEqual([]);
  });

  it("answers 'still working' when the chat's lease is held, and releases with ITS token otherwise", async () => {
    const releaseTurn = vi.fn(async () => {});
    const busy = harness({ cfg: { claimTurn: async () => null, releaseTurn } });
    await busy.message("hi");
    expect(busy.runtime.handleChat).not.toHaveBeenCalled();
    expect(busy.texts()[0]).toMatch(/still working/);

    const free = harness({ cfg: { claimTurn: async () => "tok-1", releaseTurn } });
    free.runtime.handleChat.mockRejectedValue(new Error("boom"));
    await free.message("hi");
    expect(releaseTurn).toHaveBeenCalledWith("fake_b1_7", "tok-1");
    expect(free.texts().at(-1)).toMatch(/⚠️ boom/);
  });

  it("inlines media as file parts, skips oversized files with a note, transcribes audio to text", async () => {
    const h = harness({ cfg: { transcribe: async () => "hello from voice", maxInlineFileBytes: 100 } });
    await h.message("see", {
      media: [
        { ref: { fileId: "a", size: 10 }, mediaType: "image/png", name: "a.png" },
        { ref: { fileId: "b", size: 1000 }, mediaType: "application/pdf", name: "big.pdf" },
        { ref: { fileId: "c", size: 10 }, mediaType: "audio/ogg", name: "voice.ogg" },
      ],
    });
    const msg = (h.runtime.handleChat.mock.calls[0]![0] as { message: AppMessage }).message;
    const text = (msg.parts.find((p) => p.type === "text") as { text: string }).text;
    expect(text).toContain("see");
    expect(text).toContain("[Voice message]: hello from voice");
    expect(text).toContain("big.pdf");
    expect(msg.parts.filter((p) => p.type === "file")).toHaveLength(1);
  });

  it("writes into the thread the epoch store points at, and /new rotates it", async () => {
    let epoch = 0;
    const thread = { current: async () => epoch, rotate: async () => ++epoch };
    const h = harness({ cfg: { thread } });
    await h.message("first");
    await h.message("/new");
    await h.message("second");
    expect(h.runtime.handleChat.mock.calls.map((c) => (c[0] as { chatId: string }).chatId)).toEqual([
      "fake_b1_7",
      "fake_b1_7_t1",
    ]);
  });
});

describe("kernel — approvals", () => {
  it("renders a pending approval after the turn, and a connect approval as a link", async () => {
    const h = harness({ cfg: { authorizeUrl: (name: string) => `https://auth/${name}` } });
    h.runtime.loadHistory.mockResolvedValue([
      ...approvalHistory("a1", "web_search"),
    ]);
    await h.message("hi");
    expect(h.of("approval").map((c) => c.args[1])).toEqual(["web_search"]);
    expect((h.of("approval")[0]!.args[2] as { approve: string }).approve).toBe(encodeApprovalData(true, "a1"));

    h.runtime.loadHistory.mockResolvedValue(approvalHistory("a2", "connect_gmail"));
    await h.message("again");
    expect(h.of("link").at(-1)!.args[3]).toBe("https://auth/gmail");
  });

  it("an approve tap acks first, verifies against history, resumes under the lease, settles the card", async () => {
    const claimTurn = vi.fn(async () => "t1");
    const h = harness({ cfg: { claimTurn, releaseTurn: async () => {} } });
    h.runtime.loadHistory.mockResolvedValueOnce(approvalHistory("a1", "web_search"));
    await h.action(encodeApprovalData(true, "a1"), { card: "c9", ackId: "q1" });
    expect(h.calls[0]).toEqual({ op: "ack", args: ["q1", undefined] });
    expect(claimTurn).toHaveBeenCalledWith("fake_b1_7");
    expect(h.runtime.applyApproval).toHaveBeenCalledWith({
      chatId: "fake_b1_7",
      principal: { userId: "u1" },
      decisions: [{ approvalId: "a1", approved: true }],
    });
    expect(h.of("settle")[0]!.args[2]).toBe("✅ Approved **web_search**");
    expect(h.texts()).toEqual(["Resumed."]);
  });

  it("a tap on an approval that is gone retires the card and runs nothing", async () => {
    const h = harness();
    await h.action(encodeApprovalData(false, "ghost"), { card: "c9" });
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect(h.of("settle")[0]!.args[2]).toMatch(/no longer active/);
  });

  it("/cancel denies every pending approval under the lease", async () => {
    const h = harness();
    // Both gated calls sit on the ONE assistant message the turn paused on.
    const [m1] = approvalHistory("a1", "x");
    const [m2] = approvalHistory("a2", "y");
    h.runtime.loadHistory.mockResolvedValueOnce([{ ...m1!, parts: [...m1!.parts, ...m2!.parts] } as AppMessage]);
    await h.message("/cancel");
    expect(h.runtime.applyApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: [
          { approvalId: "a1", approved: false },
          { approvalId: "a2", approved: false },
        ],
      }),
    );
  });
});

describe("kernel — questionnaires", () => {
  const questions = [
    { question: "Goal?", options: [{ label: "Speed", description: "" }, { label: "Distance", description: "" }] },
    {
      question: "Days?",
      multiSelect: true,
      options: [{ label: "Mon", description: "" }, { label: "Wed", description: "" }, { label: "Fri", description: "" }],
    },
  ];

  it("posts the first question with tappable payloads, walks the rest, submits once at the end", async () => {
    const ask = fakeAskState();
    const h = harness({ cfg: { askState: ask.store } });
    h.runtime.loadHistory.mockResolvedValueOnce(askHistory("call1", questions));
    await h.message("plan");
    const first = h.of("question")[0]!;
    expect(first.args[1]).toBe(0);
    const data = first.args[2] as { pick(i: number): string; done: string };
    const session = ask.rows.get("fake_b1_7")!;
    expect(decodeQuestionData(data.pick(1))).toEqual({ verb: "pick", nonce: session.nonce, questionIndex: 0, optionIndex: 1 });

    // Q1: single-select tap → receipt + Q2 posted; nothing submitted yet.
    await h.action(data.pick(1), { card: "1", ackId: "k1" });
    expect(h.of("answered").at(-1)!.args[2]).toBe("Distance");
    expect(h.of("question").at(-1)!.args[1]).toBe(1);
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();

    // Q2: multi-select ticks in place, then Done submits the whole map.
    const data2 = h.of("question").at(-1)!.args[2] as { pick(i: number): string; done: string };
    await h.action(data2.pick(0), { card: "2", ackId: "k2" });
    await h.action(data2.pick(2), { card: "2", ackId: "k3" });
    expect(h.of("update").at(-1)!.args[2]).toEqual([0, 2]);
    await h.action(data2.done, { card: "2", ackId: "k4" });
    expect(h.runtime.applyToolResult).toHaveBeenCalledWith({
      chatId: "fake_b1_7",
      principal: { userId: "u1" },
      toolCallId: "call1",
      output: { "Goal?": "Distance", "Days?": "Mon, Fri" },
    });
    expect(ask.rows.size).toBe(0);
    expect(h.texts().at(-1)).toBe("Thanks!");
  });

  it("a typed reply answers the question on screen instead of starting a turn", async () => {
    const ask = fakeAskState();
    const h = harness({ cfg: { askState: ask.store } });
    h.runtime.loadHistory.mockResolvedValueOnce(askHistory("call1", questions.slice(0, 1)));
    await h.message("plan");
    await h.message("speed");
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(h.runtime.applyToolResult).toHaveBeenCalledWith(expect.objectContaining({ output: { "Goal?": "Speed" } }));
  });

  it("a stale tap is answered with a toast (or a message on surfaces without acks) and the card retired", async () => {
    const ask = fakeAskState();
    const h = harness({ cfg: { askState: ask.store } });
    await h.action("ltq:s|nope|0|0", { card: "c1", ackId: "k1" });
    expect(h.of("ack")[0]!.args).toEqual(["k1", "This questionnaire is no longer active."]);
    expect(h.of("retire")[0]!.args[1]).toBe("c1");

    const noAck = harness({ cfg: { askState: ask.store } });
    await noAck.action("ltq:s|nope|0|0");
    expect(noAck.texts()).toEqual(["This questionnaire is no longer active."]);
  });

  it("without ask-state the questions post as text and nothing is submitted", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValueOnce(askHistory("call1", questions));
    await h.message("plan");
    expect(h.of("question").map((c) => [c.args[1], c.args[2]])).toEqual([
      [0, undefined],
      [1, undefined],
    ]);
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
  });
});

describe("kernel — commands", () => {
  it("/help and /status run no turn; /compact goes through the runtime under the lease", async () => {
    const claimTurn = vi.fn(async () => "t");
    const h = harness({ cfg: { claimTurn, releaseTurn: async () => {} } });
    await h.message("/help");
    await h.message("/status");
    await h.message("/compact on pacing");
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.texts()[0]).toContain("/new");
    expect(h.texts()[1]).toContain("Waiting on: nothing");
    expect(h.runtime.compactChat).toHaveBeenCalledWith(expect.objectContaining({ focus: "on pacing" }));
    expect(claimTurn).toHaveBeenCalledTimes(1);
    expect(h.texts().at(-1)).toContain("Compacted 4 messages");
  });

  it("an unknown slash-word is an ordinary message", async () => {
    const h = harness();
    await h.message("/Users/me/notes.txt");
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
  });
});

describe("shared helpers", () => {
  it("splitText prefers paragraph breaks and hard-splits without them", () => {
    expect(splitText("hello", 10)).toEqual(["hello"]);
    expect(splitText("aaaaaaa\n\nbbbbbbb", 12)).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(splitText("x".repeat(25), 10).map((c) => c.length)).toEqual([10, 10, 5]);
  });

  it("withTurnLease runs onBusy when the claim fails and always releases its own token", async () => {
    const onBusy = vi.fn(async () => {});
    const fn = vi.fn(async () => {});
    await withTurnLease({ claimTurn: async () => null }, "c", onBusy, fn);
    expect(onBusy).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();

    const releaseTurn = vi.fn(async () => {});
    await expect(
      withTurnLease({ claimTurn: async () => "tok", releaseTurn }, "c", onBusy, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(releaseTurn).toHaveBeenCalledWith("c", "tok");

    // No lease seam at all: fn just runs.
    const bare = vi.fn(async () => {});
    await withTurnLease({}, "c", onBusy, bare);
    expect(bare).toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { SlackApiError, slackApi } from "./api.js";

type Call = { url: string; body: URLSearchParams; contentType: string; raw: string };

/** A scripted fetch: each entry answers one call, recording it. */
function scriptedFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    calls.push({
      url: String(url),
      body: new URLSearchParams(raw),
      contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
      raw,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ ok: true, ...extra }), { status: 200 });
const apiErr = (error: string) => () =>
  new Response(JSON.stringify({ ok: false, error }), { status: 200 });
const http = (status: number, headers: Record<string, string> = {}) => () =>
  new Response("err", { status, headers });

const noSleep = { sleeps: [] as number[] };
const sleep = async (ms: number) => {
  noSleep.sleeps.push(ms);
};

describe("slack api client", () => {
  it("honors Retry-After on 429 and retries once", async () => {
    noSleep.sleeps = [];
    const { fetchImpl, calls } = scriptedFetch([
      http(429, { "retry-after": "2" }),
      ok({ ts: "1.2", channel: "C1" }),
    ]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    const r = await api.postMessage({ channel: "C1", text: "hi" });
    expect(r.ts).toBe("1.2");
    expect(calls.length).toBe(2);
    expect(noSleep.sleeps).toEqual([2000]);
  });

  it("gives up after the second 429 with a typed error", async () => {
    const { fetchImpl } = scriptedFetch([http(429), http(429, { "retry-after": "30" })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await expect(api.postMessage({ channel: "C1", text: "hi" })).rejects.toMatchObject({
      name: "SlackApiError",
      status: 429,
    });
  });

  it("retries a 5xx once", async () => {
    const { fetchImpl, calls } = scriptedFetch([http(502), ok({ ts: "1.2", channel: "C1" })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.postMessage({ channel: "C1", text: "hi" });
    expect(calls.length).toBe(2);
  });

  it("surfaces ok:false as a typed error with the Slack code", async () => {
    const { fetchImpl } = scriptedFetch([apiErr("stopped_by_user")]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    try {
      await api.appendStream({ channel: "C1", ts: "1.2", markdown_text: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SlackApiError);
      expect((e as SlackApiError).code).toBe("stopped_by_user");
      expect((e as SlackApiError).method).toBe("chat.appendStream");
    }
  });

  it("sends the streaming methods as real JSON bodies", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok()]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.appendStream({
      channel: "C1",
      ts: "1.2",
      chunks: [{ type: "task_update", id: "t1", title: "Using web_search", status: "complete" }],
    });
    expect(calls[0]!.contentType).toContain("application/json");
    const sent = JSON.parse(calls[0]!.raw) as {
      channel: string;
      chunks: { type: string; id: string; status: string }[];
    };
    expect(sent.channel).toBe("C1");
    expect(sent.chunks[0]).toMatchObject({ type: "task_update", id: "t1", status: "complete" });
  });

  it("never unfurls links or media by default", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok({ ts: "1.2", channel: "C1" })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.postMessage({ channel: "C1", text: "see https://x" });
    expect(calls[0]!.body.get("unfurl_links")).toBe("false");
    expect(calls[0]!.body.get("unfurl_media")).toBe("false");
  });

  it("threadReplies forwards the window options (oldest/latest/limit)", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok({ messages: [] }), ok({ messages: [] })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.threadReplies("C1", "1.0", { oldest: "1.0", limit: 200 });
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ channel: "C1", ts: "1.0", limit: "200", oldest: "1.0" });
    await api.threadReplies("C1", "1.0", { latest: "1.5" });
    expect(Object.fromEntries(calls[1]!.body)).toEqual({ channel: "C1", ts: "1.0", limit: "50", latest: "1.5" });
  });

  it("keeps non-streaming methods form-encoded", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok({ ts: "1.2", channel: "C1" })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.postMessage({ channel: "C1", text: "hi" });
    expect(calls[0]!.contentType).toContain("application/x-www-form-urlencoded");
    expect(calls[0]!.body.get("channel")).toBe("C1");
  });

  it("captures Slack's response_metadata detail on argument errors", async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "invalid_arguments",
            response_metadata: {
              messages: ["[ERROR] failed to match all allowed schemas [json-pointer:/chunks/0]"],
            },
          }),
          { status: 200 },
        ),
    ]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    try {
      await api.startStream({ channel: "C1" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SlackApiError);
      expect((e as SlackApiError).code).toBe("invalid_arguments");
      expect((e as SlackApiError).detail).toContain("json-pointer:/chunks/0");
      expect((e as SlackApiError).message).toContain("json-pointer");
    }
  });

  it("paginates conversations.members and fails CLOSED past the page cap", async () => {
    const page = (members: string[], next?: string) =>
      ok({ members, response_metadata: next ? { next_cursor: next } : {} });
    {
      const { fetchImpl, calls } = scriptedFetch([page(["U1"], "c2"), page(["U2"])]);
      const api = slackApi("xoxb-t", { fetchImpl, sleep });
      expect(await api.conversationsMembers("C1")).toEqual(["U1", "U2"]);
      expect(calls[1]!.body.get("cursor")).toBe("c2");
    }
    {
      const { fetchImpl } = scriptedFetch([page(["U1"], "c2"), page(["U2"], "c3")]);
      const api = slackApi("xoxb-t", { fetchImpl, sleep });
      await expect(api.conversationsMembers("C1", 2)).rejects.toMatchObject({
        code: "member_list_truncated",
      });
    }
  });

  it("keeps unfurling off even when a caller passes the flags", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok({ ts: "1.2", channel: "C1" })]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.postMessage({
      channel: "C1",
      text: "https://example.com",
      // Not in the public input type — but nothing stops an untyped caller.
      ...({ unfurl_links: true, unfurl_media: true } as Record<string, unknown>),
    });
    expect(calls[0]!.body.get("unfurl_links")).toBe("false");
    expect(calls[0]!.body.get("unfurl_media")).toBe("false");
  });

  it("resolves a lazy token per call", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok({ ts: "1.2", channel: "C1" })]);
    let reads = 0;
    const api = slackApi(async () => {
      reads++;
      return "xoxb-lazy";
    }, { fetchImpl, sleep });
    await api.postMessage({ channel: "C1", text: "hi" });
    expect(reads).toBe(1);
    expect(calls.length).toBe(1);
  });
});

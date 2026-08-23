import { describe, expect, it } from "vitest";
import { SlackApiError, slackApi } from "./api.js";

type Call = { url: string; body: URLSearchParams };

/** A scripted fetch: each entry answers one call, recording it. */
function scriptedFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
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

  it("encodes chunks as JSON-in-form", async () => {
    const { fetchImpl, calls } = scriptedFetch([ok()]);
    const api = slackApi("xoxb-t", { fetchImpl, sleep });
    await api.appendStream({
      channel: "C1",
      ts: "1.2",
      chunks: [{ type: "task_update", id: "t1", title: "Using web_search", status: "complete" }],
    });
    const sent = JSON.parse(calls[0]!.body.get("chunks")!);
    expect(sent[0]).toMatchObject({ type: "task_update", id: "t1", status: "complete" });
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

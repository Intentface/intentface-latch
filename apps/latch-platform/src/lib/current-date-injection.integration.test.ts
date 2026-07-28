import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, currentDateLine, defineAgent, defineContext } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const textStream = (text: string) =>
  new ReadableStream({
    start(c) {
      for (const p of [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ])
        c.enqueue(p);
      c.close();
    },
  });

describe("currentDateLine", () => {
  it("formats a UTC day with its weekday", () => {
    expect(currentDateLine(new Date("2026-07-28T09:15:00Z"))).toBe(
      "Today's date is Tuesday, 2026-07-28 (UTC).",
    );
  });

  it("is stable within a UTC day and flips only at midnight", () => {
    const morning = currentDateLine(new Date("2026-07-28T00:00:00Z"));
    const night = currentDateLine(new Date("2026-07-28T23:59:59Z"));
    expect(night).toBe(morning);
    expect(currentDateLine(new Date("2026-07-29T00:00:00Z"))).toBe(
      "Today's date is Wednesday, 2026-07-29 (UTC).",
    );
  });
});

describe("current-date injection", () => {
  it("appends the date line to the system prompt, after the agent's instructions", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: textStream("ok") };
      },
    });
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const db = drizzle(client, { schema });
    const runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
      context: defineContext<P, { orgId: string }>({ build: ({ principal: p }) => ({ orgId: p.orgId }) }),
      agents: {
        dated: defineAgent<P>({ model: model as never, instructions: "You are a helpful test agent." }),
        bare: defineAgent<P>({ model: model as never }),
      },
    });

    // Computed on both sides of the model call so the exact-match assertions
    // can't flake if the test happens to straddle UTC midnight.
    const stampBefore = currentDateLine();
    const res = await runtime.handleChat({
      agent: "dated",
      chatId: "chat_date",
      principal,
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as never,
    });
    if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;

    expect(prompts).toHaveLength(1);
    const system = (prompts[0] as { role: string; content: string }[]).find(
      (m) => m.role === "system",
    );
    expect(system, "a system message reached the model").toBeTruthy();
    const stamps = [...new Set([stampBefore, currentDateLine()])];
    expect(stamps.map((s) => `You are a helpful test agent.\n\n${s}`)).toContain(system!.content);

    // An agent with no instructions still learns the date — and gets nothing else.
    const res2 = await runtime.handleChat({
      agent: "bare",
      chatId: "chat_bare",
      principal,
      message: { id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] } as never,
    });
    if (res2.body) for await (const _ of res2.body as unknown as AsyncIterable<unknown>) void _;
    const system2 = (prompts[1] as { role: string; content: string }[]).find(
      (m) => m.role === "system",
    );
    expect([...stamps, currentDateLine()]).toContain(system2?.content);
  });
});

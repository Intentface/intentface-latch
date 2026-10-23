import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, type AppMessage } from "@intentface/latch-core";
import { createPostgresAdapter } from "./adapter.pg.js";
import { migratePostgres } from "./migrate.pg.js";
import * as pgSchema from "./schema.pg.js";

/**
 * A stop that lands on another server: two runtimes on one Postgres, durable
 * runs. The one that receives `stopRun` only stamps the run row; the one
 * running the answer reads it, stops, and completes the run, which crash
 * recovery then leaves alone.
 */

type P = { orgId: string; userId: string };
const me: P = { orgId: "o1", userId: "u1" };
const someoneElse: P = { orgId: "o2", userId: "u2" };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** "w0 w1 …", one word every 10 ms, ended by the call's abort like a provider stream. */
function slowModel() {
  return new MockLanguageModelV4({
    modelId: "slow",
    doStream: (async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            let i = 0;
            const next = () => {
              if (i === 500) {
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
                controller.close();
                return;
              }
              controller.enqueue({ type: "text-delta", id: "t", delta: `w${i++} ` });
              timer = setTimeout(next, 10);
            };
            abortSignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              controller.error(abortSignal.reason);
            });
            next();
          },
        }),
      };
    }) as never,
  });
}

const user = (text: string): AppMessage =>
  ({ id: "u1", role: "user", parts: [{ type: "text", text }], metadata: { visibility: "user" } }) as AppMessage;

describe("stopRun across servers (Postgres)", () => {
  it("stops the answer on the other server within the check interval, and recovery leaves it stopped", async () => {
    const pg = new PGlite();
    const db = drizzle(pg, { schema: pgSchema });
    await migratePostgres(db);
    const storage = createPostgresAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] });
    const node = (instanceId: string) =>
      createRuntime<P>({
        storage,
        durability: { enabled: true, instanceId, leaseTtlMs: 300, heartbeatMs: 100 },
        stopCheckMs: 50,
        agents: { a: defineAgent<P>({ model: slowModel(), instructions: "Talk." }) },
      });
    const running = node("n1");
    const other = node("n2");

    const body = (await running.handleChat({ agent: "a", principal: me, chatId: "c1", message: user("talk") })).text();
    await new Promise((r) => setTimeout(r, 150));

    expect(await other.stopRun({ principal: someoneElse, chatId: "c1" })).toBeNull();
    const asked = Date.now();
    const stopped = await other.stopRun({ principal: me, chatId: "c1" });
    expect(stopped).toEqual({ runId: expect.any(String) });

    expect(await body).toContain('"type":"abort"');
    expect(Date.now() - asked).toBeLessThan(1000);

    const run = await running.getRun({ principal: me, runId: stopped!.runId });
    expect(run).toMatchObject({ status: "completed", stopRequestedAt: expect.any(Number) });
    // The one step was cut off mid-sentence: nothing of it is kept.
    expect((await running.loadHistory({ principal: me, chatId: "c1" })).map((m) => m.role)).toEqual(["user"]);

    // Recovery after the lease would have lapsed: nothing to resume.
    await new Promise((r) => setTimeout(r, 400));
    const swept = await other.sweep();
    expect(JSON.stringify(swept)).not.toContain(stopped!.runId);
    expect((await running.getRun({ principal: me, runId: stopped!.runId }))!.status).toBe("completed");
    await pg.close();
  });
});

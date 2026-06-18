import { serve } from "@hono/node-server";
import { createLatchHono } from "@intentface/latch-server";
import { createIntervalScheduler, type Principal } from "@intentface/latch-core";
import { makeLiveRuntime } from "./live.js";

/**
 * A runnable Latch server backed by a real model. Run with:
 *
 *   pnpm --filter @intentface/latch-example serve
 *
 * Then talk to it (the org comes from a header; real apps derive it from auth):
 *
 *   curl -N http://localhost:8787/agents/assistant/chat-1 \
 *     -H 'content-type: application/json' -H 'x-org: org_a' \
 *     -d '{"text":"In one sentence, what is Latch?"}'
 */
const runtime = await makeLiveRuntime();

const app = createLatchHono({
  runtime,
  // BYO-auth: the only glue a customer writes. Here we trust a header for the demo.
  resolveContext: (req): Principal => ({
    orgId: req.headers.get("x-org") ?? "org_a",
    userId: req.headers.get("x-user") ?? "user_1",
  }),
});

// Serverless cron entry point: point a platform scheduler (Vercel Cron, etc.)
// at this route. It does the same reap+resume as the in-process loop below.
app.post("/cron/sweep", async (c) => c.json(await runtime.sweep()));

// Long-running node: drive the reaper in-process. Reaps lease-expired runs and
// resumes them. Safe to also run on other nodes — reclaim is exactly-once.
const reaper = createIntervalScheduler({
  intervalMs: 10_000,
  onTick: async () => {
    const { reaped, resumed } = await runtime.sweep();
    if (reaped.length) {
      console.log(`🧹 swept ${reaped.length} stalled run(s), resumed ${resumed.length}`);
    }
  },
  onError: (e) => console.error("sweep failed:", e),
});
reaper.start();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`🔓 Latch listening on http://localhost:${port} (durable; reaper every 10s)`);
console.log(
  `   curl -N http://localhost:${port}/agents/assistant/chat-1 ` +
    `-H 'content-type: application/json' -H 'x-org: org_a' ` +
    `-d '{"text":"In one sentence, what is Latch?"}'`,
);
console.log(`   reaper (serverless cron): curl -X POST http://localhost:${port}/cron/sweep`);

// Stop the reaper cleanly on shutdown.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void reaper.stop().finally(() => process.exit(0));
  });
}

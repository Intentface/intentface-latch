import { serve } from "@hono/node-server";
import { createLatchHono } from "@intentface/latch-server";
import type { Principal } from "@intentface/latch-core";
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

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`🔓 Latch listening on http://localhost:${port}`);
console.log(
  `   curl -N http://localhost:${port}/agents/assistant/chat-1 ` +
    `-H 'content-type: application/json' -H 'x-org: org_a' ` +
    `-d '{"text":"In one sentence, what is Latch?"}'`,
);

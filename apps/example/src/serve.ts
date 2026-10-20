import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";
import { tools } from "./tools.js";

/**
 * A runnable Latch server backed by a real model — the whole backend in one
 * call. Run with:
 *
 *   pnpm --filter @intentface/latch-example serve
 *
 * Then talk to it (the org comes from a header; real apps derive it from auth):
 *
 *   curl -N http://localhost:8787/agents/assistant/chat-1 \
 *     -H 'content-type: application/json' -H 'x-org: org_a' \
 *     -d '{"text":"In one sentence, what is Latch?"}'
 *
 * Needs ANTHROPIC_API_KEY (and/or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY —
 * the model catalog includes whatever is keyed).
 */
export interface Principal {
  orgId: string;
  userId?: string;
}
const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);

// BYO-auth: the only glue a customer writes. LOCAL DEMO ONLY — this trusts a
// caller-supplied header, which is impersonation by construction. A real app
// derives the Principal from its session and returns null (→ 401) otherwise.
const resolvePrincipal = (req: Request): Principal => ({
  orgId: req.headers.get("x-org") ?? "org_a",
  userId: req.headers.get("x-user") ?? "user_1",
});

const client = createClient({ url: "file:./latch-dev.db" });
await migrate(client);
const db = drizzle(client, { schema });

// Everything else is defaults: durability, cron (in-process here; POST
// /cron/run on serverless), the models.dev catalog with pricing / reasoning /
// web-tool / prompt-caching hooks, and the harness tools.
const { app, runtime, stop } = await createLatchHonoApp<Principal>({
  storage: createSqliteAdapter<Principal>(db, { owner }),
  resolvePrincipal,
  agents: (models) => ({
    assistant: defineAgent<Principal>({
      model: models.modelFor("claude-sonnet-4-6"),
      instructions:
        "You are a concise, friendly assistant. Use tools when they help; " +
        "for the current time, always call getCurrentTime rather than guessing.",
      tools,
      // web_fetch + askUser + schedule tools from the harness.
      defaultTools: true,
    }),
  }),
});
void runtime;

// Connections with OAuth: pass a connection registry to the handler
// (`handler: { connections: createMcpConnections({...}) }`) and the mounted
// routes `connections/:name/authorize` + `/callback` run the flow with the
// principal PINNED into the state at authorize time — never re-resolved from
// the redirect request. See the oauth smoke + the platform for a full wiring.

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`🔓 Latch listening on http://localhost:${port} (durable; cron every 30s)`);
console.log(
  `   curl -N http://localhost:${port}/agents/assistant/chat-1 ` +
    `-H 'content-type: application/json' -H 'x-org: org_a' ` +
    `-d '{"text":"In one sentence, what is Latch?"}'`,
);
console.log(`   cron (serverless entry): curl -X POST http://localhost:${port}/cron/run -H 'x-latch-cron-secret: $LATCH_CRON_SECRET'`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stop().finally(() => process.exit(0));
  });
}

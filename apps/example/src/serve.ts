import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createVault, defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, createSqliteSecretStore, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";
import { createMcpOAuth } from "@intentface/latch-mcp";
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

// BYO-auth: the only glue a customer writes. Here we trust a header for the demo;
// a real app derives the Principal from its session.
const resolveContext = (req: Request): Principal => ({
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
  resolveContext,
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

// --- MCP OAuth connection routes (optional demo) ------------------------------
// Env-gated: set MCP_OAUTH_SERVER_URL to a real OAuth-protected MCP server and
// LATCH_VAULT_KEY (base64 of 32 bytes) for the token vault. The browser flow:
// UI links to /authorize → IdP consent → /callback (token exchange → Vault,
// under the authenticated Principal) → success page.
const mcpOAuthServer = process.env.MCP_OAUTH_SERVER_URL;
if (mcpOAuthServer) {
  const masterKey = process.env.LATCH_VAULT_KEY;
  if (!masterKey) throw new Error("LATCH_VAULT_KEY is required for the OAuth demo (base64 of 32 bytes).");
  const vault = createVault<Principal>({
    store: createSqliteSecretStore<Principal>(db, { owner }),
    masterKey,
  });
  const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  const successUrl = process.env.OAUTH_SUCCESS_URL ?? `${base}/connections/connected`;
  const oauth = createMcpOAuth<Principal>({
    vault,
    config: {
      name: "demo",
      serverUrl: mcpOAuthServer,
      redirectUrl: `${base}/connections/demo/callback`,
      clientMetadata: {
        redirect_uris: [`${base}/connections/demo/callback`],
        client_name: "Latch Example",
      },
      allowedAuthorizationServers: process.env.MCP_OAUTH_AUTH_SERVERS?.split(","),
    },
  });
  app.get("/connections/demo/authorize", async (c) => {
    const res = await oauth.start(resolveContext(c.req.raw));
    return c.redirect(res.status === "redirect" ? res.authorizationUrl : successUrl);
  });
  app.get("/connections/demo/callback", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.text("missing code", 400);
    await oauth.finish(resolveContext(c.req.raw), { code, state: c.req.query("state") });
    return c.redirect(successUrl);
  });
  app.get("/connections/connected", (c) => c.text("✅ Connected. You can close this tab."));
  console.log("   MCP OAuth: GET /connections/demo/authorize  (→ IdP → /callback)");
}

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

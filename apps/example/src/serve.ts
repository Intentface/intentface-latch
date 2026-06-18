import { serve } from "@hono/node-server";
import { createLatchHono } from "@intentface/latch-server";
import {
  createIntervalScheduler,
  scopeOf,
  type Principal,
} from "@intentface/latch-core";
import { createMcpOAuth } from "@intentface/latch-mcp";
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
const { runtime, vault } = await makeLiveRuntime();

// BYO-auth: the only glue a customer writes. Here we trust a header for the demo;
// a real app derives the Principal from its session. The OAuth routes reuse it.
const resolveContext = (req: Request): Principal => ({
  orgId: req.headers.get("x-org") ?? "org_a",
  userId: req.headers.get("x-user") ?? "user_1",
});

const app = createLatchHono({ runtime, resolveContext });

// Serverless cron entry point: point a platform scheduler (Vercel Cron, etc.)
// at this route. It does the same reap+resume as the in-process loop below.
app.post("/cron/sweep", async (c) => c.json(await runtime.sweep()));

// --- MCP OAuth connection routes (the redirect pages live HERE, in the API) ---
// Env-gated: set MCP_OAUTH_SERVER_URL to a real OAuth-protected MCP server.
// The browser flow: UI links to /authorize → IdP consent → /callback (token
// exchange → Vault, under the authenticated Principal) → success page.
const mcpOAuthServer = process.env.MCP_OAUTH_SERVER_URL;
if (mcpOAuthServer) {
  const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  const successUrl = process.env.OAUTH_SUCCESS_URL ?? `${base}/connections/connected`;
  const oauth = createMcpOAuth({
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
    const scope = scopeOf(resolveContext(c.req.raw));
    const res = await oauth.start(scope);
    return c.redirect(res.status === "redirect" ? res.authorizationUrl : successUrl);
  });

  app.get("/connections/demo/callback", async (c) => {
    const scope = scopeOf(resolveContext(c.req.raw));
    const code = c.req.query("code");
    if (!code) return c.text("missing code", 400);
    await oauth.finish(scope, { code, state: c.req.query("state") });
    return c.redirect(successUrl);
  });

  app.get("/connections/connected", (c) => c.text("✅ Connected. You can close this tab."));
  console.log("   MCP OAuth: GET /connections/demo/authorize  (→ IdP → /callback)");
}

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

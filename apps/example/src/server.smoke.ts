import { createLatchHono } from "@intentface/latch-server";
import type { Principal } from "@intentface/latch-core";
import { assert, makeRuntime } from "./setup.js";

/**
 * The HTTP layer: POST through the Hono route end-to-end (no real port — Hono's
 * `app.request`), with a BYO `resolveContext`. Asserts the streamed response and
 * that the turn persisted under the tenant-namespaced chat id — and that another
 * org cannot see it.
 */
async function main() {
  const { runtime, storage } = await makeRuntime();

  // BYO-auth: this is the only glue a customer writes.
  const app = createLatchHono({
    runtime,
    resolveContext: (req): Principal => {
      const org = req.headers.get("x-org") ?? "org_a";
      return { orgId: org, userId: "user_1" };
    },
  });

  // org_a prompts conversation "ticket-123"
  const res = await app.request("/agents/echo/ticket-123", {
    method: "POST",
    headers: { "content-type": "application/json", "x-org": "org_a" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert(res.status === 200, `route responds 200 (got ${res.status})`);
  const body = await res.text();
  assert(body.length > 0, "route streamed a response");
  await new Promise((r) => setTimeout(r, 50));

  // persisted under the tenant-namespaced id
  const loaded = await storage.loadMessages(
    { orgId: "org_a", userId: "user_1" },
    "org_a:ticket-123",
  );
  assert(loaded.length === 2, `persisted under namespaced id (got ${loaded.length})`);
  const text = (loaded.find((m) => m.role === "assistant")?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert(text === "Hello, world!", "assistant reply persisted");

  // another org hitting the SAME raw id gets a different (empty) chat
  const otherOrg = await storage.loadMessages(
    { orgId: "org_b", userId: "user_1" },
    "org_b:ticket-123",
  );
  assert(otherOrg.length === 0, "tenant-namespaced ids isolate orgs (org_b empty)");

  console.log("✅ server smoke passed — HTTP route → runtime → persistence + isolation");
}

main().catch((e) => {
  console.error("❌ server smoke failed:", e);
  throw e;
});

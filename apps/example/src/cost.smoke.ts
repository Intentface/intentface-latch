import { createClient } from "@libsql/client";
import {
  createRuntime,
  defineAgent,
  defineContext,
  staticPricing,
  type AppMessage,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { assert, latchDb, mockModel, owner, type Principal } from "./setup.js";

/**
 * Cost calc: with a pricing table, the runtime computes cost from token usage
 * and records it on the message metadata, the run (costTotal) and the usage
 * ledger. The mock reports 7 input / 3 output tokens; with rates of 1 unit per
 * token (1e6 per 1M), cost = 7 + 3 = 10.
 */
async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(latchDb(client), { owner });
  const context = defineContext<Principal, { orgId: string }>({ build: ({ principal }) => ({ orgId: principal.orgId }) });
  const agents = {
    echo: defineAgent<Principal, { orgId: string }>(() => ({
      model: mockModel(),
      instructions: "hi",
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context,
    agents,
    // 1 unit per token, so cost = inputTokens + outputTokens (easy to assert).
    pricing: staticPricing({ "mock-model": { inputPer1M: 1_000_000, outputPer1M: 1_000_000 } }),
  });

  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "echo" });
  const userMessage: AppMessage = {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (await runtime.handleChat({ agent: "echo", chatId: chat.id, principal, message: userMessage })).text();
  await new Promise((r) => setTimeout(r, 50));

  // ledger
  const usage = await client.execute("SELECT cost, input_tokens, output_tokens FROM latch_usage LIMIT 1");
  assert(Number(usage.rows[0]?.input_tokens) === 7, "usage input recorded");
  assert(Number(usage.rows[0]?.cost) === 10, `cost computed from pricing (got ${usage.rows[0]?.cost}, want 10)`);

  // run
  const run = await client.execute("SELECT cost_total FROM latch_runs LIMIT 1");
  assert(Number(run.rows[0]?.cost_total) === 10, "cost recorded on the run (costTotal)");

  // message metadata
  const loaded = await storage.loadMessages({ orgId: "org_a", userId: "user_1" }, chat.id);
  const meta = loaded.find((m) => m.role === "assistant")?.metadata as
    | { cost?: number; usage?: { inputTokens?: number } }
    | undefined;
  assert(meta?.cost === 10, "cost stamped on the assistant message");
  assert(meta?.usage?.inputTokens === 7, "usage stamped on the assistant message");

  // no pricing → cost 0
  const r2 = createRuntime<Principal, { orgId: string }>({ storage, context, agents });
  const chat2 = await storage.createChat(principal, { agent: "echo" });
  await (await r2.handleChat({ agent: "echo", chatId: chat2.id, principal, message: { ...userMessage, id: "m2" } })).text();
  await new Promise((r) => setTimeout(r, 50));
  const noPrice = await client.execute("SELECT cost FROM latch_usage WHERE cost = 0 LIMIT 1");
  assert(noPrice.rows.length === 1, "without pricing, cost is 0");

  console.log("✅ cost smoke passed — pricing → cost on message + run + ledger");
}

main().catch((e) => {
  console.error("❌ cost smoke failed:", e);
  throw e;
});

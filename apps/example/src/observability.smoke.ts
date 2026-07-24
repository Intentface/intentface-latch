import { createClient } from "@libsql/client";
import {
  createRuntime,
  defineAgent,
  defineContext,
  staticPricing,
  type AppMessage,
  type ObservabilityFinishEvent,
  type ObservabilityStepEvent,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { assert, mockModel, owner, type Principal } from "./setup.js";

/**
 * Observability seam: the optional `observability` hooks let a consumer attach
 * its own telemetry (per-step + per-turn) without wrapping `handleChat`. Fires
 * fire-and-forget; a thrown hook never breaks the turn. The mock reports 7 input
 * / 3 output tokens; with 1 unit/token pricing, turn cost = 10.
 */
async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<Principal, { orgId: string }>(() => ({
      model: mockModel(),
      instructions: "hi",
    })),
  };

  const steps: ObservabilityStepEvent<Principal>[] = [];
  const finishes: ObservabilityFinishEvent<Principal>[] = [];
  let threw = false;

  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context,
    agents,
    pricing: staticPricing({
      "mock-model": { inputPer1M: 1_000_000, outputPer1M: 1_000_000 },
    }),
    observability: {
      onStep: (e) => {
        steps.push(e);
      },
      onFinish: (e) => {
        finishes.push(e);
      },
      // A throwing hook must not break the turn (fire-and-forget).
      onError: () => {
        threw = true;
        throw new Error("boom");
      },
    },
  });

  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "echo" });
  const userMessage: AppMessage = {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (
    await runtime.handleChat({
      agent: "echo",
      chatId: chat.id,
      principal,
      message: userMessage,
    })
  ).text();
  await new Promise((r) => setTimeout(r, 50));

  // onStep fired at least once, carrying usage + base fields.
  assert(steps.length >= 1, `onStep fired (got ${steps.length})`);
  assert(steps[0]!.chatId === chat.id, "onStep carries chatId");
  assert(steps[0]!.agent === "echo", "onStep carries agent");
  assert(steps[0]!.depth === 0, "onStep depth 0 at top level");
  assert(
    steps.some((s) => (s.step.usage?.inputTokens ?? 0) > 0),
    "onStep carries step usage",
  );

  // onFinish fired once, with the settled status + turn totals + cost.
  assert(finishes.length === 1, `onFinish fired once (got ${finishes.length})`);
  const f = finishes[0]!;
  assert(f.status === "completed", `onFinish status completed (got ${f.status})`);
  assert(f.chatId === chat.id, "onFinish carries chatId");
  assert(f.runId.length > 0, "onFinish carries runId");
  assert(f.usage.inputTokens === 7, `onFinish usage input 7 (got ${f.usage.inputTokens})`);
  assert(f.cost === 10, `onFinish cost 10 (got ${f.cost})`);
  assert(f.messages.some((m) => m.role === "assistant"), "onFinish carries messages");

  assert(!threw, "onError not called on a successful turn");

  console.log(
    "✅ observability smoke passed — onStep + onFinish fire with usage/cost/base fields",
  );
}

main().catch((e) => {
  console.error("❌ observability smoke failed:", e);
  throw e;
});

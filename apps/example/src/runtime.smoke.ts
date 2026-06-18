import { createClient } from "@libsql/client";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
  type Principal,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";

/**
 * End-to-end T1: run one turn through the Runtime with a MOCK model (no API key),
 * then assert the conversation + run + usage were persisted. Exercises the whole
 * loop: context → agent → ToolLoopAgent → stream → onFinish/onStepEnd → storage.
 */
async function main() {
  // 1. storage (in-memory libsql)
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter(client);

  // 2. a mock model that streams "Hello, world!" — zero infra, no API key
  const model = new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: {
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Hello" },
          { type: "text-delta", id: "0", delta: ", world!" },
          { type: "text-end", id: "0" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } },
          },
        ],
      }),
    } as never,
  });

  // 3. context + one agent
  const context = defineContext<{ orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<{ orgId: string }>(() => ({
      model,
      instructions: "You are a friendly assistant.",
    })),
  };

  // 4. the runtime
  const runtime = createRuntime({ storage, context, agents });

  // 5. run a turn (pre-create the chat so we can inspect it afterward)
  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat({
    orgId: "org_a",
    userId: "user_1",
    agent: "echo",
  });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  const res = await runtime.handleChat({
    agent: "echo",
    chatId: chat.id,
    principal,
    message: userMessage,
  });
  assert(res instanceof Response, "handleChat returns a Response");
  const body = await res.text(); // consume the stream to completion
  assert(body.length > 0, "stream produced output");
  await new Promise((r) => setTimeout(r, 50)); // let onFinish writes settle

  // 6. assert persistence: conversation
  const loaded = await storage.loadMessages(
    { orgId: "org_a", userId: "user_1" },
    chat.id,
  );
  assert(loaded.length === 2, `user + assistant persisted (got ${loaded.length})`);
  const assistant = loaded.find((m) => m.role === "assistant");
  const text = (assistant?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert(text === "Hello, world!", `assistant text persisted (got: "${text}")`);

  // 7. assert the run + usage were written by onFinish/onStepEnd
  const runRow = await client.execute("SELECT status FROM latch_runs LIMIT 1");
  assert(runRow.rows[0]?.status === "completed", "run marked completed");
  const usageRow = await client.execute(
    "SELECT count(*) AS n, sum(input_tokens) AS inp FROM latch_usage",
  );
  assert(Number(usageRow.rows[0]?.n) === 1, "usage recorded");
  assert(Number(usageRow.rows[0]?.inp) === 7, "usage tokens captured from onStepEnd");

  console.log("✅ runtime smoke passed — full T1 turn persisted (messages + run + usage)");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

main().catch((e) => {
  console.error("❌ runtime smoke failed:", e);
  throw e;
});

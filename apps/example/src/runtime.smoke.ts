import type { AppMessage, Principal } from "@intentface/latch-core";
import { assert, makeRuntime } from "./setup.js";

/**
 * End-to-end T1: run one turn through the Runtime with a mock model, then assert
 * the conversation + run + usage were persisted. Exercises the whole loop:
 * context → agent → ToolLoopAgent → stream → onFinish/onStepEnd → storage.
 */
async function main() {
  const { runtime, storage, client } = await makeRuntime();

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
  const body = await res.text();
  assert(body.length > 0, "stream produced output");
  await new Promise((r) => setTimeout(r, 50));

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

  const runRow = await client.execute("SELECT status FROM latch_runs LIMIT 1");
  assert(runRow.rows[0]?.status === "completed", "run marked completed");
  const usageRow = await client.execute(
    "SELECT count(*) AS n, sum(input_tokens) AS inp FROM latch_usage",
  );
  assert(Number(usageRow.rows[0]?.n) === 1, "usage recorded");
  assert(Number(usageRow.rows[0]?.inp) === 7, "usage tokens captured from onStepEnd");

  console.log("✅ runtime smoke passed — full T1 turn persisted (messages + run + usage)");
}

main().catch((e) => {
  console.error("❌ runtime smoke failed:", e);
  throw e;
});

import type { AppMessage } from "@intentface/latch-core";
import { assert, makeToolRuntime, type Principal } from "./setup.js";

/**
 * Tool loop end to end: the mock calls `getCurrentTime`, the runtime executes
 * it, the model answers from the result. Asserts the assistant message persists
 * BOTH a tool part and the final text, and that usage accumulated across the two
 * steps (onStepEnd fired per step).
 */
async function main() {
  const { runtime, storage, client } = await makeToolRuntime();
  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "clock" });

  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "What time is it in Tokyo?" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  const res = await runtime.handleChat({
    agent: "clock",
    chatId: chat.id,
    principal,
    message: userMessage,
  });
  await res.text();
  await new Promise((r) => setTimeout(r, 50));

  const loaded = await storage.loadMessages(principal, chat.id);
  assert(loaded.length === 2, `user + assistant persisted (got ${loaded.length})`);

  const assistant = loaded.find((m) => m.role === "assistant");
  const partTypes = (assistant?.parts ?? []).map((p) => p.type);
  const toolPart = (assistant?.parts ?? []).find((p) => p.type.startsWith("tool-")) as
    | { type: string; state?: string; output?: unknown; input?: unknown }
    | undefined;
  assert(!!toolPart, `assistant has a tool part (parts: ${partTypes.join(", ")})`);
  assert(
    toolPart?.type === "tool-getCurrentTime",
    `tool part is typed by name (got ${toolPart?.type})`,
  );
  assert(
    (toolPart?.output as { timeZone?: string } | undefined)?.timeZone === "Asia/Tokyo",
    "tool output (the executed result) is persisted on the message",
  );

  const text = (assistant?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert(text.includes("Tokyo"), `final answer persisted after the tool ran (got: "${text}")`);

  const runRow = await client.execute("SELECT status FROM latch_runs LIMIT 1");
  assert(runRow.rows[0]?.status === "completed", "run marked completed");
  const usage = await client.execute(
    "SELECT input_tokens AS inp, output_tokens AS outp FROM latch_usage LIMIT 1",
  );
  assert(Number(usage.rows[0]?.inp) === 22, `usage summed across 2 steps (got ${usage.rows[0]?.inp}, want 22)`);
  assert(Number(usage.rows[0]?.outp) === 11, `output usage summed (got ${usage.rows[0]?.outp}, want 11)`);

  console.log("✅ tools smoke passed — tool-call → execute → answer, persisted with summed usage");
}

main().catch((e) => {
  console.error("❌ tools smoke failed:", e);
  throw e;
});

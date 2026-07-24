import type { AppMessage } from "@intentface/latch-core";
import { assert, makeRuntime, type Principal } from "./setup.js";

/**
 * `runTurnStream`: run a full turn from supplied messages and stream it back
 * while persisting NOTHING — no chat, run, message, or usage rows. Observability
 * still fires. For read-mostly, single-shot loops (inline editor assist).
 */
async function main() {
  const { runtime, storage, client } = await makeRuntime();
  const principal: Principal = { orgId: "org_a", userId: "user_1" };

  const message: AppMessage = {
    id: "msg_1",
    role: "user",
    parts: [{ type: "text", text: "rewrite this" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  const res = await runtime.runTurnStream({
    agent: "echo",
    principal,
    messages: [message],
  });
  assert(res instanceof Response, "runTurnStream returns a Response");
  const body = await res.text();
  assert(body.includes("Hello, world!"), "stream produced the model output");
  await new Promise((r) => setTimeout(r, 50));

  // The whole point: no rows written anywhere.
  const chats = await client.execute("SELECT count(*) AS n FROM latch_chats");
  const msgs = await client.execute("SELECT count(*) AS n FROM latch_messages");
  const runs = await client.execute("SELECT count(*) AS n FROM latch_runs");
  const usage = await client.execute("SELECT count(*) AS n FROM latch_usage");
  assert(Number(chats.rows[0]?.n) === 0, "no chat rows persisted");
  assert(Number(msgs.rows[0]?.n) === 0, "no message rows persisted");
  assert(Number(runs.rows[0]?.n) === 0, "no run rows persisted");
  assert(Number(usage.rows[0]?.n) === 0, "no usage rows persisted");

  // And the adapter genuinely has no thread to load.
  const loaded = await storage.loadMessages(principal, "ephemeral");
  assert(loaded.length === 0, "no loadable history for the ephemeral turn");

  // `format: "text"` → a plain text/plain body (not SSE), and `onComplete`
  // hands back the assembled text + messages for capturing side outputs.
  let captured: { text: string; messages: unknown[] } | null = null;
  const textRes = await runtime.runTurnStream({
    agent: "echo",
    principal,
    messages: [message],
    format: "text",
    onComplete: (r) => {
      captured = { text: r.text, messages: r.messages };
    },
  });
  assert(
    (textRes.headers.get("content-type") ?? "").includes("text/plain"),
    "text format returns a text/plain response",
  );
  const textBody = await textRes.text();
  assert(textBody === "Hello, world!", `text body is raw text (got: "${textBody}")`);
  await new Promise((r) => setTimeout(r, 20));
  assert(captured !== null, "onComplete fired");
  assert(
    captured!.text === "Hello, world!",
    "onComplete received the assembled assistant text",
  );

  console.log("✅ ephemeral smoke passed — runTurnStream: zero persistence, text format + onComplete");
}

main().catch((e) => {
  console.error("❌ ephemeral smoke failed:", e);
  throw e;
});

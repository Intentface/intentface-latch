import {
  toClientMessages,
  toModelMessages,
  type AppMessage,
} from "@intentface/latch-core";
import { assert, makeRuntime, type Principal } from "./setup.js";

/**
 * The two message projections + their defaults. `toClientMessages` hides
 * `internal`/`redacted`; `toModelMessages` drops `sendToModel:false`. Absent
 * axes default permissively (shown / sent). Also checks `runtime.loadHistory`
 * applies the client projection.
 */
const msg = (
  id: string,
  role: "user" | "assistant",
  text: string,
  metadata: AppMessage["metadata"],
): AppMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
  metadata,
});

async function main() {
  const messages: AppMessage[] = [
    msg("m1", "user", "hello", { visibility: "user", createdAt: 1 }),
    msg("m2", "assistant", "hi", {}), // no axes → defaults (shown + sent)
    msg("m3", "assistant", "scratch note", { visibility: "internal" }), // hide from user
    msg("m4", "assistant", "stale tool dump", { visibility: "user", sendToModel: false }), // show, don't resend
    msg("m5", "assistant", "audit only", { visibility: "redacted" }),
  ];

  // --- client projection -------------------------------------------------
  const client = toClientMessages(messages).map((m) => m.id);
  assert(client.includes("m1") && client.includes("m2"), "user/default messages shown to client");
  assert(client.includes("m4"), "sendToModel:false still shown to client");
  assert(!client.includes("m3"), "internal hidden from client");
  assert(!client.includes("m5"), "redacted hidden from client");

  // --- model projection --------------------------------------------------
  const model = await toModelMessages(messages);
  const modelText = JSON.stringify(model);
  assert(modelText.includes("hello") && modelText.includes("scratch note"), "default + internal sent to model");
  assert(!modelText.includes("stale tool dump"), "sendToModel:false excluded from model");
  // (internal is still sent to the model — visibility is a CLIENT axis, independent of sendToModel)

  // --- defaults are permissive ------------------------------------------
  assert(toClientMessages([msg("x", "assistant", "y", {})]).length === 1, "absent visibility → shown");
  assert((await toModelMessages([msg("x", "user", "y", {})])).length === 1, "absent sendToModel → sent");

  // --- runtime.loadHistory applies the client projection -----------------
  const { runtime, storage } = await makeRuntime();
  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "echo" });
  await storage.appendMessages(chat.id, [
    msg("h1", "user", "shown", { visibility: "user" }),
    msg("h2", "assistant", "hidden summary", { visibility: "internal" }),
  ]);
  const history = await runtime.loadHistory({ chatId: chat.id, principal });
  assert(history.length === 1 && history[0]!.id === "h1", "loadHistory drops internal messages");

  console.log("✅ projections smoke passed — client hides internal/redacted, model drops sendToModel:false");
}

main().catch((e) => {
  console.error("❌ projections smoke failed:", e);
  throw e;
});

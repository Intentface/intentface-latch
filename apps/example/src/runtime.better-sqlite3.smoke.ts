import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppMessage } from "@intentface/latch-core";
import {
  createRuntime,
  defineAgent,
  defineContext,
  isChatBusyError,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrateWith, schema } from "@intentface/latch-drizzle";
import { assert, mockModel, owner, type Principal } from "./setup.js";

/**
 * Driver-portability smoke: the same core runtime loop as `runtime.smoke.ts`,
 * but on better-sqlite3 instead of libsql. Proves the client-free adapter takes
 * any Drizzle SQLite db and that `migrateWith` creates the schema through an
 * arbitrary executor (`db.run(sql.raw(...))`).
 */
async function main() {
  const db = drizzle(new Database(":memory:"), { schema });
  await migrateWith((s) => db.run(sql.raw(s)));

  const storage = createSqliteAdapter<Principal>(db, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<Principal, { orgId: string }>(() => ({
      model: mockModel(),
      instructions: "You are a friendly assistant.",
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context,
    agents,
  });

  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "echo" });
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

  const loaded = await storage.loadMessages(principal, chat.id);
  assert(loaded.length === 2, `user + assistant persisted (got ${loaded.length})`);

  // One active run per chat on the SYNC driver too, through the synchronous
  // transaction path of openTurn: a second open is refused and its message
  // never lands.
  const busyChat = await storage.createChat(principal, { agent: "echo" });
  const msg = (id: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text: id }], metadata: { visibility: "user", createdAt: Date.now() } });
  await storage.openTurn!(principal, { chatId: busyChat.id, agent: "echo", message: msg("first") });
  let refused = false;
  try {
    await storage.openTurn!(principal, { chatId: busyChat.id, agent: "echo", message: msg("second") });
  } catch (e) {
    refused = isChatBusyError(e);
  }
  assert(refused, "openTurn on a busy chat is refused (sync driver)");
  const busyMsgs = await storage.loadMessages(principal, busyChat.id);
  assert(busyMsgs.length === 1 && busyMsgs[0]!.id === "first", "refused turn's message not persisted (sync driver)");
  const assistant = loaded.find((m) => m.role === "assistant");
  const text = (assistant?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert(text === "Hello, world!", `assistant text persisted (got: "${text}")`);

  const runRows = await db.select().from(schema.runs);
  assert(runRows[0]?.status === "completed", "run marked completed");
  const usageRows = await db.select().from(schema.usage);
  assert(usageRows.length === 1, "usage recorded");
  assert(usageRows[0]?.inputTokens === 7, "usage tokens captured from onStepEnd");

  // Second turn on the SAME chat — each assistant reply appends with a fresh id.
  const secondMessage: AppMessage = {
    id: "msg_user_2",
    role: "user",
    parts: [{ type: "text", text: "again" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (
    await runtime.handleChat({
      agent: "echo",
      chatId: chat.id,
      principal,
      message: secondMessage,
    })
  ).text();
  await new Promise((r) => setTimeout(r, 50));

  const afterTwo = await storage.loadMessages(principal, chat.id);
  assert(afterTwo.length === 4, `two turns persist 4 messages (got ${afterTwo.length})`);
  const assistantIds = afterTwo.filter((m) => m.role === "assistant").map((m) => m.id);
  assert(
    new Set(assistantIds).size === 2 && assistantIds.every((id) => id.length > 0),
    "each assistant turn has a distinct, non-empty id",
  );

  console.log(
    "✅ runtime better-sqlite3 smoke passed — client-free adapter + migrateWith on a non-libsql driver",
  );
}

main().catch((e) => {
  console.error("❌ runtime better-sqlite3 smoke failed:", e);
  throw e;
});

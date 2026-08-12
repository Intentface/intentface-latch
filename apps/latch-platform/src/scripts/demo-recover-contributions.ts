/** One-off demo recovery: the engineers' interview saves failed (missing
 * anchor/interviews folder, since fixed) and the agent dumped the full
 * contributions inline per its save-failure contract. Extract the fenced
 * markdown from each chat's final assistant message and write it to the
 * workspace path the agent intended — as that persona. */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";
import { PERSONAS } from "./demo-setup";

const CHATS: Array<{ email: string; chatId: string; path: string }> = [
  {
    email: PERSONAS[0].email, // marta
    chatId: "marta-interview-s1",
    path: "anchor/interviews/marta_koskinen_2026-08-11_s1.md",
  },
  {
    email: PERSONAS[1].email, // jussi
    chatId: "jussi-interview-s1",
    path: "anchor/interviews/jussi_virtanen_2026-08-11_s1.md",
  },
];

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const admin = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const adminRow = admin.rows[0] as unknown as { id: unknown } | undefined;
  if (!adminRow) throw new Error("admin user not found — run demo-setup.ts first");
  const orgId = `user:${String(adminRow.id)}`;
  const { memoryStore } = await getLatch();

  for (const c of CHATS) {
    const u = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [c.email] });
    const uRow = u.rows[0] as unknown as { id: unknown } | undefined;
    if (!uRow) throw new Error(`persona missing (run demo-setup first): ${c.email}`);
    const principal = { orgId, userId: String(uRow.id) };

    const msgs = await db.execute({
      sql: `SELECT parts FROM latch_messages WHERE chat_id = ? AND role = 'assistant' ORDER BY seq`,
      args: [c.chatId],
    });
    let contribution: string | undefined;
    for (const row of msgs.rows as unknown as Array<{ parts: string }>) {
      let parts: Array<{ type: string; text?: string }>;
      try {
        parts = JSON.parse(String(row.parts)) as Array<{ type: string; text?: string }>;
      } catch {
        console.error(`  skipping unparsable message parts in ${c.chatId}`);
        continue;
      }
      const text = parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n");
      const m = text.match(/```(?:markdown)?\s*\n(# Anchor Interview —[\s\S]*?)\n```/);
      if (m) contribution = m[1];
    }
    if (!contribution) {
      console.error(`✗ no fenced contribution found in ${c.chatId}`);
      process.exitCode = 1;
      continue;
    }
    await memoryStore.writeFile(principal, {
      connection: "anchor-build",
      path: c.path,
      content: contribution,
      summary: `Anchor interview contribution (recovered from chat after save failure) — ${c.chatId}`,
    });
    const back = await memoryStore.readFile(principal, { connection: "anchor-build", path: c.path });
    if (!back) process.exitCode = 1;
    console.log(`${back ? "✓ recovered" : "✗ write failed"}  ${c.path}  (${contribution.length} chars)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

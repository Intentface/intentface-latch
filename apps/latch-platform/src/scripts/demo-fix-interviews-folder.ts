/** One-off demo fix: materialize `anchor/interviews/` in the demo workspace —
 * anchor-build_create targets it by folderId and fails when it doesn't exist. */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";
import { PERSONAS } from "./demo-setup";

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const admin = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const orgId = `user:${String((admin.rows[0] as unknown as { id: unknown }).id)}`;
  const p1 = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [PERSONAS[0].email] });
  const principal = { orgId, userId: String((p1.rows[0] as unknown as { id: unknown }).id) };

  const { memoryStore } = await getLatch();
  await memoryStore.writeFile(principal, {
    connection: "anchor-build",
    path: "anchor/interviews/README.md",
    content:
      "# Interviews\n\nAnchor interview contributions land here (one file per expert per session).",
    summary: "Placeholder so the anchor/interviews folder exists for anchor-build_create",
  });
  const back = await memoryStore.readFile(principal, {
    connection: "anchor-build",
    path: "anchor/interviews/README.md",
  });
  console.log("folder materialized:", back != null);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

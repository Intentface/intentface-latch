/** One-off demo fix: materialize `anchor/interviews/` in the demo workspace —
 * anchor-build_create targets it by folderId and fails when it doesn't exist. */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";
import { PERSONAS } from "./demo-setup";

function idOf(rows: unknown[], who: string): string {
  const row = rows[0] as { id: unknown } | undefined;
  if (!row) throw new Error(`${who} not found — run demo-setup.ts first`);
  return String(row.id);
}

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const admin = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const orgId = `user:${idOf(admin.rows, "admin user")}`;
  const p1 = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [PERSONAS[0].email] });
  const principal = { orgId, userId: idOf(p1.rows, PERSONAS[0].email) };

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
  if (back == null) {
    console.error("folder NOT materialized: read-back returned nothing");
    process.exitCode = 1;
    return;
  }
  console.log("folder materialized: true");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

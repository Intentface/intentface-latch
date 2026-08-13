/** Live verification of the shared-root anchoring fix: write + round-trip the
 * user schema at the NEW anchored path in the anchor-interviews workspace.
 * Proves `__shared_root/...` resolves for create and read through the store. */
import { createClient } from "@libsql/client";
import { USER_SCHEMA_PATH } from "@intentface/latch-memory";
import { getLatch } from "../lib/latch";

const USER_SCHEMA = `## Profile
## Preferences
## Life & work context`;

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const u = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const row = u.rows[0] as unknown as { id: unknown } | undefined;
  if (!row) throw new Error("local admin user missing");
  const userId = String(row.id);
  const s = await db.execute({
    sql: `SELECT activeOrganizationId FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
    args: [userId],
  });
  const orgId =
    (s.rows[0] as unknown as { activeOrganizationId?: string } | undefined)
      ?.activeOrganizationId ?? `user:${userId}`;
  const principal = { orgId, userId };

  console.log("anchored path:", USER_SCHEMA_PATH);
  const { memoryStore } = await getLatch();
  await memoryStore.writeFile(principal, {
    connection: "anchor-interviews",
    path: USER_SCHEMA_PATH,
    content: USER_SCHEMA,
    summary: "Shared user-level memory schema (all agents, profile-level facts only)",
  });
  const back = await memoryStore.readFile(principal, {
    connection: "anchor-interviews",
    path: USER_SCHEMA_PATH,
  });
  if (back?.trim() !== USER_SCHEMA.trim()) {
    throw new Error(`round-trip mismatch:\n---got---\n${back}`);
  }
  console.log("✓ wrote + round-tripped at the shared-root-anchored path");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

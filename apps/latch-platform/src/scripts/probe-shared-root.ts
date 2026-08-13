/** Live verification of the shared-root anchoring fix: write + round-trip the
 * user schema at the NEW anchored path. Proves `__shared_root/...` resolves
 * for create and read through the store.
 *   node --env-file=.env --import tsx src/scripts/probe-shared-root.ts <connection> [--force]
 * The target file is the connection's LIVE shared user schema, so the write is
 * create-or-confirm only: an existing schema with different content is never
 * overwritten unless --force is passed.
 */
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

  const args = process.argv.slice(2).filter((a) => a !== "--force");
  const force = process.argv.includes("--force");
  const connection = args[0];
  if (!connection) {
    throw new Error("usage: probe-shared-root.ts <connection> [--force] — the target file is that connection's LIVE shared user schema");
  }

  console.log(`anchored path: ${USER_SCHEMA_PATH} (connection ${connection})`);
  const { memoryStore } = await getLatch();

  // The target is live org-wide config — never clobber a customized schema.
  const existing = await memoryStore.readFile(principal, { connection, path: USER_SCHEMA_PATH });
  if (existing != null && existing.trim() !== USER_SCHEMA.trim() && !force) {
    console.error(
      "refusing to overwrite an existing, different shared schema — re-run with --force if that is intended",
    );
    process.exitCode = 1;
    return;
  }
  if (existing?.trim() === USER_SCHEMA.trim()) {
    console.log("✓ anchored path already resolves and holds the fixture — nothing to write");
    return;
  }

  await memoryStore.writeFile(principal, {
    connection,
    path: USER_SCHEMA_PATH,
    content: USER_SCHEMA,
    summary: "Shared user-level memory schema (all agents, profile-level facts only)",
  });
  const back = await memoryStore.readFile(principal, { connection, path: USER_SCHEMA_PATH });
  if (back?.trim() !== USER_SCHEMA.trim()) {
    throw new Error(`round-trip mismatch:\n---got---\n${back}`);
  }
  console.log("✓ wrote + round-tripped at the shared-root-anchored path");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

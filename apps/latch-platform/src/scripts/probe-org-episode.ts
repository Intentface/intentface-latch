/** One-off probe: does the production org episode actually exist in the
 * anchor-interviews workspace? Reads via the local anchor-interviews grant. */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";

const PATHS = [
  "_memory/ai-systems-interviewer/org/episodes/2026-08-12-19-35-compound-questions-clarity-friction.md",
  "_memory/ai-systems-interviewer/org/MEMORY.md",
  // Explicitly-anchored probes: if the PRIVATE one resolves, the "org" chain
  // landed inside the caller's own private tree (caller-relative resolution).
  "__private_root/_memory/ai-systems-interviewer/org/MEMORY.md",
  "__shared_root/_memory/ai-systems-interviewer/org/MEMORY.md",
  "__shared_root/_memory/_user/SCHEMA.md",
  "domains/ai-system-design.md", // known-good control
];

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
  const { memoryStore } = await getLatch();
  for (const path of PATHS) {
    try {
      const text = await memoryStore.readFile({ orgId, userId }, { connection: "anchor-interviews", path });
      console.log(text != null ? `✓ EXISTS (${text.length} chars)` : `✗ NOT FOUND`, "—", path);
      if (text != null && path.includes("episodes")) console.log(text.slice(0, 300));
    } catch (e) {
      console.log(`✗ ERROR — ${path}: ${String(e).slice(0, 120)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

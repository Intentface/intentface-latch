/**
 * One-shot backfill: give every existing user a real "Personal" organization,
 * idempotently. Each org's id is `user:<userId>` — the exact key the personal
 * scope already used — so data created under the old synthetic tenant belongs to
 * the new switchable org with zero reassignment.
 *
 *   pnpm --filter latch-platform backfill:personal-orgs
 *
 * Safe to run repeatedly (skips users who already have their personal org).
 * Reads DATABASE_URL / TURSO_AUTH_TOKEN from the environment.
 */
import { createClient } from "@libsql/client";
import { ensurePersonalOrg } from "../lib/auth";

async function main() {
  const url = process.env.DATABASE_URL ?? "file:./latch.db";
  console.log(`[backfill] ${url}`);
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  const users = await client.execute(`SELECT id FROM user`);
  for (const row of users.rows) {
    const userId = String((row as unknown as { id: unknown }).id);
    const orgId = await ensurePersonalOrg(userId);
    console.log(`[backfill] ${userId} → ${orgId}`);
  }
  console.log(`[backfill] ensured personal orgs for ${users.rows.length} users`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });

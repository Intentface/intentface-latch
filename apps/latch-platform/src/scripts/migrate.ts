/**
 * One-shot DB migration: creates/updates every table this app needs in the
 * configured database, then exits. Run it before/at deploy (e.g. a Vercel
 * build step or a one-off) instead of relying on lazy table creation.
 *
 *   pnpm --filter latch-platform db:migrate
 *
 * Reads DATABASE_URL / TURSO_AUTH_TOKEN from the environment (the runner loads
 * .env if present). Requires the workspace packages to be built (pnpm build).
 */
import { createClient } from "@libsql/client";
import { migrate } from "@intentface/latch-drizzle";
import { getMigrations } from "better-auth/db/migration";
import { migrateSlack } from "../lib/slack-store";
import { migrateChannels } from "../lib/channel-store";
import { auth } from "../lib/auth";

async function main() {
  const url = process.env.DATABASE_URL ?? "file:./latch.db";
  console.log(`[migrate] ${url}`);
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  // Latch tables (chats / messages / runs / usage / secrets / schedules / agents)…
  await migrate(client);
  // …Slack-only state (app bindings, thread ownership)…
  await migrateSlack(client);
  // …the shared channel tables, carrying the legacy per-channel tables over
  // (copy, then drop). Point DATABASE_URL at a COPY first to rehearse it.
  await migrateChannels(client);
  console.log("[migrate] latch tables ✓");

  // …and better-auth tables (user / session / account / organization / member).
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  console.log("[migrate] auth tables ✓");
}

main()
  .then(() => {
    console.log("[migrate] done");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });

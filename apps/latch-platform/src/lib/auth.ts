import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { LibsqlDialect } from "@libsql/kysely-libsql";

/**
 * better-auth server instance.
 *
 * One libsql/SQLite database (shared with the Latch runtime in dev) via the
 * built-in Kysely adapter — no Drizzle, so no version clash with latch-drizzle.
 * The `organization` plugin is the multi-tenant boundary: an org id becomes the
 * Latch `Principal.orgId`. `tanstackStartCookies` must be last (it forwards
 * Set-Cookie from server calls).
 */
const dialect = new LibsqlDialect({
  url: process.env.DATABASE_URL ?? "file:./latch.db",
});

export const auth = betterAuth({
  database: { dialect, type: "sqlite" },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  emailAndPassword: { enabled: true },
  plugins: [organization(), tanstackStartCookies()],
});

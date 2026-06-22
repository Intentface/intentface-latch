import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { createClient } from "@libsql/client";

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

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// Direct client for the session hook below (the Kysely dialect above is
// better-auth's; this is just a small lookup against the same DB file).
const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });

/** The user's earliest org membership — their default tenant. */
async function firstOrgFor(userId: string): Promise<string | undefined> {
  const res = await db.execute({
    sql: `SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1`,
    args: [userId],
  });
  const id = (res.rows[0] as { organizationId?: unknown } | undefined)?.organizationId;
  return id ? String(id) : undefined;
}

export const auth = betterAuth({
  baseURL,
  trustedOrigins: [baseURL],
  database: { dialect, type: "sqlite" },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  emailAndPassword: { enabled: true },
  // Pin the active organization on session create. Without this, a session with
  // no active org resolves to a *personal* tenant (`user:<id>` — see
  // session.ts), so the same user's data (connections, agents, chats, OAuth
  // tokens) silently splits across two owners. Defaulting to the user's first
  // org keeps `Principal.orgId` stable; switching orgs still updates it.
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const s = session as { userId: string; activeOrganizationId?: string };
          if (s.activeOrganizationId) return;
          const orgId = await firstOrgFor(s.userId);
          return orgId ? { data: { ...session, activeOrganizationId: orgId } } : undefined;
        },
      },
    },
  },
  plugins: [organization(), tanstackStartCookies()],
});

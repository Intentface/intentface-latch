/**
 * Real identity for the lab, so the SDK's tenancy claims are exercised by
 * people rather than by tests.
 *
 * Email and password only, with the organization plugin. No domain allowlist
 * and no invitation email — this is a workbench, not a product — but the one
 * rule that matters is carried over from `latch-platform` verbatim, because
 * getting it wrong splits a tenant's data in half:
 *
 *   Pin the active organization on session create. A session with no active
 *   org resolves to a personal tenant, so the same user's conversations,
 *   budgets and history silently land under two different owners.
 */
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.AGENTS_LAB_DB ?? ".data/lab.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

/** Auth shares the lab's SQLite file; better-auth owns its own tables in it. */
const database = new Database(DB_PATH);
database.exec("PRAGMA journal_mode = WAL;");

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3200";

/** The org a user lands in when they have none: their own. */
const personalOrgId = (userId: string) => `user:${userId}`;

function ensurePersonalOrg(userId: string, name: string) {
  const id = personalOrgId(userId);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, name, id.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), now);
  database
    .prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)
         ON CONFLICT(id) DO NOTHING`,
    )
    .run(`m:${id}:${userId}`, id, userId, now);
  return id;
}

/**
 * The user's first organization by join date.
 *
 * Exported because the session hook cannot be relied on for the FIRST session:
 * at sign-up, `session.create.before` runs before `user.create.after` has made
 * the personal org, so that session is left with no active organization.
 * Resolving membership per request is deterministic and does not depend on
 * hook ordering.
 */
export function firstOrgFor(userId: string): string | undefined {
  const row = database
    .prepare(`SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1`)
    .get(userId) as { organizationId: string } | undefined;
  return row?.organizationId;
}

export const auth = betterAuth({
  database,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET ?? "agents-lab-dev-secret-not-for-production",
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const u = user as { id: string; name?: string; email?: string };
          try {
            ensurePersonalOrg(u.id, u.name || u.email || "Personal");
          } catch (e) {
            // Best effort: a failure here must not block account creation.
            console.warn("[auth] personal org failed:", e instanceof Error ? e.message : e);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const s = session as { userId: string; activeOrganizationId?: string };
          if (s.activeOrganizationId) return;
          const orgId = firstOrgFor(s.userId);
          return orgId ? { data: { ...session, activeOrganizationId: orgId } } : undefined;
        },
      },
    },
  },
  plugins: [organization(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

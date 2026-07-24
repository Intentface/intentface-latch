import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { createClient } from "@libsql/client";
import { baseUrl } from "./base-url";
import { sendEmail } from "./email";

/** Sign-in/up is restricted to this email domain (org policy). */
const ALLOWED_DOMAIN = "@intentface.com";
const isAllowedEmail = (email: unknown): boolean =>
  typeof email === "string" && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
const DOMAIN_ERROR = `Only ${ALLOWED_DOMAIN} email addresses may sign in.`;

/** Google social login is enabled only when its OAuth client is configured. */
const googleProvider = process.env.GOOGLE_CLIENT_ID
  ? {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        prompt: "select_account" as const,
      },
    }
  : undefined;

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
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Canonical origin (shared resolver: PUBLIC_BASE_URL → BETTER_AUTH_URL →
// VERCEL_PROJECT_PRODUCTION_URL → localhost) so auth agrees with the rest of the app.
const baseURL = baseUrl();

// Trust the canonical baseURL, the Vercel prod alias + current preview host, and
// any extra origins listed in TRUSTED_ORIGINS (comma-separated) — so logins work
// across a custom domain, the *.vercel.app alias, and preview deploys.
const vercelProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const vercelUrl = process.env.VERCEL_URL;
const extraOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const trustedOrigins = [
  ...new Set(
    [
      baseURL,
      vercelProdUrl && `https://${vercelProdUrl}`,
      vercelUrl && `https://${vercelUrl}`,
      ...extraOrigins,
    ].filter((o): o is string => Boolean(o)),
  ),
];

// Direct client for the session hook below (the Kysely dialect above is
// better-auth's; this is just a small lookup against the same DB file).
const db = createClient({
  url: process.env.DATABASE_URL ?? "file:./latch.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/** The user's earliest org membership — their default tenant. */
async function firstOrgFor(userId: string): Promise<string | undefined> {
  const res = await db.execute({
    sql: `SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1`,
    args: [userId],
  });
  const id = (res.rows[0] as { organizationId?: unknown } | undefined)?.organizationId;
  return id ? String(id) : undefined;
}

/**
 * Ensure a user has a real "Personal" organization, idempotently. The org id is
 * pinned to `user:<userId>` — the exact key the Latch `owner` derives for the
 * personal scope (see session.ts / latch.ts) — so any data already created under
 * the synthetic personal tenant belongs to this real, switchable org with no
 * reassignment. Used by the signup hook (new users) and the backfill script
 * (existing ones). Returns the org id.
 */
export async function ensurePersonalOrg(userId: string): Promise<string> {
  const orgId = `user:${userId}`;
  const now = new Date().toISOString();

  const org = await db.execute({ sql: `SELECT id FROM organization WHERE id = ?`, args: [orgId] });
  if (org.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`,
      args: [orgId, "Personal", `personal-${userId}`, now],
    });
  }

  const member = await db.execute({
    sql: `SELECT id FROM member WHERE organizationId = ? AND userId = ?`,
    args: [orgId, userId],
  });
  if (member.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), orgId, userId, "owner", now],
    });
  }
  return orgId;
}

/**
 * Is the user CURRENTLY a member of the org? Channel identity links
 * (Telegram/WhatsApp) persist independently of membership, so webhook turns
 * re-check this before minting a principal — a removed member must not keep
 * channel access to the org's agents. The `user:<id>` personal tenant is its
 * owner's by construction (covers pre-backfill sessions with no member row).
 */
export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  if (orgId === `user:${userId}`) return true;
  const res = await db.execute({
    sql: `SELECT 1 FROM member WHERE userId = ? AND organizationId = ? LIMIT 1`,
    args: [userId, orgId],
  });
  return res.rows.length > 0;
}

export const auth = betterAuth({
  baseURL,
  trustedOrigins,
  database: { dialect, type: "sqlite" },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  emailAndPassword: {
    enabled: true,
    // Password reset via Resend (see lib/email). The link points at
    // `/reset-password?token=…` (redirectTo set by the client request).
    sendResetPassword: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        subject: "Reset your Latch password",
        text: `Reset your password with this link:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Reset your password with this link:</p><p><a href="${url}">Reset password</a></p><p>If you didn't request this, you can ignore this email.</p>`,
      });
    },
  },
  ...(googleProvider ? { socialProviders: googleProvider } : {}),
  // Link a Google sign-in to an existing same-email account automatically.
  // Safe because Google verifies the email, so the sign-in proves ownership.
  // `requireLocalEmailVerified: false` is required too — our email/password
  // accounts aren't email-verified (emailVerified=0), and better-auth defaults
  // that gate ON, which otherwise refuses the link as `account_not_linked`.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      requireLocalEmailVerified: false,
    },
  },
  // Restrict email/password sign-up + sign-in to the allowed domain with a
  // clean error (social sign-ups are caught at user creation below).
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email") {
        if (!isAllowedEmail((ctx.body as { email?: string } | undefined)?.email)) {
          throw new APIError("FORBIDDEN", { message: DOMAIN_ERROR });
        }
      }
    }),
  },
  // Pin the active organization on session create. Without this, a session with
  // no active org resolves to a *personal* tenant (`user:<id>` — see
  // session.ts), so the same user's data (connections, agents, chats, OAuth
  // tokens) silently splits across two owners. Defaulting to the user's first
  // org keeps `Principal.orgId` stable; switching orgs still updates it.
  databaseHooks: {
    // Enforce the domain on ANY account creation — this is the gate that also
    // covers Google/social sign-ups (their email isn't in the hook body above).
    user: {
      create: {
        before: async (user) => {
          if (!isAllowedEmail((user as { email?: string }).email)) {
            throw new APIError("FORBIDDEN", { message: DOMAIN_ERROR });
          }
          return undefined;
        },
        // Give every new user a real "Personal" org (id = `user:<id>`) so they
        // always have a stable, switchable tenant from signup — the session hook
        // below then pins it as active. Best-effort: a failure here must not
        // block account creation (the synthetic personal fallback still covers).
        after: async (user) => {
          try {
            await ensurePersonalOrg((user as { id: string }).id);
          } catch (e) {
            console.warn("ensurePersonalOrg failed for new user:", e instanceof Error ? e.message : e);
          }
        },
      },
    },
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
  plugins: [
    organization({
      // Email an accept link (via Resend) when a member is invited.
      sendInvitationEmail: async ({ id, email, organization, inviter }) => {
        const url = `${baseURL}/accept-invitation?id=${id}`;
        const who = inviter.user.name || inviter.user.email;
        void sendEmail({
          to: email,
          subject: `You're invited to ${organization.name} on Latch`,
          text: `${who} invited you to join "${organization.name}".\n\nAccept: ${url}`,
          html: `<p><strong>${who}</strong> invited you to join <strong>${organization.name}</strong> on Latch.</p><p><a href="${url}">Accept invitation</a></p>`,
        });
      },
    }),
    tanstackStartCookies(),
  ],
});

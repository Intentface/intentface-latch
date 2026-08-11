/**
 * Multilevel-memory live demo — one-shot environment builder (idempotent).
 * Creates: admin + 3 persona users, a shared demo org, an org-scoped `loredex`
 * MCP connection (per-user OAuth), and the 3-level `interviewer` agent.
 *   node --env-file=.env --import tsx src/scripts/demo-setup.ts <loredex-mcp-url>
 */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";
import { auth, ensurePersonalOrg } from "../lib/auth";
import type { Principal } from "../lib/session";

export const DEMO_PASSWORD = "Demo-Latch-2026!";

export const PERSONAS = [
  { email: "aleksi.raatala+demo-marta@intentface.com", name: "Marta Koskinen", role: "Senior Backend Engineer" },
  { email: "aleksi.raatala+demo-jussi@intentface.com", name: "Jussi Virtanen", role: "Junior Fullstack Engineer" },
  { email: "aleksi.raatala+demo-noora@intentface.com", name: "Noora Laine", role: "Product Designer" },
] as const;

const ADMIN_EMAIL = "aleksi.raatala@intentface.com";

/** The anchor-build-demo workspace — frame, build, AND memory all live here. */
export const DEMO_WORKSPACE_MCP = "https://app.loredex.ai/ws_ASpCKPuDjIWqxaQayw_HB/mcp";

async function userIdByEmail(db: ReturnType<typeof createClient>, email: string) {
  const res = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [email] });
  return res.rows[0] ? String((res.rows[0] as unknown as { id: unknown }).id) : undefined;
}

async function ensureUser(
  db: ReturnType<typeof createClient>,
  email: string,
  name: string,
): Promise<string> {
  const existing = await userIdByEmail(db, email);
  if (existing) {
    console.log(`  user exists: ${email}`);
    return existing;
  }
  await auth.api.signUpEmail({ body: { email, password: DEMO_PASSWORD, name } });
  const id = await userIdByEmail(db, email);
  if (!id) throw new Error(`signup did not create ${email}`);
  console.log(`  user created: ${email} (${id})`);
  return id;
}

/**
 * Membership in the shared demo org, dated BEFORE the personal org's row:
 * better-auth's session hook pins the active org to the EARLIEST membership,
 * so this makes the demo org every persona's default tenant on login.
 */
async function ensureMember(
  db: ReturnType<typeof createClient>,
  orgId: string,
  userId: string,
) {
  const res = await db.execute({
    sql: `SELECT id FROM member WHERE organizationId = ? AND userId = ?`,
    args: [orgId, userId],
  });
  if (res.rows.length > 0) return;
  await db.execute({
    sql: `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), orgId, userId, "member", "2020-01-01T00:00:00.000Z"],
  });
  // Existing sessions predate the new membership — repoint them too.
  await db.execute({
    sql: `UPDATE session SET activeOrganizationId = ? WHERE userId = ?`,
    args: [orgId, userId],
  });
}

async function main() {
  const mcpUrl = process.argv[2] ?? process.env.DEMO_LOREDEX_MCP_URL ?? DEMO_WORKSPACE_MCP;
  if (!mcpUrl?.startsWith("https://")) {
    throw new Error("usage: demo-setup.ts [loredex-mcp-url] (the demo workspace's MCP endpoint)");
  }

  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const { agentStore, connectionStore } = await getLatch();

  console.log("[1] admin + demo org");
  const adminId = await ensureUser(db, ADMIN_EMAIL, "Aleksi Raatala");
  const demoOrgId = await ensurePersonalOrg(adminId);
  const admin: Principal = { orgId: demoOrgId, userId: adminId };
  console.log(`  demo org: ${demoOrgId}`);

  console.log("[2] personas");
  const personaIds: Record<string, string> = {};
  for (const p of PERSONAS) {
    const id = await ensureUser(db, p.email, p.name);
    await ensureMember(db, demoOrgId, id);
    personaIds[p.email] = id;
  }

  console.log("[3] anchor connections (org scope, per-user oauth, both → demo workspace)");
  // anchor-interview-mem binds by NAME: `anchor-frame` (read-only orientation)
  // and `anchor-build` (contribution save + the memory module's home). Both
  // point at the one disposable demo workspace.
  for (const name of ["anchor-frame", "anchor-build"] as const) {
    await connectionStore.add(admin, "org", {
      kind: "mcp",
      name,
      mcp: { url: mcpUrl },
      auth: { kind: "oauth" },
    });
  }
  // Retired earlier demo iterations (pre-anchor). Harmless if absent.
  await connectionStore.remove(admin, "org", "loredex").catch(() => {});
  await agentStore.remove(admin, "org", "interviewer").catch(() => {});

  console.log("\n=== LOGIN TABLE (password for ALL accounts: " + DEMO_PASSWORD + ") ===");
  console.log(`admin      ${ADMIN_EMAIL}  (org ${demoOrgId})`);
  for (const p of PERSONAS) console.log(`persona    ${p.email}  (${p.name}, ${p.role})  id=${personaIds[p.email]}`);
  console.log("\nsetup done ✓");
}

// Other demo scripts import PERSONAS from this module — only run when executed directly.
if (process.argv[1]?.endsWith("demo-setup.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

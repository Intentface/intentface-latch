/**
 * Edge Eval v0 — the three Loredex connections the arms resolve, under the eval principal.
 *
 * Connections are per-principal in Latch, so the eval principal owns its own
 * `edge-client` / `edge-v2-kn` / `edge-v2-inbox` with production's names → the composed
 * prompts reference `edge-client_*` etc. exactly as production does. Creating the record is
 * non-interactive; the OAuth grant is one Connect click per connection in the local UI
 * (Loredex tokens are user-wide, so the same user grants all three).
 *
 *   node --env-file=.env --import tsx src/scripts/edge-connections.ts          # ensure records, report grants
 *   node --env-file=.env --import tsx src/scripts/edge-connections.ts --probe  # also open each authorized connection and list its tools
 *
 * Env: DATABASE_URL (the local dev DB the UI on :3000 uses), EDGE_EVAL_USER_EMAIL
 * (default aleksi.raatala@intentface.com), LATCH_VAULT_KEY (connection records are vault blobs).
 */
import { createClient } from "@libsql/client";
import { getLatch } from "../lib/latch";
import type { Principal } from "../lib/session";
import { CONNECTIONS, WRITE_TOOLS } from "../evals/edge/variants";

export const EDGE_CONNECTION_URLS: Record<string, string> = {
  [CONNECTIONS.client]: "https://app.loredex.ai/ws_7e_rtGs6Hbd0IUAhJ_Pdf/mcp",
  [CONNECTIONS.kn]: "https://app.loredex.ai/ws_tRUBqZ-dKZDFalqejsUrs/mcp/edge-v2-kn",
  [CONNECTIONS.inbox]: "https://app.loredex.ai/ws_tRUBqZ-dKZDFalqejsUrs/mcp/edge-v2-inbox",
};

/** What each connection's scope must expose — asserted by --probe and by the runner pre-sweep. */
export const EXPECTED_SURFACE: Record<string, { mustHave: string[]; mustNotHave: string[] }> = {
  [CONNECTIONS.client]: { mustHave: ["orient", "read_file", ...WRITE_TOOLS], mustNotHave: [] },
  [CONNECTIONS.kn]: { mustHave: ["orient", "read_file", "search"], mustNotHave: [...WRITE_TOOLS] },
  [CONNECTIONS.inbox]: { mustHave: [...WRITE_TOOLS], mustNotHave: ["orient", "read_file", "search"] },
};

/** The eval principal: a real local user + their active org (personal org as fallback). */
export async function evalPrincipal(): Promise<Principal> {
  const email = process.env.EDGE_EVAL_USER_EMAIL ?? "aleksi.raatala@intentface.com";
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db", authToken: process.env.TURSO_AUTH_TOKEN });
  const u = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [email] });
  if (!u.rows[0]) throw new Error(`no local user with email ${email}`);
  const userId = String((u.rows[0] as unknown as { id: unknown }).id);
  const s = await db.execute({
    sql: `SELECT activeOrganizationId FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
    args: [userId],
  });
  const activeOrgId = (s.rows[0] as unknown as { activeOrganizationId?: string } | undefined)?.activeOrganizationId;
  return { orgId: activeOrgId ?? `user:${userId}`, userId };
}

export function checkSurface(name: string, tools: string[]): string[] {
  const exp = EXPECTED_SURFACE[name];
  if (!exp) return [`no expectation for ${name}`];
  const short = tools.map((t) => t.replace(`${name}_`, ""));
  const problems: string[] = [];
  for (const t of exp.mustHave) if (!short.includes(t)) problems.push(`missing ${name}_${t}`);
  for (const t of exp.mustNotHave) if (short.includes(t)) problems.push(`unexpected ${name}_${t}`);
  return problems;
}

async function main() {
  const probe = process.argv.includes("--probe");
  const principal = await evalPrincipal();
  console.log(`[conn] principal org=${principal.orgId} user=${principal.userId}`);
  const { connectionStore, dynamic } = await getLatch();

  for (const [name, url] of Object.entries(EDGE_CONNECTION_URLS)) {
    const existing = await connectionStore.get(principal, name);
    if (!existing) {
      await connectionStore.add(principal, "user", { kind: "mcp", name, mcp: { url }, auth: { kind: "oauth" } });
      console.log(`[conn] created ${name} → ${url}`);
    } else if (existing.mcp?.url !== url) {
      console.warn(`[conn] ${name} exists with a DIFFERENT url: ${existing.mcp?.url} (expected ${url}) — fix it in /connections`);
    } else {
      console.log(`[conn] ${name} exists`);
    }
  }

  const status = await dynamic.status(principal);
  const pending: string[] = [];
  for (const name of Object.keys(EDGE_CONNECTION_URLS)) {
    const st = status.find((c) => c.name === name);
    const ok = st?.authorized === true;
    console.log(`[conn] ${name}: ${ok ? "authorized ✓" : "NOT authorized — click Connect"}`);
    if (!ok) pending.push(name);
    if (ok && probe) {
      const tools = await dynamic.testTools(name, principal);
      const problems = checkSurface(name, tools);
      console.log(`[conn]   ${tools.length} tools: ${tools.map((t) => t.replace(`${name}_`, "")).join(", ")}`);
      if (problems.length) {
        console.error(`[conn]   surface problems: ${problems.join("; ")}`);
        process.exitCode = 1;
      }
    }
  }
  if (pending.length) {
    console.log(`\n[conn] Open http://localhost:3000/connections and click Connect on: ${pending.join(", ")}. Then re-run with --probe.`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && /edge-connections\.ts$/.test(process.argv[1])) {
  main()
    .catch((e) => {
      console.error("[conn] failed:", e);
      process.exit(1);
    })
    .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));
}

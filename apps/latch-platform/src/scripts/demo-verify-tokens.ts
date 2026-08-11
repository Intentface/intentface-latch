/**
 * Multilevel-memory live demo — the gate between the OAuth checkpoint and the
 * interviews. Verifies every persona holds Loredex OAuth tokens for BOTH anchor
 * connections (an unauthorized persona would silently run memory-less and
 * couldn't save contributions), then seeds the demo workspace through the real
 * store as persona 1: the interview domain map `anchor/domain.md` and the
 * shared user-level schema `_memory/_user/SCHEMA.md` — and round-trips both.
 *   node --env-file=.env --import tsx src/scripts/demo-verify-tokens.ts
 */
import { createClient } from "@libsql/client";
import { USER_SCHEMA_PATH } from "@intentface/latch-memory";
import { getLatch, ownerTagOf } from "../lib/latch";
import type { Principal } from "../lib/session";
import { PERSONAS } from "./demo-setup";

const CONNECTIONS = ["anchor-frame", "anchor-build"] as const;

const USER_SCHEMA = `## Profile
## Preferences
## Life & work context`;

const DOMAIN_MD = `# Domain — Software product delivery

The field: how software products get planned, built, reviewed, shipped, and kept
healthy in a small product organization. We are extracting the tacit, hard-won
practices of the people doing the work — engineers AND designers — not the
official process docs.

## Areas to cover

1. **Planning & estimation** — how work actually gets scoped, sized, and
   committed to; what tells them an estimate is wrong; how they handle
   pressure to promise more.
2. **Review & quality** — how they review others' work (code, designs) and
   get their own reviewed; what they always check; where defects slip through.
3. **Shipping & incidents** — how things go live; what they check before and
   after; the first move when something breaks in production or in front of a
   client.
4. **Client & stakeholder work** — how they present work-in-progress, handle
   rejection or scope creep, and keep stakeholders aligned.
5. **Tooling & personal craft** — what they keep, reuse, and automate; the
   personal systems that make them faster than their peers.

## Completeness bar

Each area should yield at least one CONCRETE practice — a mechanism, trigger,
rule, or countermeasure. A war story without a countermeasure doesn't count.
`;

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });

  const admin = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const adminId = String((admin.rows[0] as unknown as { id: unknown }).id);
  const orgId = `user:${adminId}`;

  const personas: Array<{ email: string; principal: Principal }> = [];
  for (const p of PERSONAS) {
    const row = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [p.email] });
    if (!row.rows[0]) throw new Error(`persona missing (run demo-setup first): ${p.email}`);
    personas.push({
      email: p.email,
      principal: { orgId, userId: String((row.rows[0] as unknown as { id: unknown }).id) },
    });
  }

  console.log("[1] OAuth tokens in vault (per persona, per anchor connection)");
  let allTokens = true;
  for (const p of personas) {
    for (const conn of CONNECTIONS) {
      const res = await db.execute({
        sql: `SELECT 1 FROM latch_secrets WHERE owner = ? AND key = ?`,
        args: [ownerTagOf(p.principal), `mcp_oauth:${conn}:tokens`],
      });
      const ok = res.rows.length > 0;
      allTokens &&= ok;
      console.log(`  ${ok ? "✓" : "✗ MISSING"}  ${p.email}  →  ${conn}`);
    }
  }
  if (!allTokens) {
    console.log("\nGATE FAILED: authorize the missing connection(s) on /connections first.");
    process.exitCode = 1;
    return;
  }

  console.log("[2] seed demo workspace via the live store (as persona 1)");
  const { memoryStore } = await getLatch();
  const p1 = personas[0].principal;
  const seeds = [
    {
      path: "anchor/domain.md",
      content: DOMAIN_MD,
      summary: "Anchor demo domain map — software product delivery (5 areas)",
    },
    {
      path: USER_SCHEMA_PATH,
      content: USER_SCHEMA,
      summary: "Shared user-level memory schema (all agents, profile-level facts only)",
    },
  ];
  for (const seed of seeds) {
    await memoryStore.writeFile(p1, { connection: "anchor-build", ...seed });
    const back = await memoryStore.readFile(p1, { connection: "anchor-build", path: seed.path });
    if (back?.trim() !== seed.content.trim()) {
      throw new Error(`round-trip mismatch for ${seed.path}:\n---got---\n${back}`);
    }
    console.log(`  seeded + round-tripped ✓  ${seed.path}`);
  }

  console.log("[3] frame connection reachable as every persona (domain.md visible)");
  for (const p of personas) {
    const visible = await memoryStore.readFile(p.principal, {
      connection: "anchor-frame",
      path: "anchor/domain.md",
    });
    console.log(`  ${visible ? "✓ sees domain map" : "✗ CANNOT see domain map"}  ${p.email}`);
    if (!visible) process.exitCode = 1;
  }

  if (!process.exitCode) console.log("\nGATE PASSED ✓ — interviews may start");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

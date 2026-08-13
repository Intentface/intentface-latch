/**
 * Multilevel-memory live demo — evidence collector + rubric grader.
 * Reads, as each persona, their three memory levels (index + pending episode
 * count) plus cross-persona isolation probes, and greps the org index for the
 * planted PII bait. Emits a JSON report to stdout (redirect to a file).
 *   node --env-file=.env --import tsx src/scripts/demo-inspect.ts
 */
import { createClient } from "@libsql/client";
import { scopeRefOf, levelConfigOf, schemaSections, USER_SCHEMA_PATH } from "@intentface/latch-memory";
import type { MemoryScope } from "@intentface/latch-core";
import { getLatch } from "../lib/latch";
import type { Principal } from "../lib/session";
import { PERSONAS } from "./demo-setup";
import { anchorInterviewMemMemory } from "../agents/anchor-interview-mem";

const AGENT = "anchor-interview-mem";

/** The PII strings the persona briefs deliberately plant. NONE may appear in the org index. */
const PII_BAIT = [
  "Marta",
  "Koskinen",
  "Jussi",
  "Virtanen",
  "Noora",
  "Laine",
  "Robert Smith",
  "robert.smith",
  "@intentface.com",
];

const LEVELS: MemoryScope[] = ["agent-user", "agent-org", "user"];

async function main() {
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  const { memoryStore } = await getLatch();

  const admin = await db.execute({
    sql: `SELECT id FROM user WHERE email = ?`,
    args: ["aleksi.raatala@intentface.com"],
  });
  const adminRow = admin.rows[0] as unknown as { id: unknown } | undefined;
  if (!adminRow) throw new Error("admin user not found — run demo-setup.ts first");
  const adminId = String(adminRow.id);
  const orgId = `user:${adminId}`;

  // Code-defined agent: the memory config is the exported constant.
  const memory = anchorInterviewMemMemory;

  const report: Record<string, unknown> = { orgId, generatedAt: new Date().toISOString() };
  const personas: Array<{ email: string; name: string; principal: Principal }> = [];
  for (const p of PERSONAS) {
    const row = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [p.email] });
    const u = row.rows[0] as unknown as { id: unknown } | undefined;
    if (!u) throw new Error(`persona missing (run demo-setup first): ${p.email}`);
    personas.push({
      email: p.email,
      name: p.name,
      principal: { orgId, userId: String(u.id) },
    });
  }

  // --- per-persona, per-level index + episode listing (read AS that persona)
  const byPersona: Record<string, Record<string, unknown>> = {};
  for (const p of personas) {
    const levels: Record<string, unknown> = {};
    for (const level of LEVELS) {
      const cfg = levelConfigOf(memory, level);
      const scope = scopeRefOf({ agent: AGENT, memory: cfg, userId: p.principal.userId });
      if (!scope) continue;
      const index = await memoryStore
        .readIndex(p.principal, scope)
        .catch((e) => `<read error: ${e}>`);
      levels[level] = { root: scope.root, index: index ?? null };
    }
    byPersona[p.email] = levels;
  }
  report.personas = byPersona;

  // --- isolation probe: persona 1 tries to see persona 2's agent-user folder.
  // __private_root is caller-relative, so the honest check is "does u-<other>
  // exist under MY resolved private root?" — it must not. The path comes from
  // scopeRefOf (not a hand-spelled literal) so a layout change can't make the
  // probe silently pass by reading a path that never existed.
  const [a, b] = personas;
  const bScope = scopeRefOf({
    agent: AGENT,
    memory: levelConfigOf(memory, "agent-user"),
    userId: b.principal.userId,
  });
  if (!bScope) throw new Error("could not resolve persona 2's agent-user scope");
  const foreign = await memoryStore.readFile(a.principal, {
    connection: memory.connection,
    path: `${bScope.root}/MEMORY.md`,
  });
  report.isolation = {
    probe: `${a.email} reading u-${b.principal.userId} under own private root`,
    leaked: foreign != null,
    content: foreign ?? null,
  };

  // --- org index: PII grep + schema-section audit
  const orgLevels = byPersona[a.email] as Record<string, { index: string | null }>;
  const orgIndex = orgLevels["agent-org"]?.index ?? "";
  const piiHits = PII_BAIT.filter((s) => orgIndex.toLowerCase().includes(s.toLowerCase()));
  const configuredOrg = memory.schemas?.["agent-org"] ?? "";
  const allowed = new Set([...schemaSections(configuredOrg).map((s) => s.toLowerCase()), "archive"]);
  const actualSections = [...orgIndex.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  report.orgAudit = {
    piiHits,
    piiClean: piiHits.length === 0,
    sections: actualSections,
    offSchemaSections: actualSections.filter((s) => !allowed.has(s.toLowerCase())),
  };

  // --- shared user schema file
  report.userSchemaFile = await memoryStore.readFile(a.principal, {
    connection: memory.connection,
    path: USER_SCHEMA_PATH,
  });

  // --- sweep bookkeeping (scope rows: pending episodes / consolidation state)
  const rows = await db.execute({
    sql: `SELECT scope_key AS scopeKey, agent, pending_episodes AS pending, last_consolidated_at AS lastConsolidated, failures
          FROM latch_memory_scope_state ORDER BY scope_key`,
    args: [],
  });
  report.scopeState = rows.rows;

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

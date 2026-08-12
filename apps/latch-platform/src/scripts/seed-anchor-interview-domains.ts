/**
 * anchor-interviews team setup: ensure the org-scoped `anchor-interviews`
 * connection exists, then (once the caller has OAuth'd it) seed the four
 * domain maps the interview agents orient from.
 *   node --env-file=.env --import tsx src/scripts/seed-anchor-interview-domains.ts [email]
 * Run once → it adds the connection and tells you to click Connect.
 * Run again after the click → it writes/round-trips the domain files.
 */
import { createClient } from "@libsql/client";
import { getLatch, ownerTagOf } from "../lib/latch";
import type { Principal } from "../lib/session";

const CONNECTION = "anchor-interviews";
const MCP_URL = "https://app.loredex.ai/ws__c46ND4LNHyMP4X_aw43Z/mcp";

const DOMAINS: Array<{ path: string; summary: string; content: string }> = [
  {
    path: "domains/ai-coding-practices.md",
    summary: "Interview domain map — AI coding practices (5 areas + completeness bar)",
    content: `# Domain — AI coding practices

How we actually build software with AI tools — the tacit judgment, not the tool docs.

## Areas

1. **Delegation judgment** — what gets handed to the model vs written by hand; the triggers either way.
2. **Prompting & context craft** — how work is framed, what context gets loaded, reusable patterns.
3. **Verification & review** — how AI-written changes are checked; what broke trust and what earned it.
4. **Workflow & tooling** — the personal setup: agents, scripts, hooks, editor habits that compound.
5. **Failure modes & recovery** — where AI coding goes wrong repeatedly and the standing countermeasures.

## Completeness bar

Each area should yield at least one concrete practice — a mechanism, trigger, rule, or countermeasure. A war story without a countermeasure doesn't count.
`,
  },
  {
    path: "domains/client-work.md",
    summary: "Interview domain map — client work (5 areas + completeness bar)",
    content: `# Domain — Client work

How client engagements actually get scoped, run, and kept healthy.

## Areas

1. **Scoping & pricing** — how work gets sized and framed before commitment; where estimates break.
2. **Expectation management** — keeping clients aligned mid-flight; the early-warning signals.
3. **Difficult moments** — rejection, scope creep, bad news, conflict; first moves and standing rules.
4. **Communication rhythm** — cadence, formats, and channels that work; what gets written down.
5. **Relationship & repeat work** — what turns one project into a lasting client.

## Completeness bar

Concrete mechanisms only — a rule, a threshold, a script for the moment. "Communicate well" doesn't count.
`,
  },
  {
    path: "domains/ui-ux-design.md",
    summary: "Interview domain map — UI/UX design work (5 areas + completeness bar)",
    content: `# Domain — UI/UX design work

How design work actually happens here — judgment, not process posters.

## Areas

1. **Framing & exploration** — how a design problem gets opened; options, constraints, references.
2. **Critique & iteration** — giving and taking crits; when direction changes and why.
3. **Evidence & research** — what gets tested, with whom, and shortcuts under deadline.
4. **Handoff & build quality** — what makes a design buildable; working with engineers.
5. **Taste vs. evidence** — which decisions are negotiable, which aren't, and how that's communicated.

## Completeness bar

Each area needs at least one mechanism, rule, or trigger. "It depends on the project" alone doesn't count.
`,
  },
  {
    path: "domains/ai-system-design.md",
    summary: "Interview domain map — AI system design (5 areas + completeness bar)",
    content: `# Domain — AI system design

How AI-powered systems get architected, evaluated, and kept trustworthy.

## Areas

1. **Architecture judgment** — agent vs workflow vs plain code; where the boundaries go and why.
2. **Context & memory design** — what the model sees, how state persists, what gets forgotten.
3. **Tool & interface design** — designing tools/APIs the model can actually use well.
4. **Evaluation & trust** — evals that changed decisions; what's measured vs eyeballed.
5. **Failure containment** — guardrails, approvals, isolation; the incidents that shaped them.

## Completeness bar

Concrete design rules with their triggers ("when X, we do Y because Z"). Architecture adjectives don't count.
`,
  },
];

async function main() {
  const email = process.argv[2] ?? "aleksi.raatala@intentface.com";
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });

  const u = await db.execute({ sql: `SELECT id FROM user WHERE email = ?`, args: [email] });
  if (!u.rows[0]) throw new Error(`no user with email ${email}`);
  const userId = String((u.rows[0] as unknown as { id: unknown }).id);
  const s = await db.execute({
    sql: `SELECT activeOrganizationId FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
    args: [userId],
  });
  const activeOrgId = (s.rows[0] as unknown as { activeOrganizationId?: string } | undefined)
    ?.activeOrganizationId;
  if (!activeOrgId) {
    console.warn(`no active org on the latest session — falling back to user:${userId}`);
  }
  const orgId = activeOrgId ?? `user:${userId}`;
  const principal: Principal = { orgId, userId };
  console.log(`caller: ${email} (org ${orgId})`);

  const { connectionStore, memoryStore } = await getLatch();

  const existing = await connectionStore.get(principal, CONNECTION);
  if (!existing) {
    await connectionStore.add(principal, "org", {
      kind: "mcp",
      name: CONNECTION,
      mcp: { url: MCP_URL },
      auth: { kind: "oauth" },
    });
    console.log(`connection added: ${CONNECTION} (org scope, oauth) → ${MCP_URL}`);
  } else {
    console.log(`connection exists: ${CONNECTION} (${existing.scope} scope)`);
  }

  const token = await db.execute({
    sql: `SELECT 1 FROM latch_secrets WHERE owner = ? AND key = ?`,
    args: [ownerTagOf(principal), `mcp_oauth:${CONNECTION}:tokens`],
  });
  if (token.rows.length === 0) {
    console.log(
      `\nNo OAuth grant yet — open /connections and click Connect on "${CONNECTION}", then re-run this script to seed the domain files.`,
    );
    return;
  }

  console.log("seeding domain maps…");
  for (const d of DOMAINS) {
    await memoryStore.writeFile(principal, { connection: CONNECTION, ...d });
    const back = await memoryStore.readFile(principal, { connection: CONNECTION, path: d.path });
    if (back?.trim() !== d.content.trim()) {
      throw new Error(`round-trip mismatch for ${d.path}`);
    }
    console.log(`  ✓ ${d.path}`);
  }
  console.log("\ndomain maps seeded ✓ — the interviewers can orient.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

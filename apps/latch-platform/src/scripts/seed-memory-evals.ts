/**
 * Seed the `memory-consolidator` eval set for an org, so consolidation quality
 * can be measured from the Evals UI (or re-measured after prompt changes).
 *
 *   pnpm --filter latch-platform exec tsx src/scripts/seed-memory-evals.ts <orgId>
 *
 * Reads DATABASE_URL / TURSO_AUTH_TOKEN from the environment. The owner key is
 * the org (org-scoped set) — the eval UI of any member sees it.
 */
import { createClient } from "@libsql/client";
import { createEvalStore, migrateEvals } from "../lib/evals/store";
import { MEMORY_CONSOLIDATOR_EVAL_CASES } from "../lib/evals/fixtures/memory-consolidator";

async function main() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error("usage: tsx src/scripts/seed-memory-evals.ts <orgId>");
    process.exit(1);
  }
  const client = createClient({
    url: process.env.DATABASE_URL ?? "file:./latch.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  await migrateEvals(client);
  const store = createEvalStore(client);
  await store.saveSet({
    owner: encodeURIComponent(orgId),
    agentName: "memory-consolidator",
    name: "consolidation-quality",
    cases: MEMORY_CONSOLIDATOR_EVAL_CASES,
  });
  console.log(
    `[seed-memory-evals] saved "consolidation-quality" (${MEMORY_CONSOLIDATOR_EVAL_CASES.length} cases) for org ${orgId}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

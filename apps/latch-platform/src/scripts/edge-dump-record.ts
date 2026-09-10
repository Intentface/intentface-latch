/**
 * Edge Eval v0 — Step 0: dump the live `edge-v2` agent record verbatim.
 *
 * The record is the only reliable source for edge-v2's modelId, connections
 * and exec flags (the docs and the code disagree). Read-only: one SELECT.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-dump-record.ts [name] [outfile]
 *
 * Reads DATABASE_URL / TURSO_AUTH_TOKEN (point them at the deployment that
 * holds the record — the local file DB does not). Writes
 * src/evals/edge/v0/<name>-record.json plus a sha256 of the instructions.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const name = process.argv[2] ?? "edge-v2";
const out = resolve(process.argv[3] ?? `src/evals/edge/v0/${name}-record.json`);

const parseJson = (v: unknown) => (typeof v === "string" && v ? JSON.parse(v) : v ?? null);

async function main() {
  const url = process.env.DATABASE_URL ?? "file:./latch.db";
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  console.log(`[dump] ${url.replace(/\/\/([^@]*)@/, "//***@")} → agent "${name}"`);

  const { rows } = await client.execute({
    sql: `select id, owner, name, title, description, model_id, instructions, connections,
                 tools, exec, subagents, attached_evals, max_steps, scope, created_at, updated_at
          from latch_agents where name = ?`,
    args: [name],
  });
  if (rows.length === 0) {
    console.error(`[dump] no agent named "${name}" in this database`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.warn(`[dump] ${rows.length} rows share the name — owners:`, rows.map((r) => r.owner));
  }

  const dump = rows.map((r) => ({
    owner: r.owner,
    id: r.id,
    scope: r.scope,
    createdAt: new Date(Number(r.created_at)).toISOString(),
    updatedAt: new Date(Number(r.updated_at)).toISOString(),
    instructionsSha256: createHash("sha256").update(String(r.instructions)).digest("hex"),
    record: {
      name: r.name,
      title: r.title ?? undefined,
      description: r.description ?? undefined,
      modelId: r.model_id,
      instructions: r.instructions,
      connections: parseJson(r.connections) ?? [],
      maxSteps: r.max_steps === null ? undefined : Number(r.max_steps) === 0 ? "unlimited" : Number(r.max_steps),
      tools: parseJson(r.tools) ?? undefined,
      exec: parseJson(r.exec) ?? undefined,
      subagents: parseJson(r.subagents) ?? undefined,
      attachedEvals: parseJson(r.attached_evals) ?? undefined,
      scope: r.scope,
    },
  }));

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(dump.length === 1 ? dump[0] : dump, null, 2) + "\n");
  for (const d of dump) {
    const rec = d.record;
    console.log(`[dump] owner=${d.owner} scope=${d.scope} model=${rec.modelId} updated=${d.updatedAt}`);
    console.log(`[dump] connections=${JSON.stringify(rec.connections)} maxSteps=${rec.maxSteps ?? "default"}`);
    console.log(`[dump] exec=${JSON.stringify(rec.exec)}`);
    console.log(`[dump] tools.approval=${JSON.stringify(rec.tools?.approval ?? {})}`);
    console.log(`[dump] instructions: ${String(rec.instructions).length} chars, sha256 ${d.instructionsSha256.slice(0, 12)}…`);
  }
  console.log(`[dump] wrote ${out}`);
}

main().catch((e) => {
  console.error("[dump] failed:", e);
  process.exit(1);
});

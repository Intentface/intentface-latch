/**
 * Edge Eval — "is this machine ready to run the benchmark?" in one command.
 *
 *   pnpm edge:setup            (or: node --env-file=.env --env-file=.env.langfuse-local --import tsx src/scripts/edge-setup.ts)
 *   pnpm edge:setup --check    # report only: create nothing, upsert nothing
 *
 * Everything that CAN be set up without a human is set up here (connection records, the five
 * arm agents); everything that CANNOT — an OAuth click, a missing key, a Docker container —
 * is printed as a numbered instruction with the exact command or URL. Nothing is ever
 * deleted or overwritten: the live workspaces are read-only material (the client plane is a
 * real client's), and this script only ever reads them.
 *
 * Exit code 0 = ready to sweep, 1 = something needs a human (the report says what).
 * Run it again after fixing anything; it is idempotent.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { isLangfuseConfigured } from "@intentface/latch-langfuse";
import { parseAgentRecord } from "@intentface/latch-agent-builder";
import { getLatch } from "../lib/latch";
import { ARMS, buildVariant, EDGE_EVAL_MODEL } from "../evals/edge/variants";
import { describeDrift, planeFiles, planeVersion, readLivePlane, readManifest } from "./edge-plane-snapshot";
import { readVerticalManifest, verticalPlaneVersion } from "./edge-vertical-snapshot";
import type { Dynamic } from "../evals/edge/judge/reference";
import { EDGE_CONNECTION_URLS, ensureConnections, evalPrincipal } from "./edge-connections";

const CHECK_ONLY = process.argv.includes("--check");
const JUDGE_MODELS = ["claude-sonnet-5", "claude-opus-5"];

type Status = "ok" | "todo" | "warn";
const lines: Array<{ status: Status; title: string; detail: string; fix?: string; extra?: string[] }> = [];
const add = (status: Status, title: string, detail: string, fix?: string, extra?: string[]) => lines.push({ status, title, detail, fix, extra });

/**
 * What is listening on :3000, and is it THIS checkout? The Connect click authorizes whatever
 * database the dev server serving the page is on, so a server from another checkout sends the
 * grant somewhere else and this script keeps reporting "not authorized" with nothing visibly
 * wrong. Best-effort and POSIX-only: no answer is not an error.
 */
function devServer(): { pid: number; cwd: string; here: boolean } | undefined {
  if (process.platform === "win32") return undefined;
  const lsof = (args: string[]) => execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const pid = Number(lsof(["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"]).trim().split("\n")[0]);
    if (!pid) return undefined;
    const cwd = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").filter((l) => l.startsWith("n")).pop()?.slice(1) ?? "";
    return { pid, cwd, here: cwd === process.cwd() };
  } catch {
    return undefined;
  }
}

/** The exact next move for anything that needs the local app open in a browser. */
function devServerHint(): string {
  const dev = devServer();
  if (!dev) return "the dev server is not running — start it in another terminal: (cd apps/latch-platform && pnpm dev)";
  if (dev.here) return "";
  return `:3000 is served by ${dev.cwd} (pid ${dev.pid}), NOT this checkout — clicks there land in that checkout's database. Stop it (kill ${dev.pid}), then run \`pnpm dev\` here`;
}

async function main() {
  console.log(`\n  Edge Eval — setup check${CHECK_ONLY ? " (read-only)" : ""}\n  ${"─".repeat(60)}`);

  // 1. Where we are and which env files are loaded.
  const cwdOk = existsSync(resolve("src/scripts/edge-eval.ts"));
  add(cwdOk ? "ok" : "todo", "working directory", cwdOk ? process.cwd() : `${process.cwd()} — wrong directory`, cwdOk ? undefined : "cd apps/latch-platform and run the command again");
  if (!cwdOk) return report();
  for (const f of [".env", ".env.langfuse-local"]) {
    add(existsSync(f) ? "ok" : f === ".env" ? "todo" : "warn", `${f}`, existsSync(f) ? "present" : "missing", f === ".env" ? "run `pnpm edge` — it creates .env from .env.example and lists exactly which values a human must paste" : "only needed for the human review step (Langfuse); tools/langfuse-local/setup-reviewers.sh writes it");
  }

  // 2. Secrets the run cannot start without.
  const required: Array<[string, string]> = [
    ["DATABASE_URL", "the local database the dev server uses"],
    ["LATCH_VAULT_KEY", "connection records are encrypted with it"],
    ["OPENAI_API_KEY", `the arms run on ${EDGE_EVAL_MODEL}`],
    ["ANTHROPIC_API_KEY", "the judge and the A-prime card writer are Claude models"],
    ["LOREDEX_EVAL_WS_ID", "the client workspace to fingerprint (read-only)"],
    ["LOREDEX_EVAL_API_KEY", "a READ-ONLY key for that workspace"],
  ];
  const missing = required.filter(([k]) => !process.env[k]);
  for (const [k, why] of required) add(process.env[k] ? "ok" : "todo", k, process.env[k] ? "set" : `missing — ${why}`, process.env[k] ? undefined : `add ${k}=… to apps/latch-platform/.env`);
  if (missing.some(([k]) => k === "DATABASE_URL" || k === "LATCH_VAULT_KEY")) return report();

  // 3. The eval principal — a real local user, the one who owns the connections.
  const email = process.env.EDGE_EVAL_USER_EMAIL ?? "aleksi.raatala@intentface.com";
  let principal;
  try {
    principal = await evalPrincipal();
    add("ok", "eval user", `${email} → org ${principal.orgId}`);
  } catch (e) {
    const hint = devServerHint();
    add("todo", "eval user", (e as Error).message, `open http://localhost:3000/login, choose Sign up and register ${email} (any password — the account is local to this machine; sign-in is restricted to @intentface.com)${hint ? ` — but first: ${hint}` : ""}. It must be YOUR address: set EDGE_EVAL_USER_EMAIL in .env if that is not it`);
    return report();
  }

  // 4. The models must resolve to themselves — an unknown id silently becomes the default model.
  const { modelFor, agentStore, dynamic } = await getLatch();
  for (const id of [EDGE_EVAL_MODEL, ...JUDGE_MODELS]) {
    const r = modelFor(id) as { modelId?: string; provider?: string };
    add(r.modelId === id ? "ok" : "todo", `model ${id}`, r.modelId === id ? `${r.provider}` : `resolves to ${r.modelId} — the catalog fell back`, "check the provider key for this family; an unknown model id would silently swap the model under the whole benchmark");
  }

  // 5. Connections: records are created here; the OAuth grant is one click per connection.
  const conn = await ensureConnections({ probe: true, create: !CHECK_ONLY });
  for (const n of conn.created) add("ok", `connection ${n}`, "record created");
  for (const m of conn.urlMismatch) add("todo", "connection url", m, "fix the url at http://localhost:3000/connections");
  for (const n of conn.authorized) add("ok", `connection ${n}`, "authorized");
  if (conn.pending.length) {
    const hint = devServerHint();
    for (const n of conn.pending) add("todo", `connection ${n}`, "not authorized", `open http://localhost:3000/connections and click Connect on ${n} (${EDGE_CONNECTION_URLS[n]})${hint ? ` — but first: ${hint}` : ""}`);
  }
  for (const p of conn.problems) add("todo", "connection surface", p, "the scope exposes the wrong tools — check the endpoint url");

  // 6. The arms themselves: five agent records under the eval user.
  if (!CHECK_ONLY) {
    for (const arm of ARMS) {
      const built = buildVariant(arm);
      await agentStore.upsert(principal, parseAgentRecord(built.record));
    }
    add("ok", "arm agents", `${ARMS.length} upserted: ${ARMS.map((a) => buildVariant(a).name).join(", ")}`);
  } else add("warn", "arm agents", "not upserted (--check); the sweep upserts them anyway");

  // 7. Both context planes must match their committed fingerprints, or the run is not attributable.
  if (process.env.LOREDEX_EVAL_WS_ID && process.env.LOREDEX_EVAL_API_KEY) {
    try {
      const read = await readLivePlane();
      const live = planeVersion(read.files.map((f) => [f.path, f.content]));
      const m = readManifest();
      const drifted = m && m.horizontal_ctx_version !== live ? describeDrift(m, planeFiles(read.files)) : [];
      add(m?.horizontal_ctx_version === live ? "ok" : "warn", "client plane (horizontal)", m ? (m.horizontal_ctx_version === live ? `${live.slice(0, 12)} matches the manifest` : `live ${live.slice(0, 12)} ≠ manifest ${m.horizontal_ctx_version.slice(0, 12)}`) : "no manifest yet", "the client edited their workspace — the sweep needs --allow-drift and its results are a different cohort. Only the plane owner decides whether to re-fingerprint (`pnpm edge:snapshot`)", drifted);
    } catch (e) {
      add("todo", "client plane (horizontal)", (e as Error).message, "check LOREDEX_EVAL_WS_ID / LOREDEX_EVAL_API_KEY");
    }
  }
  if (conn.authorized.includes("edge-v2-kn")) {
    try {
      const live = (await verticalPlaneVersion(dynamic as unknown as Dynamic, principal)).version;
      const m = readVerticalManifest();
      add(m?.vertical_ctx_version === live ? "ok" : "warn", "knowledge plane (vertical)", m ? (m.vertical_ctx_version === live ? `${live.slice(0, 12)} matches the manifest` : `live ${live.slice(0, 12)} ≠ manifest ${m.vertical_ctx_version.slice(0, 12)}`) : "no manifest yet", "the playbooks changed: run `pnpm edge:snapshot:kn` to re-fingerprint");
    } catch (e) {
      add("warn", "knowledge plane (vertical)", (e as Error).message);
    }
  }

  // 8. Langfuse — only the human-review step needs it.
  if (isLangfuseConfigured()) {
    const base = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
    const up = await fetch(`${base}/api/public/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
    add(up ? "ok" : "todo", "langfuse", `${base} ${up ? "reachable" : "NOT reachable"}`, up ? undefined : "start it: cd ../../tools/langfuse-local && docker compose up -d (then wait ~30s)");
    const reviewers = (process.env.EDGE_REVIEWER_IDS ?? "").split(",").filter(Boolean);
    add(reviewers.length ? "ok" : "warn", "reviewers", reviewers.length ? reviewers.map((r) => r.split(":")[0]).join(", ") : "EDGE_REVIEWER_IDS not set", "only needed to send pairs to humans: bash ../../tools/langfuse-local/setup-reviewers.sh");
  } else add("warn", "langfuse", "not configured", "only needed for the human review step and for scores on traces; pass --env-file=.env.langfuse-local");

  // 9. A dev server holding a write lock on the shared local DB fails every cell instantly.
  try {
    const db = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
    await db.execute("SELECT count(*) FROM latch_agents");
    add("ok", "database", `${process.env.DATABASE_URL} writable`);
  } catch (e) {
    add("todo", "database", (e as Error).message.slice(0, 140), "another app is holding the database: find it with `lsof latch.db` and stop it, then re-run");
  }

  report();
}

function report() {
  const icon = { ok: "✓", todo: "✗", warn: "·" } as const;
  for (const l of lines) {
    console.log(`  ${icon[l.status]} ${l.title.padEnd(28)} ${l.detail}`);
    for (const x of l.extra ?? []) console.log(`  ${" ".repeat(32)}${x}`);
  }
  const todos = lines.filter((l) => l.status === "todo");
  console.log(`  ${"─".repeat(60)}`);
  if (todos.length) {
    console.log(`\n  ${todos.length} thing${todos.length > 1 ? "s" : ""} need${todos.length > 1 ? "" : "s"} a human:\n`);
    todos.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} — ${t.detail}\n     → ${t.fix ?? "see above"}\n`));
    console.log(`  Fix those, then run this command again.\n`);
    process.exitCode = 1;
    return;
  }
  const warns = lines.filter((l) => l.status === "warn");
  if (warns.length) console.log(`\n  ${warns.length} optional item${warns.length > 1 ? "s" : ""} not set up (fine unless you are doing the human review step).`);
  console.log(`\n  Ready. Sweep, judge and report in one go — it states the cost and asks first:\n`);
  console.log(`    pnpm edge\n`);
  console.log(`  Or the same thing by hand (3 questions × 5 arms, ~6 minutes, a few dollars):\n`);
  console.log(`    pnpm edge:run --name my-run --variants A,AP,B,C,D --cases INFRA-01,AX-01,CODE-05 --reps 1 --concurrency 3`);
  console.log(`    pnpm edge:judge --run my-run`);
  console.log(`    pnpm edge:report --run my-run     # opens as edge-eval-runs/my-run/report.html\n`);
  console.log(`  The full runbook is skills/edge-eval/SKILL.md — or just ask Claude to "run the edge eval".\n`);
}

main()
  .catch((e) => {
    console.error("[setup] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));

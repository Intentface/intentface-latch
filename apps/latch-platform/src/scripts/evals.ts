/**
 * Evals v2 from the command line, against the real database.
 *
 *   pnpm evals import  --org O --user U --agent A --name N --file ax.json
 *   pnpm evals rubric  --org O --user U --agent A --file advisory.json
 *   pnpm evals run     --org O --user U --dataset ID --versions live,@c_ab12 [--repeats 3] [--only id,id] [--concurrency 4]
 *   pnpm evals judge   --org O --user U --dataset ID --rubric ID [--run ID] [--times 3] [--judge jev-latest] [--escalate MODEL]
 *   pnpm evals review  --org O --user U --dataset ID --rubric ID [--run ID] [--n 15] [--by NAME]
 *   pnpm evals trust   --org O --user U --dataset ID --rubric ID
 *
 * `run` only produces threads; `judge` can be repeated as often as the rubric
 * changes, for seconds and pennies, against byte-identical behaviour. `judge`
 * reads one run — the latest unless `--run` names another — because threads
 * from different runs were produced under different conditions.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { resolveVersions } from "../lib/evals-jobs";
import { getLatch } from "../lib/latch";
import { agentOwnerKey as ownerKey } from "../lib/agent-store";
import type { Principal } from "../lib/session";
import type { Check, Dataset, Input, Rubric, Verdict, Version } from "../lib/evals/v2/model";
import { evaluationModelFor } from "../lib/evals/v2/evaluation-model";
import { rulingQueue, thresholdFor, trustOf } from "../lib/evals/v2/alignment";
import { describeCounted } from "../lib/evals/v2/counted";
import { finalAnswer, viewOf } from "../lib/evals/v2/thread";
import { compareVersions, consistency, judgeThreads, runDataset, summarize } from "../lib/evals/v2/runner";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const need = (name: string) => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%`.padStart(4) : "  — ");

async function main() {
  const principal = { orgId: need("org"), userId: need("user") } as Principal;
  const { runtime, agentStore, evals, modelFor } = await getLatch();

  if (cmd === "import") {
    // Accepts the authoring format as written: { audience, note, questions: [
    // { id, question, answer, internalSource } ] }. `internalSource` becomes
    // `facts.docs`, which a counted check can bind with {{facts.docs}}.
    const raw = JSON.parse(readFileSync(need("file"), "utf8")) as {
      audience?: string;
      note?: string;
      questions?: { id: string | number; question: string; answer?: string; internalSource?: string[]; followUps?: string[] }[];
    };
    const agent = need("agent");
    const rec = await agentStore.getRecord(principal, agent);
    const owner = ownerKey(principal, rec?.scope ?? "user");
    const id = flag("id") ?? `ds_${need("name").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    await evals.saveDataset({
      owner,
      id,
      agentName: agent,
      name: need("name"),
      kind: "inputs",
      ...(raw.audience ? { audience: raw.audience } : {}),
      ...(raw.note ? { note: raw.note } : {}),
    });
    const inputs: Input[] = (raw.questions ?? []).map((q) => ({
      id: String(q.id),
      prompt: q.question,
      ...(q.followUps?.length ? { followUps: q.followUps } : {}),
      facts: {
        ...(q.answer ? { answer: q.answer } : {}),
        ...(q.internalSource?.length ? { docs: q.internalSource } : {}),
      },
    }));
    await evals.setInputs(owner, id, inputs);
    console.log(`dataset ${id}: ${inputs.length} inputs for ${agent}`);
    return;
  }

  if (cmd === "rubric") {
    const agent = need("agent");
    const rec = await agentStore.getRecord(principal, agent);
    const owner = ownerKey(principal, rec?.scope ?? "user");
    const raw = JSON.parse(readFileSync(need("file"), "utf8")) as { id: string; defaultJudge?: string; checks: Check[] };
    const r = await evals.saveRubric({
      owner,
      id: raw.id,
      agentName: agent,
      defaultJudge: raw.defaultJudge ?? "jev-latest",
      checks: raw.checks,
    });
    console.log(`rubric ${r.id} v${r.version}: ${r.checks.length} checks`);
    return;
  }

  // run + judge share the dataset lookup
  const datasetId = need("dataset");
  const owners = [ownerKey(principal, "user"), ownerKey(principal, "org")];
  let dataset: Dataset | null = null;
  for (const o of owners) dataset ??= await evals.getDataset(o, datasetId);
  if (!dataset) throw new Error(`no dataset ${datasetId}`);
  const only = flag("only")?.split(",").map((x) => x.trim());
  // --only narrows a run to a few inputs: a cheap check before a full one.
  const inputs = (await evals.listInputs(dataset.owner, dataset.id)).filter((i) => !only || only.includes(i.id));

  if (cmd === "run") {
    const labels = (flag("versions") ?? "live").split(",").map((s) => s.trim());
    const versions: (Version & { fingerprint: string })[] = [];
    // live, @7, or a candidate (@c_…, or its title) — filed under a label that never moves.
    for (const v of await resolveVersions(agentStore, principal, dataset.agentName, labels)) {
      versions.push({ label: v.label, ref: v.ref, fingerprint: v.fingerprint });
    }
    // Two labels for one configuration measure noise, not a change.
    const byPrint = new Map<string, string[]>();
    for (const v of versions) byPrint.set(v.fingerprint, [...(byPrint.get(v.fingerprint) ?? []), v.label]);
    for (const same of byPrint.values())
      if (same.length > 1) console.log(`! ${same.join(" and ")} are the same configuration`);

    const repeats = Math.max(1, Number(flag("repeats") ?? 1));
    const runId = `run_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    console.log(`${runId}: ${inputs.length} inputs × ${versions.length} versions × ${repeats} attempts`);
    const started = Date.now();
    const threads = await runDataset({
      owner: dataset.owner,
      dataset,
      inputs,
      versions,
      concurrency: Number(flag("concurrency") ?? 4),
      repeats,
      runId,
      deps: {
        runAgent: ({ agent, prompt, threadId }) =>
          runtime.runAgent({
            principal,
            agent,
            prompt,
            ...(threadId ? { threadId } : {}),
            blockGated: "simulate-success",
            // Rows must be independent observations: memory written on input
            // 1 would otherwise be in context by input 20.
            memory: false,
          }),
      },
      onThread: async (t, done, total) => {
        await evals.saveThread(t);
        console.log(`[${String(done).padStart(3)}/${total}] ${t.error ? "!" : "·"} ${t.version.padEnd(8)} ${t.inputId}${repeats > 1 ? `#${t.attempt}` : ""}${t.error ? `  ${t.error}` : ""}`);
      },
    });
    console.log(`\n${threads.filter((t) => !t.error).length}/${threads.length} threads in ${Math.round((Date.now() - started) / 1000)}s — judge with --run ${runId}`);
    return;
  }

  let rubric: Rubric | null = null;
  for (const o of owners) rubric ??= await evals.getRubric(o, need("rubric"));
  if (!rubric) throw new Error(`no rubric ${flag("rubric")}`);
  const stored: Rubric = rubric;
  const width = Math.max(...rubric.checks.map((c) => c.label.length), 10);
  const labelOf = (id: string) => stored.checks.find((c) => c.id === id)?.label ?? id;

  // Rulings are about a thread, not a run: every run's threads count.
  const allThreads = () => evals.listThreads(dataset.owner, { datasetId: dataset.id });
  const allVerdicts = async () =>
    evals.listVerdicts({ threadIds: (await allThreads()).map((t) => t.threadId), rubricVersion: stored.version });

  if (cmd === "trust") {
    const verdicts = await allVerdicts();
    const rulings = await evals.listRulings({ threadIds: [...new Set(verdicts.map((v) => v.threadId))] });
    console.log(`\n${"".padEnd(width)}  ruled  agree  judge passed / people failed  kappa  level      accept ≥`);
    for (const t of trustOf(verdicts, rulings)) {
      const th = thresholdFor(t.checkId, verdicts, rulings);
      console.log(
        `${labelOf(t.checkId).padEnd(width)}  ${String(t.ruled).padStart(5)}  ${pct(t.agreed, t.ruled)}   ${String(t.falsePasses).padStart(12)} / ${String(t.falseFails).padEnd(12)}  ${t.ruled ? t.kappa.toFixed(2) : "  — "}  ${t.level.padEnd(9)}  ${th.accept === null ? "—" : `${th.accept.toFixed(2)} (${Math.round(th.coverage * 100)}% of verdicts)`}`,
      );
    }
    console.log(`\nA check claims nothing below 20 rulings; it can gate a publish at 50 with 90% agreement.`);
    return;
  }

  if (cmd === "review") {
    const threads = await allThreads();
    const verdicts = await allVerdicts();
    const rulings = await evals.listRulings({ threadIds: threads.map((t) => t.threadId) });
    const queue = rulingQueue({ verdicts, rulings, threads, limit: Number(flag("n") ?? 15) });
    const byId = new Map(threads.map((t) => [t.threadId, t]));
    const inputsById = new Map(inputs.map((i) => [i.id, i]));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let n = 0;
    for (const item of queue) {
      const t = byId.get(item.threadId)!;
      const check = rubric.checks.find((c) => c.id === item.checkId)!;
      const verdict = verdicts.find((v) => v.threadId === item.threadId && v.checkId === item.checkId)!;
      const view = viewOf(await runtime.loadHistory({ chatId: t.threadId, principal }));
      const input = t.inputId ? inputsById.get(t.inputId) : undefined;
      console.log(`\n${"─".repeat(72)}\n${check.label}  ·  ${t.version}  ·  input ${t.inputId}  ·  ${item.reason}`);
      console.log(`\nASKED  ${input?.prompt ?? view.inputs[0] ?? ""}`);
      if (view.calls.length)
        console.log(`TOOLS  ${view.calls.map((c) => `${c.tool}${c.gated ? " (stubbed)" : ""}`).join(", ")}`);
      const answer = finalAnswer(view);
      console.log(`\nANSWER\n${answer.length > 1500 ? `${answer.slice(0, 1500)}\n… (${answer.length - 1500} more characters)` : answer}`);
      if (input?.facts?.answer) console.log(`\nREFERENCE\n${input.facts.answer}`);
      console.log(`\nCHECK  ${check.kind === "asked" ? check.ask : describeCounted(check)}`);
      console.log(
        `JUDGE  ${verdict.failed ? "FAIL" : "pass"} — ${verdict.answer}${verdict.confidence !== undefined ? ` (${Math.round(verdict.confidence * 100)}% sure)` : ""}`,
      );
      const key = (await rl.question("\nYour call — [p]ass  [f]ail  [s]kip  [q]uit: ")).trim().toLowerCase();
      if (key === "q") break;
      if (key !== "p" && key !== "f") continue;
      await evals.saveRuling({
        threadId: t.threadId,
        checkId: check.id,
        failed: key === "f",
        ...(flag("by") ? { by: flag("by")! } : {}),
        createdAt: Date.now(),
      });
      n += 1;
    }
    rl.close();
    console.log(`\n${n} ruling${n === 1 ? "" : "s"} saved. pnpm evals trust … to see what they say about the judge.`);
    return;
  }

  if (cmd === "judge") {
    const override = flag("judge");
    if (override) rubric = { ...rubric, defaultJudge: override, checks: rubric.checks.map((c) => (c.kind === "asked" ? { ...c, judge: undefined } : c)) as Check[] };

    const runId = flag("run") ?? (await evals.latestRunId(dataset.owner, dataset.id));
    if (!runId) throw new Error(`no runs of ${dataset.id} yet — pnpm evals run first`);
    const current = await evals.listThreads(dataset.owner, { datasetId: dataset.id, runId });
    const attempts = Math.max(...current.map((t) => (t.attempt ?? 0) + 1));
    const inputsById = new Map(inputs.map((i) => [i.id, i]));
    const judges = new Map<string, ReturnType<typeof evaluationModelFor>>();
    const judgeFor = (id: string) => judges.get(id) ?? judges.set(id, evaluationModelFor(id, modelFor, typeSafeAi)).get(id)!;
    const usage = { calls: 0, inputTokens: 0 };

    // The cascade only where rulings have drawn a line.
    const escalateTo = flag("escalate");
    let escalate: { judge: string; below: Map<string, number> } | undefined;
    if (escalateTo) {
      const past = await allVerdicts();
      const rulings = await evals.listRulings({ threadIds: [...new Set(past.map((v) => v.threadId))] });
      const below = new Map<string, number>();
      for (const c of rubric.checks) {
        const th = thresholdFor(c.id, past, rulings);
        if (c.kind === "asked" && th.accept !== null) below.set(c.id, th.accept);
      }
      escalate = { judge: escalateTo, below };
      console.log(below.size ? `escalating to ${escalateTo} below: ${[...below].map(([k, v]) => `${labelOf(k)} ${v.toFixed(2)}`).join(", ")}` : `no check has enough rulings for a threshold — nothing escalates`);
    }
    const times = Math.max(1, Number(flag("times") ?? 1));
    const passes: Verdict[][] = [];
    const started = Date.now();
    for (let i = 0; i < times; i++) {
      const vs = await judgeThreads({
        rubric,
        threads: current,
        inputsById,
        dataset,
        deps: { loadHistory: (chatId) => runtime.loadHistory({ chatId, principal }), judgeFor },
        ...(escalate ? { escalate } : {}),
        onUsage: (u) => ((usage.calls += u.calls), (usage.inputTokens += u.inputTokens)),
      });
      passes.push(vs);
      if (i === 0) await evals.saveVerdicts(vs);
    }
    const verdicts = passes[0]!;

    // Baseline first, so the comparison reads live → candidate.
    const order = (v: string) => (v === "live" ? "" : v);
    const summaries = summarize(current, verdicts, rubric).sort((a, b) => order(a.version).localeCompare(order(b.version)));
    // With repeats, each cell also says on how many inputs it passed EVERY time.
    const col = attempts > 1 ? 22 : 12;
    console.log(`\n${runId} · ${attempts} attempt${attempts > 1 ? "s" : ""} per input${attempts > 1 ? " · cell = rate  (every time)" : ""}`);
    console.log(`${"".padEnd(width)}  ${summaries.map((s) => s.version.padStart(col)).join("")}`);
    for (const c of rubric.checks) {
      const cells = summaries.map((s) => {
        const x = s.checks.find((k) => k.checkId === c.id)!;
        const rate = `${pct(x.passed, x.total)} ${x.passed}/${x.total}`;
        return (attempts > 1 ? `${rate}  (${x.allPassed}/${x.inputs})` : rate).padStart(col);
      });
      console.log(`${c.label.padEnd(width)}  ${cells.join("")}  ${c.kind === "counted" ? "counted" : (c.judge ?? rubric.defaultJudge)}`);
    }
    for (const s of summaries) if (s.errors) console.log(`! ${s.version}: ${s.errors} threads errored and are not in the numbers`);

    if (summaries.length >= 2) {
      const [a, b] = summaries;
      console.log(`\npaired, ${a!.version} → ${b!.version} (same inputs${attempts > 1 ? ", per-input rates" : ""}):`);
      for (const r of compareVersions(current, verdicts, rubric.checks.map((c) => c.id), a!.version, b!.version)) {
        const label = rubric.checks.find((c) => c.id === r.checkId)!.label;
        const rates = `${Math.round(r.rateA * 100)}% → ${Math.round(r.rateB * 100)}%`.padEnd(12);
        console.log(`  ${label.padEnd(width)}  ${rates}  +${r.improved} −${r.regressed} of ${r.pairs}  p=${r.p.toFixed(4)}${r.p < 0.05 ? "  real" : ""}`);
      }
    }
    if (times > 1) {
      console.log(`\njudge consistency over ${times} passes:`);
      for (const c of consistency(passes)) {
        const label = rubric.checks.find((k) => k.id === c.checkId)?.label ?? c.checkId;
        console.log(`  ${label.padEnd(width)}  ${Math.round(c.agreement * 100)}%  (${c.unanimous}/${c.items} never moved)`);
      }
    }
    console.log(`\nrubric v${rubric.version} · ${current.length} threads · ${usage.calls} judge calls · ${Math.round((Date.now() - started) / 1000)}s`);
    return;
  }

  throw new Error(`unknown command "${cmd}" — import | rubric | run | judge | review | trust`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

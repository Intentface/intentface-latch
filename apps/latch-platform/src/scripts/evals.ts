/**
 * Evals v2 from the command line, against the real database.
 *
 *   pnpm evals import  --org O --user U --agent A --name N --file ax.json
 *   pnpm evals rubric  --org O --user U --agent A --file advisory.json
 *   pnpm evals run     --org O --user U --dataset ID --versions live,@draft [--repeats 3] [--concurrency 4]
 *   pnpm evals judge   --org O --user U --dataset ID --rubric ID [--run ID] [--times 3] [--judge jev-latest]
 *
 * `run` only produces threads; `judge` can be repeated as often as the rubric
 * changes, for seconds and pennies, against byte-identical behaviour. `judge`
 * reads one run — the latest unless `--run` names another — because threads
 * from different runs were produced under different conditions.
 */
import { readFileSync } from "node:fs";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { parseAgentRef } from "@intentface/latch-agent-builder";
import { getLatch } from "../lib/latch";
import { agentOwnerKey as ownerKey } from "../lib/agent-store";
import type { Principal } from "../lib/session";
import type { Check, Dataset, Input, Rubric, Verdict, Version } from "../lib/evals/v2/model";
import { evaluationModelFor } from "../lib/evals/v2/evaluation-model";
import { compareVersions, configFingerprint, consistency, judgeThreads, runDataset, summarize } from "../lib/evals/v2/runner";

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
    await evals.setInputs(id, inputs);
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
  const inputs = await evals.listInputs(dataset.id);

  if (cmd === "run") {
    const labels = (flag("versions") ?? "live").split(",").map((s) => s.trim());
    const versions: (Version & { fingerprint: string })[] = [];
    for (const label of labels) {
      const ref = label === "live" ? dataset.agentName : label.startsWith("@") ? `${dataset.agentName}${label}` : label;
      const p = parseAgentRef(ref);
      const live = await agentStore.getRecord(principal, p.name);
      const scope = live?.scope ?? "user";
      const rec =
        p.at === undefined
          ? live
          : p.at === "draft"
            ? (await agentStore.getDraft(principal, p.name, scope))?.record
            : await agentStore.getVersion(principal, p.name, scope, p.at);
      if (!rec) throw new Error(`${label} (${ref}) does not resolve`);
      versions.push({ label, ref, fingerprint: configFingerprint(rec) });
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

  if (cmd === "judge") {
    let rubric: Rubric | null = null;
    for (const o of owners) rubric ??= await evals.getRubric(o, need("rubric"));
    if (!rubric) throw new Error(`no rubric ${flag("rubric")}`);
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
        onUsage: (u) => ((usage.calls += u.calls), (usage.inputTokens += u.inputTokens)),
      });
      passes.push(vs);
      if (i === 0) await evals.saveVerdicts(vs);
    }
    const verdicts = passes[0]!;

    const summaries = summarize(current, verdicts, rubric);
    const width = Math.max(...rubric.checks.map((c) => c.label.length), 10);
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

  throw new Error(`unknown command "${cmd}" — import | rubric | run | judge`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

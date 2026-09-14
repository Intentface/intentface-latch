/**
 * Edge Eval — the whole benchmark in one command.
 *
 *   pnpm edge                       # from the repo root or apps/latch-platform
 *   pnpm edge --name my-run         # name the run (default: smoke-<date>)
 *   pnpm edge --yes                 # do not ask before spending money
 *   pnpm edge --cases all --reps 3  # anything edge:run takes
 *   pnpm edge --model gpt-5.6-luna  # exercise the machinery on the cheap sibling
 *
 * It runs the four commands of the golden path in order — setup, run, judge, report —
 * echoing each one before it runs it, so a first-timer ends up knowing the long form rather
 * than depending on this wrapper. It stops at the first thing that needs a human and leaves
 * that script's own instructions on screen; nothing here duplicates them.
 *
 * Two things it will not do by itself: spend money (the sweep is confirmed first, with the
 * estimate stated) and decide that a drifted context plane is still the same cohort (that
 * answer belongs to the plane owner, so it asks instead of passing --allow-drift for you).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const APP = resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  const value: string | undefined = i >= 0 ? argv[i + 1] : undefined;
  return value ?? fallback;
};

const NAME = opt("name", `smoke-${new Date().toISOString().slice(0, 10)}`);
const CASES = opt("cases", "INFRA-01,AX-01,CODE-05");
const VARIANTS = opt("variants", "A,AP,B,C,D");
const REPS = opt("reps", "1");
const CONCURRENCY = opt("concurrency", "3");
// The benchmark model is a property of the generation (v0/version.json), not a runtime
// choice — so this stays empty unless someone asks, and a run that sets it says so out loud.
const MODEL = opt("model", "");
const YES = flag("yes");

/** One cell ≈ two model calls ≈ $0.30, judging adds ~$0.08 — stated before anything is spent. */
function estimate() {
  const cells = CASES.split(",").length * VARIANTS.split(",").length * Number(REPS);
  return { cells, dollars: Math.round(cells * 0.38), minutes: Math.ceil((cells * 40) / Number(CONCURRENCY) / 60) };
}

/** Run one pnpm script, echoing it first. The output is the child's, unfiltered. */
function step(script: string, args: string[] = [], opts: { capture?: boolean } = {}) {
  console.log(`\n  $ pnpm ${script}${args.length ? ` ${args.join(" ")}` : ""}\n`);
  // --silent keeps pnpm's own ELIFECYCLE noise out of a report meant for a human.
  const r = spawnSync("pnpm", ["--silent", script, ...args], { cwd: APP, encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  // With stdio "inherit" the child's streams are null at runtime, whatever the types say.
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (opts.capture) {
    process.stdout.write(text(r.stdout));
    process.stderr.write(text(r.stderr));
  }
  return { code: r.status ?? 1, out: `${text(r.stdout)}${text(r.stderr)}` };
}

async function ask(question: string): Promise<boolean> {
  if (YES) return true;
  if (!process.stdin.isTTY) {
    console.log(`\n  ${question}\n  Not a terminal — re-run with --yes if that is what you want.\n`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n  ${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

async function main() {
  // 1. Readiness. Its report is the single source of truth for what a human still has to do.
  if (step("edge:setup").code !== 0) {
    console.log(`  Nothing was run. Fix the item(s) above and run \`pnpm edge\` again.\n`);
    process.exitCode = 1;
    return;
  }

  // 2. The sweep — the only step that costs money, so the only one that asks.
  const { cells, dollars, minutes } = estimate();
  const runArgs = ["--name", NAME, "--variants", VARIANTS, "--cases", CASES, "--reps", REPS, "--concurrency", CONCURRENCY, ...(MODEL ? ["--model", MODEL] : [])];
  if (!MODEL) console.log(`\n  Only checking that the machinery works? \`--model gpt-5.6-luna\` runs the same sweep on the cheap\n  sibling — a pipeline test, not a benchmark result.`);
  const question = MODEL
    ? `Run ${cells} cells as "${NAME}" ON ${MODEL} — not the benchmark model, so the numbers are not comparable with v0. ~${minutes} min?`
    : `Run ${cells} cells (${CASES.split(",").length} cases × ${VARIANTS.split(",").length} arms × ${REPS}) as "${NAME}" — about $${dollars} and ~${minutes} min?`;
  if (!(await ask(question))) {
    console.log(`\n  Stopped before spending anything. The sweep is:\n\n    pnpm edge:run ${runArgs.join(" ")}\n`);
    return;
  }
  let run = step("edge:run", flag("allow-drift") ? [...runArgs, "--allow-drift"] : runArgs, { capture: true });

  // 2b. A drifted plane is a judgement call, not an error to swallow. The runner has already
  // printed which files moved; the only open question is whether this is still one cohort.
  if (run.code !== 0 && /plane drifted/.test(run.out)) {
    if (!(await ask("The context plane above has changed since the manifest. Run anyway? The results become a separate cohort and the report records the live hash."))) {
      console.log(`\n  Stopped. Ask the plane owner what changed; re-run with --allow-drift once it is expected.\n`);
      process.exitCode = 1;
      return;
    }
    run = step("edge:run", [...runArgs, "--allow-drift"], { capture: true });
  }
  if (run.code !== 0) {
    console.log(`\n  The sweep failed (see above). Resume it — never restart it — with:\n\n    pnpm edge:run ${runArgs.join(" ")} --resume\n`);
    process.exitCode = 1;
    return;
  }

  // 3 + 4. Score and render. Both are cheap, idempotent and safe to repeat.
  if (step("edge:judge", ["--run", NAME]).code !== 0) {
    console.log(`\n  Judging failed. The cells are safe in edge-eval-runs/${NAME}/cells.jsonl — re-run: pnpm edge:judge --run ${NAME}\n`);
    process.exitCode = 1;
    return;
  }
  if (step("edge:report", ["--run", NAME]).code !== 0) {
    console.log(`\n  The report failed to render. Re-run: pnpm edge:report --run ${NAME}\n`);
    process.exitCode = 1;
    return;
  }
  const report = resolve(APP, "edge-eval-runs", NAME, "report.html");
  console.log(`\n  Done. The bench is at:\n\n    ${report}\n\n  Open it:  open ${report}\n`);
}

main().catch((e) => {
  console.error("[edge] failed:", e);
  process.exitCode = 1;
});

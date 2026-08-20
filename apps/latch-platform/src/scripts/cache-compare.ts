/**
 * Before/after proof for prompt caching: run the same prompts against one
 * agent twice — control arm with caching OFF, treatment arm with caching ON —
 * then read the created `latch_runs` rows and print each arm's cache-read
 * ratio, token totals, and cost. Uses the in-process runtime (same path as
 * evals: safe-mode runAgent, gated tools stubbed).
 *
 *   node --env-file=.env --import tsx src/scripts/cache-compare.ts \
 *     --org <orgId> [--user <userId>] --agent <name> \
 *     [--set <evalSetName>] [--prompt "..."]... [--repeats N]
 *
 * With --set, prompts come from the agent's stored eval set; --prompt can be
 * repeated instead (default: one generic multi-step probe). Success bar: the
 * ON arm shows cacheRead > 0 on multi-step cases and cost-per-case at or
 * below the OFF arm.
 */
import { getLatch } from "../lib/latch";
import { evalOwnerKeysOf } from "../lib/agent-store";
import { runEvalCases } from "../lib/evals/run";
import type { EvalCase } from "../lib/evals/store";
import type { Principal } from "../lib/session";

interface Args {
  org: string;
  user?: string;
  agent: string;
  set?: string;
  prompts: string[];
  repeats: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { org: "", agent: "", prompts: [], repeats: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--org") out.org = next();
    else if (a === "--user") out.user = next();
    else if (a === "--agent") out.agent = next();
    else if (a === "--set") out.set = next();
    else if (a === "--prompt") out.prompts.push(next());
    else if (a === "--repeats") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error(`--repeats must be a positive integer, got: ${n}`);
      out.repeats = n;
    }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.org || !out.agent) {
    throw new Error("required: --org <orgId> --agent <name> (see file header for usage)");
  }
  return out;
}

interface ArmTotals {
  runs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

async function runArm(input: {
  label: string;
  promptCaching: boolean;
  principal: Principal;
  agent: string;
  cases: EvalCase[];
}): Promise<ArmTotals> {
  const { runtime } = await getLatch();
  console.log(`\n[${input.label}] running ${input.cases.length} case(s)…`);
  const results = await runEvalCases({
    runtime,
    principal: input.principal,
    agent: input.agent,
    cases: input.cases,
    promptCaching: input.promptCaching,
    // Serialized on purpose: parallel runs in the ON arm race the first cache
    // write (both miss, both pay the write premium), understating the hit rate.
    concurrency: 1,
    onAttempt: (done, total) => console.log(`[${input.label}] attempt ${done}/${total}`),
  });

  // A comparison over errored runs is noise, not data — bail loudly.
  const errored = results
    .flatMap((r) => (r.attempts?.length ? r.attempts : [r]))
    .filter((a) => a.reasons.includes("run errored")).length;
  if (errored > 0) {
    throw new Error(`[${input.label}] ${errored} attempt(s) errored — aborting the comparison`);
  }

  // Read the usage the arm's runs recorded — the thread ids tie results to
  // their `latch_runs` rows (one turn each; subagent turns land in sub-chats
  // of their own but share the caching flag only for the top runAgent turn).
  const threadIds = results
    .flatMap((r) => (r.attempts?.length ? r.attempts.map((a) => a.threadId) : [r.threadId]))
    .filter((t): t is string => !!t);
  const totals: ArmTotals = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const threadId of threadIds) {
    for (const run of await runsOfChat(threadId)) {
      totals.runs += 1;
      totals.input += run.input;
      totals.output += run.output;
      totals.cacheRead += run.cacheRead;
      totals.cacheWrite += run.cacheWrite;
      totals.cost += run.cost;
    }
  }
  return totals;
}

async function runsOfChat(chatId: string) {
  // Raw row read via the caching-stats client would need owner plumbing; the
  // runtime has no by-chat run listing, so go through the drizzle client that
  // getLatch's stores share. Lazy import keeps the script's deps honest.
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: process.env.DATABASE_URL ?? "file:./latch.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const res = await client.execute({
    sql: `SELECT COALESCE(usage_input_tokens,0) i, COALESCE(usage_output_tokens,0) o,
                 COALESCE(usage_cache_read_tokens,0) cr, COALESCE(usage_cache_write_tokens,0) cw,
                 COALESCE(cost_total,0) c
          FROM latch_runs WHERE chat_id = ? AND COALESCE(kind,'turn') = 'turn'`,
    args: [chatId],
  });
  client.close();
  return res.rows.map((r) => ({
    input: Number(r.i),
    output: Number(r.o),
    cacheRead: Number(r.cr),
    cacheWrite: Number(r.cw),
    cost: Number(r.c),
  }));
}

function report(label: string, t: ArmTotals) {
  const hit = t.input > 0 ? ((t.cacheRead / t.input) * 100).toFixed(1) : "0.0";
  const perRun = t.runs > 0 ? (t.cost / t.runs).toFixed(6) : "n/a";
  console.log(
    `[${label}] runs=${t.runs} input=${t.input} output=${t.output} ` +
      `cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite} hitRate=${hit}% ` +
      `cost=$${t.cost.toFixed(6)} cost/run=$${perRun}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const principal: Principal = { orgId: args.org, ...(args.user ? { userId: args.user } : {}) };
  const { evalStore } = await getLatch();

  let cases: EvalCase[];
  if (args.set) {
    // Eval sets are keyed by the AGENT's owner (personal or org scope) — try both.
    let found = null;
    for (const owner of evalOwnerKeysOf(principal)) {
      found = await evalStore.getSet(owner, args.agent, args.set);
      if (found) break;
    }
    if (!found) throw new Error(`eval set not found: ${args.set} (agent ${args.agent})`);
    cases = found.cases;
  } else if (args.prompts.length > 0) {
    cases = args.prompts.map((input, i) => ({
      name: `prompt-${i + 1}`,
      input,
      expected: {},
    })) as EvalCase[];
  } else {
    cases = [
      {
        name: "default-probe",
        input:
          "Use your available tools to gather what you need, then summarize what you did in two sentences.",
        expected: {},
      } as EvalCase,
    ];
  }
  if (args.repeats > 1) {
    cases = Array.from({ length: args.repeats }, (_, n) =>
      cases.map((c) => ({ ...c, name: `${c.name}-r${n + 1}` })),
    ).flat();
  }

  const off = await runArm({ label: "caching OFF", promptCaching: false, principal, agent: args.agent, cases });
  const on = await runArm({ label: "caching ON ", promptCaching: true, principal, agent: args.agent, cases });

  console.log("\n=== cache-compare ===");
  report("caching OFF", off);
  report("caching ON ", on);
  if (on.cacheRead === 0) {
    console.log(
      "⚠ no cache reads in the ON arm — expected for single-step cases (nothing re-sends the prefix) " +
        "or prompts under the model's minimum cacheable prefix.",
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

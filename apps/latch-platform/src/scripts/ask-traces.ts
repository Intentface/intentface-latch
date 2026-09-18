/**
 * Ask plain-English questions of conversations that ALREADY HAPPENED.
 *
 * This is the idea in one command. Nothing is re-run and no agent is invoked:
 * it reads stored transcripts, asks a judge a handful of questions about each,
 * and prints how often the answer was the bad one. A question written this
 * morning gets answered about conversations from March, for the price of the
 * judge alone.
 *
 *   node --env-file=.env --import tsx src/scripts/ask-traces.ts \
 *     --org <orgId> [--user <userId>] --agent <name> \
 *     --questions questions.json [--limit 50] [--scan 200] [--judge <modelId>[,<modelId>]]
 *
 * Give `--judge` more than one id and every conversation is asked of each, then
 * they are scored against EACH OTHER: how often they agree per question, what
 * each cost, and how long each took. That is how to decide whether a cheap
 * judge is good enough for YOUR questions — a comparison rather than a bet.
 * Provider follows from the id (`jev-*`, `claude-*`, `gpt-*`, `gemini-*`).
 *
 * `questions.json` is a map of stable id → question:
 *
 *   {
 *     "grounded":  { "ask": "Is every factual claim supported by a document the agent opened?" },
 *     "opened_doc":{ "ask": "Did the agent open at least one document?", "agg": "every" },
 *     "ambiguity": { "type": "choice",
 *                    "ask": "The question didn't say which region. What did the agent do?",
 *                    "options": { "asked": "Asked which region", "answered": "Stated a limit anyway" },
 *                    "bad": ["answered"] }
 *   }
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: compare two agent versions. A paired
 * comparison needs the same task answered by both, and a stored chat does not
 * record which version of the agent served it (`ChatRecord` has no version
 * field). So the two honest routes are a canary — tag which version served
 * each chat, then compare over the same period — or a replay of stored
 * questions against a new config. `lib/evals/stats.ts` implements the
 * comparison and is ready for either; the missing piece is the version marker,
 * not the statistics.
 */
import { readFileSync } from "node:fs";
import { getLatch } from "../lib/latch";
import { askOfTrace, type Question } from "../lib/evals/ask";
import { judgeModel } from "../lib/evals/judge-model";
import type { Principal } from "../lib/session";

const DEFAULT_JUDGE = "claude-haiku-4-5-20251001";

interface Args {
  org: string;
  user?: string;
  agent: string;
  questions: string;
  /** How many matching conversations to judge. */
  limit: number;
  /** How many recent chats to look through to find them. */
  scan: number;
  /** One or more judges. More than one ⇒ they are compared against each other. */
  judges: string[];
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const org = get("--org");
  const agent = get("--agent");
  const questions = get("--questions");
  if (!org || !agent || !questions) {
    throw new Error(
      "usage: --org <id> --agent <name> --questions <file.json> [--user <id>] [--limit N] [--scan N] [--judge <modelId>]",
    );
  }
  return {
    org,
    user: get("--user"),
    agent,
    questions,
    limit: Number(get("--limit") ?? 50),
    scan: Number(get("--scan") ?? Math.max(200, Number(get("--limit") ?? 50) * 10)),
    judges: (get("--judge") ?? DEFAULT_JUDGE).split(",").map((s) => s.trim()).filter(Boolean),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = JSON.parse(readFileSync(args.questions, "utf8")) as Record<string, Question>;
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error(`${args.questions} defines no questions`);

  const { runtime } = await getLatch();
  const principal = { orgId: args.org, userId: args.user ?? args.org } as unknown as Principal;
  const judges = args.judges.map((id) => ({ id, model: judgeModel(id) }));

  // `listChats` limits BEFORE we can filter by agent, so scan wider than we
  // intend to judge — otherwise a caller whose recent chats belong to other
  // agents gets "no stored chats" for an agent with hundreds.
  //
  // Internal sub-threads are dropped here: a subagent's thread is half a
  // conversation and judging it as a whole one is noise. Filtered in code
  // rather than with `listChats({ kind: "user" })`, because that matches the
  // column exactly and chats created before `kind` existed have it NULL —
  // which is most of the history the whole point is to be able to ask about.
  const scanned = await runtime.listChats({ principal, limit: args.scan });
  const chats = scanned
    .filter((c) => c.agent === args.agent && c.kind !== "internal" && !c.id.startsWith("sub_"))
    .slice(0, args.limit);
  if (chats.length === 0) {
    console.log(
      `No stored chats for agent "${args.agent}" in the ${scanned.length} most recent ` +
        `(raise --scan if this agent's chats are older).`,
    );
    return;
  }

  console.log(
    `Asking ${ids.length} question(s) of ${chats.length} stored conversation(s)\n` +
      `judge(s): ${judges.map((j) => j.id).join(", ")}\n`,
  );

  /** judge id → chat id → question id → failed. */
  const failedBy: Record<string, Record<string, Record<string, boolean>>> = {};
  const stats: Record<string, { calls: number; input: number; output: number; ms: number }> = {};
  for (const j of judges) {
    failedBy[j.id] = {};
    stats[j.id] = { calls: 0, input: 0, output: 0, ms: 0 };
  }
  const judgedChats: string[] = [];

  for (const chat of chats) {
    const messages = await runtime.loadHistory({ chatId: chat.id, principal });
    if (messages.length === 0) continue;
    judgedChats.push(chat.id);

    const cells: string[] = [];
    for (const j of judges) {
      const t0 = Date.now();
      const { verdicts, usage } = await askOfTrace({ model: j.model, messages, questions });
      const st = stats[j.id]!;
      st.ms += Date.now() - t0;
      st.calls += usage.calls;
      st.input += usage.inputTokens;
      st.output += usage.outputTokens;

      const row: Record<string, boolean> = {};
      for (const v of verdicts) row[v.id] = v.failed;
      failedBy[j.id]![chat.id] = row;
      cells.push(verdicts.map((v) => (v.failed ? "✗" : "✓")).join(""));
    }
    console.log(`  ${chat.id.slice(0, 18).padEnd(20)} ${cells.join("   ")}`);
  }

  const n = judgedChats.length;
  const countFailed = (judge: string, q: string) =>
    judgedChats.filter((c) => failedBy[judge]![c]?.[q]).length;

  console.log(`\n${"question".padEnd(26)} ${judges.map((j) => j.id.slice(0, 14).padStart(15)).join("")}`);
  console.log("-".repeat(26 + judges.length * 15));
  for (const q of ids) {
    const cols = judges
      .map((j) => `${countFailed(j.id, q)}/${n}`.padStart(15))
      .join("");
    console.log(`${q.padEnd(26)}${cols}`);
  }

  if (judges.length > 1) {
    // The number that decides whether a cheap judge is good enough HERE.
    // Agreement is not accuracy — two judges can be wrong together — but
    // disagreement is where to spend your own attention first.
    console.log(`\nagreement between judges (share of conversations they answered the same way)`);
    console.log("-".repeat(60));
    for (const q of ids) {
      const same = judgedChats.filter((c) => {
        const answers = judges.map((j) => failedBy[j.id]![c]?.[q]);
        return answers.every((a) => a === answers[0]);
      }).length;
      const disagreed = judgedChats.filter((c) => {
        const answers = judges.map((j) => failedBy[j.id]![c]?.[q]);
        return !answers.every((a) => a === answers[0]);
      });
      const eg = disagreed.length ? `   differs on ${disagreed.slice(0, 2).join(", ")}` : "";
      console.log(`${q.padEnd(26)} ${`${((same / n) * 100).toFixed(0)}%`.padStart(5)} (${same}/${n})${eg}`);
    }
  }

  console.log(`\n${"judge".padEnd(26)} ${"calls".padStart(6)} ${"tokens in".padStart(10)} ${"out".padStart(6)} ${"seconds".padStart(8)}`);
  console.log("-".repeat(60));
  for (const j of judges) {
    const st = stats[j.id]!;
    console.log(
      `${j.id.slice(0, 26).padEnd(26)} ${String(st.calls).padStart(6)} ${String(st.input).padStart(10)} ` +
        `${String(st.output).padStart(6)} ${(st.ms / 1000).toFixed(1).padStart(8)}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

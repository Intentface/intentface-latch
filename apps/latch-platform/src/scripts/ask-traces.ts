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
 *     --questions questions.json [--limit 50] [--scan 200] [--judge <modelId>]
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
import { anthropic } from "@ai-sdk/anthropic";
import { getLatch } from "../lib/latch";
import { askOfTrace, type Question } from "../lib/evals/ask";
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
  judge: string;
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
    judge: get("--judge") ?? DEFAULT_JUDGE,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = JSON.parse(readFileSync(args.questions, "utf8")) as Record<string, Question>;
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error(`${args.questions} defines no questions`);

  const { runtime } = await getLatch();
  const principal = { orgId: args.org, userId: args.user ?? args.org } as unknown as Principal;
  const model = anthropic.evaluationModel(args.judge);

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
    `Asking ${ids.length} question(s) of ${chats.length} stored conversation(s) — judge ${args.judge}\n`,
  );

  const failures: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  /** Chats where a question failed, so a failure can be opened and read. */
  const examples: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
  let judged = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let sliced = 0;

  for (const chat of chats) {
    const messages = await runtime.loadHistory({ chatId: chat.id, principal });
    if (messages.length === 0) continue;

    const { verdicts, usage } = await askOfTrace({ model, messages, questions });
    judged++;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    calls += usage.calls;
    if (usage.calls > 1) sliced++;

    for (const v of verdicts) {
      if (!v.failed) continue;
      failures[v.id]!++;
      if (examples[v.id]!.length < 3) examples[v.id]!.push(chat.id);
    }
    console.log(
      `  ${chat.id.slice(0, 18).padEnd(20)} ` +
        verdicts.map((v) => `${v.failed ? "✗" : "✓"} ${v.id}`).join("  "),
    );
  }

  console.log(`\n${"question".padEnd(26)} failed`);
  console.log("-".repeat(60));
  for (const id of ids) {
    const rate = judged ? failures[id]! / judged : 0;
    const eg = examples[id]!.length ? `   e.g. ${examples[id]!.join(", ")}` : "";
    console.log(
      `${id.padEnd(26)} ${String(failures[id]).padStart(3)}/${judged}  ${pct(rate).padStart(4)}${eg}`,
    );
  }

  // The number that decides whether asking everything is affordable.
  console.log(
    `\n${calls} judge call(s) over ${judged} conversation(s)` +
      (sliced ? `, ${sliced} needed slicing` : "") +
      ` — ${inputTokens} in / ${outputTokens} out` +
      (judged ? ` (${(inputTokens / judged).toFixed(0)} in per conversation)` : ""),
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

import type { Experimental_EvaluationModel, LanguageModel } from "ai";
import type { Runtime } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { gradeCase } from "./grade";
import { judgeRubric } from "./judge";
import { askOfTrace } from "./ask";
import type { EvalAttemptResult, EvalCase, EvalCaseResult, EvalToolCall, JsonValue } from "./store";

/** Attempts a case runs: its opt-in `repeats` (bounded), default 1. */
export const repeatsOf = (c: EvalCase): number => Math.max(1, Math.min(c.repeats ?? 1, 5));

/**
 * Run a set of eval cases against one agent: each case is an isolated
 * safe-mode `runAgent` (sub-thread, approval-gated tools stubbed), whose
 * transcript is read back for tool calls and graded deterministically.
 * A case with `repeats: N` runs N attempts (fanned through the same pool)
 * and passes on a MAJORITY — its result records passes/repeats so flakiness
 * is a number, not run-to-run noise. Concurrency-capped so a big set
 * doesn't stampede the provider.
 */
export async function runEvalCases({
  runtime,
  principal,
  agent,
  cases,
  concurrency = 4,
  judgeModel,
  judge,
  onResult,
  onAttempt,
  promptCaching,
}: {
  runtime: Pick<Runtime<Principal>, "runAgent" | "loadHistory">;
  principal: Principal;
  agent: string;
  cases: EvalCase[];
  concurrency?: number;
  /** Per-run prompt-caching override — the A/B lever for cache-compare. */
  promptCaching?: boolean;
  /** Pinned judge for rubric criteria — required iff any case declares a rubric. */
  judgeModel?: LanguageModel;
  /** Evaluation model for a case's typed `checks`. Required iff any case has them. */
  judge?: Experimental_EvaluationModel;
  /** Fires as each CASE finishes all its attempts (completion order). */
  onResult?: (result: EvalCaseResult, completedCases: number, totalCases: number) => void;
  /** Fires as each ATTEMPT finishes — the finer-grained progress tick. */
  onAttempt?: (completedAttempts: number, totalAttempts: number) => void;
}): Promise<EvalCaseResult[]> {
  const attempt = async (c: EvalCase): Promise<EvalAttemptResult> => {
    try {
      const first = await runtime.runAgent({
        principal,
        agent,
        prompt: c.input,
        blockGated: true,
        ...(promptCaching !== undefined ? { promptCaching } : {}),
      });
      const threadId = first.threadId;
      const answers = [first.answer];
      // Follow-ups go into the SAME thread, in order, each one seeing every
      // reply before it — which is the only way a case can test whether the
      // agent keeps its footing across a conversation.
      for (const followUp of c.followUps ?? []) {
        const next = await runtime.runAgent({
          principal,
          agent,
          prompt: followUp,
          threadId,
          blockGated: true,
          ...(promptCaching !== undefined ? { promptCaching } : {}),
        });
        answers.push(next.answer);
      }
      const answer = answers[answers.length - 1]!;
      const history = await runtime.loadHistory({ chatId: threadId, principal });
      const toolCalls = extractToolCalls(history);
      // Assertions read EVERY answer, not just the last: a promise kept in the
      // first reply and broken in the third is still broken, and a format rule
      // that only applies to the opening turn would otherwise go unchecked.
      const { reasons } = await gradeCase(c, answers.join("\n\n"), toolCalls);
      // Judge tier: a failed criterion fails the attempt like any check; a
      // judge INFRA error (v.error) surfaces in the verdicts but never fails.
      let rubric;
      if (judgeModel && c.expected.rubric?.length) {
        rubric = await judgeRubric({
          model: judgeModel,
          input: c.input,
          answer,
          toolCalls,
          criteria: c.expected.rubric,
        });
        for (const v of rubric) {
          if (!v.error && !v.pass) reasons.push(`rubric "${v.criterion}": ${v.reason}`);
        }
      }
      // The case's typed questions, asked of the trace it just produced —
      // the SAME call that asks questions of real production traffic. A case
      // is a question with a synthetic input; nothing else about it differs,
      // so a question written for one works unchanged on the other.
      let checks: EvalAttemptResult["checks"];
      if (judge && c.checks && Object.keys(c.checks).length) {
        const { verdicts } = await askOfTrace({
          model: judge,
          messages: history,
          questions: c.checks,
        });
        checks = verdicts.map((v) => ({
          id: v.id,
          answer: v.answer,
          confidence: v.confidence,
          failed: v.failed,
          slices: v.slices,
          ...(v.failedSlices.length ? { failedSlices: v.failedSlices } : {}),
        }));
        for (const v of checks) {
          if (v.failed) reasons.push(`check "${v.id}": answered ${v.answer}`);
        }
      }
      return {
        pass: reasons.length === 0,
        reasons,
        threadId,
        answerPreview: answers.join("\n\n").slice(0, 400),
        toolCalls,
        rubric,
        checks,
      };
    } catch (e) {
      return {
        pass: false,
        reasons: ["run errored"],
        answerPreview: "",
        toolCalls: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // Fan out ATTEMPTS through the pool (not cases), so one repeated case
  // doesn't serialize behind the others; aggregate when its last attempt lands.
  const units = cases.flatMap((c, ci) =>
    Array.from({ length: repeatsOf(c) }, (_, ai) => ({ c, ci, ai })),
  );
  const buckets: EvalAttemptResult[][] = cases.map((c) => new Array(repeatsOf(c)));
  const remaining = cases.map(repeatsOf);
  const results = new Array<EvalCaseResult>(cases.length);
  let attemptsDone = 0;
  let casesDone = 0;

  await mapPool(units, concurrency, async (u) => {
    buckets[u.ci][u.ai] = await attempt(u.c);
    attemptsDone += 1;
    remaining[u.ci] -= 1;
    if (remaining[u.ci] === 0) {
      results[u.ci] = aggregateCase(u.c, buckets[u.ci]);
      casesDone += 1;
      onResult?.(results[u.ci], casesDone, cases.length);
    }
    onAttempt?.(attemptsDone, units.length);
  });
  return results;
}

/** Fold a case's attempts into one result: majority verdict, flakiness recorded. */
function aggregateCase(c: EvalCase, attempts: EvalAttemptResult[]): EvalCaseResult {
  if (attempts.length === 1) return { caseId: c.id, caseName: c.name, ...attempts[0] };
  const passes = attempts.filter((a) => a.pass).length;
  const need = Math.floor(attempts.length / 2) + 1;
  const pass = passes >= need;
  // Represent the case by a failing attempt WITH a transcript (that's what's
  // worth diagnosing — an errored attempt has none), then any failing
  // attempt, then the first attempt when all passed.
  const rep =
    attempts.find((a) => !a.pass && a.threadId) ??
    attempts.find((a) => !a.pass) ??
    attempts[0];
  const reasons = pass
    ? []
    : [
        `passed ${passes}/${attempts.length} repeats (need ${need})`,
        ...Array.from(new Set(attempts.filter((a) => !a.pass).flatMap((a) => a.reasons))),
      ];
  return {
    caseId: c.id,
    caseName: c.name,
    pass,
    reasons,
    threadId: rep.threadId,
    answerPreview: rep.answerPreview,
    toolCalls: rep.toolCalls,
    rubric: rep.rubric,
    error: attempts.every((a) => a.error) ? rep.error : undefined,
    repeats: attempts.length,
    passes,
    attempts,
  };
}

/** Tool invocations (name + args + blocked marker) from a stored transcript. */
export function extractToolCalls(history: unknown[]): EvalToolCall[] {
  const calls: EvalToolCall[] = [];
  for (const m of history) {
    for (const p of (((m as { parts?: unknown[] }).parts ?? []) as Record<string, unknown>[])) {
      const type = p.type as string | undefined;
      if (!type) continue;
      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const tool =
          typeof p.toolName === "string"
            ? p.toolName
            : type.startsWith("tool-")
              ? type.slice(5)
              : "unknown";
        const blocked = (p.output as { __blocked?: boolean } | undefined)?.__blocked;
        // Parsed from a stored JSON part, so JSON by construction.
        calls.push({ tool, args: p.input as JsonValue, blocked: blocked || undefined });
      }
    }
  }
  return calls;
}

/** map with a fixed-size worker pool; results keep input order. */
async function mapPool<T, TResult>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

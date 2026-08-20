import type { LanguageModel } from "ai";
import type { Runtime } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { gradeCase } from "./grade";
import { judgeRubric } from "./judge";
import type { EvalAttemptResult, EvalCase, EvalCaseResult, EvalToolCall } from "./store";

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
  /** Fires as each CASE finishes all its attempts (completion order). */
  onResult?: (result: EvalCaseResult, completedCases: number, totalCases: number) => void;
  /** Fires as each ATTEMPT finishes — the finer-grained progress tick. */
  onAttempt?: (completedAttempts: number, totalAttempts: number) => void;
}): Promise<EvalCaseResult[]> {
  const attempt = async (c: EvalCase): Promise<EvalAttemptResult> => {
    try {
      const { threadId, answer } = await runtime.runAgent({
        principal,
        agent,
        prompt: c.input,
        blockGated: true,
        ...(promptCaching !== undefined ? { promptCaching } : {}),
      });
      const history = await runtime.loadHistory({ chatId: threadId, principal });
      const toolCalls = extractToolCalls(history);
      const { reasons } = await gradeCase(c, answer, toolCalls);
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
      return {
        pass: reasons.length === 0,
        reasons,
        threadId,
        answerPreview: answer.slice(0, 400),
        toolCalls,
        rubric,
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
        calls.push({ tool, args: p.input, blocked: blocked || undefined });
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

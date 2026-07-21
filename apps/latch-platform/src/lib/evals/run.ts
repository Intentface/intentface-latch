import type { Runtime } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { gradeCase } from "./grade";
import type { EvalCase, EvalCaseResult, EvalToolCall } from "./store";

/**
 * Run a set of eval cases against one agent: each case is an isolated
 * safe-mode `runAgent` (sub-thread, approval-gated tools stubbed), whose
 * transcript is read back for tool calls and graded deterministically.
 * Concurrency-capped so a big set doesn't stampede the provider.
 */
export async function runEvalCases({
  runtime,
  principal,
  agent,
  cases,
  concurrency = 4,
  onResult,
}: {
  runtime: Pick<Runtime<Principal>, "runAgent" | "loadHistory">;
  principal: Principal;
  agent: string;
  cases: EvalCase[];
  concurrency?: number;
  /** Fires as each case finishes grading (completion order) — for live progress. */
  onResult?: (result: EvalCaseResult, completed: number, total: number) => void;
}): Promise<EvalCaseResult[]> {
  let completed = 0;
  const graded = async (c: EvalCase): Promise<EvalCaseResult> => {
    try {
      const { threadId, answer } = await runtime.runAgent({
        principal,
        agent,
        prompt: c.input,
        blockGated: true,
      });
      const history = await runtime.loadHistory({ chatId: threadId, principal });
      const toolCalls = extractToolCalls(history);
      const { pass, reasons } = gradeCase(c, answer, toolCalls);
      return {
        caseId: c.id,
        caseName: c.name,
        pass,
        reasons,
        threadId,
        answerPreview: answer.slice(0, 400),
        toolCalls,
      };
    } catch (e) {
      return {
        caseId: c.id,
        caseName: c.name,
        pass: false,
        reasons: ["run errored"],
        answerPreview: "",
        toolCalls: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  return mapPool(cases, concurrency, async (c) => {
    const result = await graded(c);
    completed += 1;
    onResult?.(result, completed, cases.length);
    return result;
  });
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

import { experimental_evaluate as evaluate } from "ai";
import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  Experimental_EvaluationModelV4Question as EvaluationQuestion,
} from "@ai-sdk/provider";
import type { AnswerShape, AskedCheck, Dataset, InputFacts } from "./model";
import type { ThreadView } from "./thread";
import { transcriptOf } from "./thread";

/**
 * Asked checks — plain-English questions a judge answers about a thread.
 *
 * Checks are grouped by judge and each group is ONE `evaluate` call: many
 * typed questions against one shared state in a single pass. That is why
 * judging a thread costs fractions of a cent while running the agent to
 * produce it costs dollars, and why re-judging a whole dataset takes seconds.
 */

export const DEFAULT_JUDGE = "jev-latest";

export function toQuestion(c: AskedCheck): EvaluationQuestion {
  const s = c.shape;
  if (s.type === "boolean") return { type: "boolean", instructions: c.ask };
  if (s.type === "choice") return { type: "choice", instructions: c.ask, criteria: s.options };
  return { type: "score", instructions: c.ask, criteria: s.levels.map((l) => `${l.name}: ${l.means}`) };
}

export function failedBy(shape: AnswerShape, answer: string, score?: number): boolean {
  if (shape.type === "boolean") return answer === (shape.bad ?? "false");
  if (shape.type === "choice") return shape.bad.includes(answer);
  const idx = score !== undefined ? Math.round(score) : shape.levels.findIndex((l) => l.name === answer);
  return idx <= (shape.bad ?? 0);
}

/**
 * The state every asked check reads.
 *
 * The whole thread, tool calls before answers, plus whatever the input
 * supplies. `note` earns its place: a judge that does not know answers are
 * meant to be free-standing marks a correct one down for not citing.
 */
export function stateOf(input: {
  view: ThreadView;
  facts?: InputFacts;
  dataset?: Pick<Dataset, "audience" | "note">;
}): Record<string, string> {
  const { view, facts, dataset } = input;
  const state: Record<string, string> = {};
  if (dataset?.audience) state.WHO_IS_ASKING = dataset.audience;
  if (dataset?.note) state.HOW_ANSWERS_SHOULD_READ = dataset.note;
  state.THREAD = transcriptOf(view);
  if (facts?.answer) state.REFERENCE_ANSWER = facts.answer;
  if (facts?.mustNot?.length) state.MUST_NOT = facts.mustNot.map((x) => `- ${x}`).join("\n");
  for (const [k, v] of Object.entries(facts ?? {})) {
    if (k === "answer" || k === "mustNot" || v == null) continue;
    state[k.toUpperCase()] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return state;
}

export interface AskedAnswer {
  checkId: string;
  judgeId: string;
  answer: string;
  /** Confidence in the answer GIVEN — the contract returns P(true) for yes/no. */
  confidence?: number;
  score?: number;
  failed: boolean;
}

type RawAnswer = { type: string; probability?: number; choice?: string; score?: number; probabilities?: Record<string, number> };

function read(c: AskedCheck, a: RawAnswer): Omit<AskedAnswer, "checkId" | "judgeId" | "failed"> {
  if (a.type === "boolean") {
    const p = a.probability ?? 0;
    const yes = p >= 0.5;
    // P(true) is not confidence: a firm "no" arrives as 0.02 and would read
    // as 2% sure. Flip it into confidence in the answer actually given.
    return { answer: String(yes), confidence: yes ? p : 1 - p };
  }
  if (a.type === "choice") {
    const choice = a.choice ?? "";
    return { answer: choice, ...(a.probabilities?.[choice] !== undefined ? { confidence: a.probabilities[choice] } : {}) };
  }
  const score = a.score ?? 0;
  const rung = c.shape.type === "score" ? c.shape.levels[Math.round(score)] : undefined;
  return { answer: rung?.name ?? String(Math.round(score)), score };
}

export interface JudgeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export async function judgeAsked(input: {
  checks: AskedCheck[];
  state: Record<string, string>;
  defaultJudge: string;
  judgeFor: (id: string) => EvaluationModel;
  onUsage?: (u: JudgeUsage) => void;
}): Promise<AskedAnswer[]> {
  const groups = new Map<string, AskedCheck[]>();
  for (const c of input.checks) {
    const id = c.judge ?? input.defaultJudge;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(c);
  }
  const out: AskedAnswer[] = [];
  for (const [judgeId, checks] of groups) {
    const res = await evaluate({
      model: input.judgeFor(judgeId),
      state: input.state,
      questions: Object.fromEntries(checks.map((c) => [c.id, toQuestion(c)])),
    });
    input.onUsage?.({ calls: 1, inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 });
    for (const c of checks) {
      const a = res.answers[c.id] as RawAnswer | undefined;
      if (!a) continue;
      const r = read(c, a);
      out.push({ checkId: c.id, judgeId, ...r, failed: failedBy(c.shape, r.answer, r.score) });
    }
  }
  return out;
}

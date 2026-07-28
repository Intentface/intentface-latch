import type {
  TelemetryRunMeta,
  TelemetryRunOutcome,
} from "@intentface/latch-core";
import { postScore } from "@intentface/latch-langfuse";
import type { LanguageModel } from "ai";
import type { Principal } from "../session";
import type { AttachedEval } from "../agent-store";
import { ownerTagOf } from "../latch";
import type { getLatch } from "../latch";
import { JUDGE_MODEL_ID, judgeOnce } from "../evals/judge";
import {
  allAssistantText,
  extractRunView,
  renderChatContext,
  summarizeToolCalls,
  summarizeToolLoop,
} from "./extract";
import type { ToolCallView } from "./extract";
import {
  chatKindOf,
  rubricIsDue,
  triggerNeedsTurnOrdinal,
  turnOrdinalOf,
} from "./trigger";
import type { EvalContextScope, TriggerFacts } from "./trigger";
import type { RunScore } from "./run-scores-store";

type Latch = Awaited<ReturnType<typeof getLatch>>;

/** One rubric's verdict, normalized to a numeric value + the judge's reason. */
export interface RubricVerdictResult {
  rubric: AttachedEval;
  value: number;
  comment?: string;
}

/**
 * Judge one already-computed answer against a set of rubrics, concurrently.
 * Shared by the live path and the re-judge path — the caller supplies a `sink`
 * that decides where verdicts go (Langfuse + local, or local only). Judge INFRA
 * errors are logged and skipped (never a false score); a bad rubric never
 * disrupts the others.
 */
export async function evaluateRubrics(opts: {
  runId: string;
  modelFor: (id: string) => LanguageModel;
  rubrics: AttachedEval[];
  input: string;
  answer: string;
  tools: string;
  /** Prior conversation text (the "chat" context scope), when the rubrics want it. */
  conversation?: string;
  sink: (v: RubricVerdictResult) => Promise<void>;
}): Promise<void> {
  await Promise.all(
    opts.rubrics.map(async (ev) => {
      try {
        const model = opts.modelFor(ev.judgeModelId ?? JUDGE_MODEL_ID);
        const verdict = await judgeOnce(model, {
          input: opts.input,
          answer: opts.answer,
          tools: opts.tools,
          conversation: opts.conversation,
          criterion: ev.prompt,
          scale: ev.scale,
        });
        if (verdict.error) {
          console.warn(`judge "${ev.name}" (run ${opts.runId}): ${verdict.error}`);
          return; // infra error → no score, mirroring the batch tier
        }
        const value =
          ev.scale === "binary" ? (verdict.pass ? 1 : 0) : (verdict.score ?? 0);
        await opts.sink({ rubric: ev, value, comment: verdict.reason });
      } catch (e) {
        console.warn(`judge "${ev.name}" (run ${opts.runId}) failed:`, e);
      }
    }),
  );
}

/** The judge-facing evidence for one turn, before scope-specific rendering. */
interface TurnEvidence {
  /** The turn's last user text. */
  input: string;
  /** Final assistant text + tool calls of the turn under judgment. */
  view: { outputText?: string; toolCalls: ToolCallView[] };
  /** The turn's raw persisted messages (the "loop" scope re-walks them). */
  turnMessages: unknown[];
  /** Chat history up to AND including this turn (the "chat" scope renders it). */
  historyForChat: unknown[];
}

/**
 * Judge a gated rubric set, grouping by context scope so each scope's evidence
 * is rendered once and all groups run concurrently. Both the live path and the
 * re-judge path funnel through here — the scope semantics can't drift.
 */
async function judgeScopeGroups(opts: {
  runId: string;
  modelFor: (id: string) => LanguageModel;
  rubrics: AttachedEval[];
  evidence: TurnEvidence;
  sink: (v: RubricVerdictResult) => Promise<void>;
}): Promise<void> {
  const groups = new Map<EvalContextScope, AttachedEval[]>();
  for (const ev of opts.rubrics) {
    const scope = ev.context ?? "turn";
    const group = groups.get(scope);
    if (group) group.push(ev);
    else groups.set(scope, [ev]);
  }
  const { input, view, turnMessages, historyForChat } = opts.evidence;
  await Promise.all(
    [...groups].map(([scope, rubrics]) =>
      evaluateRubrics({
        runId: opts.runId,
        modelFor: opts.modelFor,
        rubrics,
        input,
        // "loop" sees every assistant text part of the turn (not just the last)
        // and the tool trace WITH outputs; "turn"/"chat" see the final answer +
        // the compact name(args) summary; "chat" adds the conversation so far.
        answer:
          scope === "loop"
            ? allAssistantText(turnMessages) || (view.outputText ?? "")
            : (view.outputText ?? ""),
        tools:
          scope === "loop"
            ? summarizeToolLoop(view.toolCalls)
            : summarizeToolCalls(view.toolCalls),
        conversation: scope === "chat" ? renderChatContext(historyForChat) : undefined,
        sink: opts.sink,
      }),
    ),
  );
}

/** Persist a verdict to the local fast-mirror store. */
async function putLocal(
  latch: Latch,
  ownerTag: string,
  runId: string,
  v: RubricVerdictResult,
  source: RunScore["source"],
  now: number,
): Promise<void> {
  await latch.runScores.put(ownerTag, {
    runId,
    rubricName: v.rubric.name,
    value: v.value,
    comment: v.comment,
    scale: v.rubric.scale,
    source,
    updatedAt: now,
  });
}

/**
 * The online-eval judge: after a live run completes, grade it against the
 * agent's attached rubrics and record each verdict to BOTH Langfuse (the
 * production record, powering /observability) AND the local fast-mirror store
 * (what the chat evals panel reads without ingestion lag). Fired from the
 * telemetry seam's `afterRun` — it must never throw into the turn path, so
 * every failure is logged and swallowed.
 */
export async function judgeLiveRun({
  meta,
  outcome,
}: {
  meta: TelemetryRunMeta<Principal>;
  outcome: TelemetryRunOutcome;
}): Promise<void> {
  // Setup (getLatch + record load) is guarded too: on non-Vercel hosts
  // `afterRun` is awaited directly in the turn's finish path, so a transient
  // DB/store error here must be swallowed — the contract is that a judge pass
  // never disrupts run completion.
  let latch: Latch;
  let due: AttachedEval[];
  let evidence: TurnEvidence;
  try {
    // Lazy import keeps this module load-safe from latch.ts (composition root).
    const { getLatch } = await import("../latch");
    latch = await getLatch();
    const rec = await latch.agentStore.getRecord(meta.principal, meta.agent);
    const evals = rec?.attachedEvals?.filter((e) => e.enabled) ?? [];
    if (evals.length === 0) return;

    const view = extractRunView(outcome.messages);
    if (!view.outputText) return; // nothing judgeable (e.g. pure tool-approval turn)

    // Chat history is only worth a read when some rubric can consume it — a
    // turn-ordinal trigger or a "chat" context scope. Judged post-persist, so
    // the history already contains this turn.
    const needsHistory = evals.some(
      (e) => triggerNeedsTurnOrdinal(e.trigger) || (e.context ?? "turn") === "chat",
    );
    const history = needsHistory
      ? await latch.runtime.loadHistory({ chatId: meta.chatId, principal: meta.principal })
      : [];

    // Per-rubric gate: the trigger must match, and — unless the trigger itself
    // mentions depth — the turn must be top-level. A skipped rubric writes
    // NOTHING (no local row, no Langfuse score), so aggregates only ever
    // average turns the rubric was meant to judge.
    const facts: TriggerFacts = {
      turnOrdinal: turnOrdinalOf(history, meta.runId),
      toolsCalled: view.toolCalls.map((c) => c.name),
      depth: meta.depth,
      chatKind: chatKindOf(meta.chatId),
    };
    due = evals.filter((e) => rubricIsDue(e.trigger, facts));
    if (due.length === 0) return;

    evidence = {
      input: outcome.inputText ?? "",
      view,
      turnMessages: outcome.messages,
      historyForChat: history,
    };
  } catch (e) {
    console.warn(`online judge setup failed (run ${meta.runId}):`, e);
    return;
  }

  const ownerTag = ownerTagOf(meta.principal);
  const now = Date.now();
  await judgeScopeGroups({
    runId: meta.runId,
    modelFor: latch.modelFor,
    rubrics: due,
    evidence,
    sink: async (v) => {
      // Local mirror first (fast, always-on) so the chat evals panel has the
      // verdict even if Langfuse is slow/unreachable — then best-effort to
      // Langfuse. Pinning the score timestamp to the run's start keeps a later
      // human correction an upsert (see postScore's `timestamp`).
      await putLocal(latch, ownerTag, meta.runId, v, "live", now);
      await postScore({
        runId: meta.runId,
        name: v.rubric.name,
        value: v.value,
        comment: v.comment,
        dataType: v.rubric.scale === "binary" ? "BOOLEAN" : "NUMERIC",
        timestamp: meta.startedAt,
      }).catch((e) =>
        console.warn(`postScore "${v.rubric.name}" (run ${meta.runId}) failed:`, e),
      );
    },
  });
}

/** The text of a message's text parts. */
function messageText(m: unknown): string {
  const parts = ((m as { parts?: Record<string, unknown>[] }).parts ?? []);
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/**
 * Re-judge one already-completed run against a (possibly unsaved, draft) rubric
 * set — the chat evals tuning loop. Reconstructs the run's input/answer/tools
 * from stored history (no re-chat), writes verdicts to the LOCAL store only
 * (source "rejudge") so experimentation never pollutes Langfuse/production
 * aggregates, and returns them so the caller can update the UI immediately.
 * Throws only on an unreadable run (caller surfaces it); judge errors per rubric
 * are swallowed inside `evaluateRubrics`.
 */
export async function rejudgeRun(args: {
  principal: Principal;
  chatId: string;
  runId: string;
  rubrics: AttachedEval[];
}): Promise<RubricVerdictResult[]> {
  const { getLatch } = await import("../latch");
  const latch = await getLatch();
  const history = await latch.runtime.loadHistory({
    chatId: args.chatId,
    principal: args.principal,
  });
  const idx = history.findIndex(
    (m) => (m as { metadata?: { runId?: string } }).metadata?.runId === args.runId,
  );
  if (idx < 0) throw new Error(`No readable run "${args.runId}" in this chat.`);

  const view = extractRunView([history[idx]]);
  // Input: the nearest preceding user message's text.
  let input = "";
  for (let i = idx - 1; i >= 0; i--) {
    if ((history[i] as { role?: string }).role === "user") {
      input = messageText(history[i]);
      break;
    }
  }

  // Same gate as the live path, on the SAME facts this run had then — a rubric
  // whose trigger doesn't match this turn is silently absent from the results,
  // exactly like the live judge writing nothing. The drawer only ever opens on
  // a user-facing chat, so depth is derived structurally from the chat id.
  const facts: TriggerFacts = {
    turnOrdinal: turnOrdinalOf(history, args.runId),
    toolsCalled: view.toolCalls.map((c) => c.name),
    depth: args.chatId.startsWith("sub_") ? 1 : 0,
    chatKind: chatKindOf(args.chatId),
  };
  const due = args.rubrics.filter((r) => r.enabled && rubricIsDue(r.trigger, facts));

  const results: RubricVerdictResult[] = [];
  const ownerTag = ownerTagOf(args.principal);
  const now = Date.now();
  await judgeScopeGroups({
    runId: args.runId,
    modelFor: latch.modelFor,
    rubrics: due,
    evidence: {
      input,
      view,
      turnMessages: [history[idx]],
      // "So far" as of the judged turn — not the whole chat's later tail.
      historyForChat: history.slice(0, idx + 1),
    },
    sink: async (v) => {
      // Never let a tuning re-judge clobber a human correction: the human value
      // (and the AI original it preserves) is authoritative. Skip persisting AND
      // returning it, so both the local store and /observability's overlay keep
      // showing the correction.
      const existing = await latch.runScores.getOne(ownerTag, args.runId, v.rubric.name);
      if (existing?.source === "human") return;
      results.push(v);
      await putLocal(latch, ownerTag, args.runId, v, "rejudge", now);
    },
  });
  return results;
}

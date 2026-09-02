import type {
  TelemetryRunMeta,
  TelemetryRunOutcome,
} from "@intentface/latch-core";
import { postScore } from "@intentface/latch-langfuse";
import type { LanguageModel } from "ai";
import type { Principal } from "../session";
import { rubricsOf } from "../agent-store";
import type { AttachedEval } from "../agent-store";
import { evalOwnerOfRecord } from "../agent-store";
import type { CredentialScope } from "../credentials";
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
export interface TurnEvidence {
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
 * Exported for tests only; production callers are in this module.
 */
export async function judgeScopeGroups(opts: {
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
  /** The judged agent's owner key — who may SEE this verdict. */
  evalOwner: string,
  /** The `ownerTagOf` of whoever ran the turn — who PRODUCED it. */
  runOwner: string,
  runId: string,
  v: RubricVerdictResult,
  source: RunScore["source"],
  now: number,
): Promise<void> {
  await latch.runScores.put(evalOwner, {
    runId,
    rubricName: v.rubric.name,
    value: v.value,
    comment: v.comment,
    scale: v.rubric.scale,
    source,
    runOwner,
    updatedAt: now,
  });
}

/**
 * Who owns the verdicts for a run: the owner key of the agent record the name
 * resolved to — the org key for a shared agent, the (org,user) key for a personal
 * one. Falls back to the runner's own tag for a code-registry agent (no row, so
 * nobody administers it and its evals stay with whoever ran it).
 */
function evalOwnerFor(
  principal: Principal,
  record: { scope: CredentialScope } | undefined,
  runOwner: string,
): string {
  return record ? evalOwnerOfRecord(principal, record) : runOwner;
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
  const runOwner = ownerTagOf(meta.principal);
  let latch: Latch;
  let due: AttachedEval[];
  let evidence: TurnEvidence;
  let evalOwner: string;
  try {
    // Lazy import keeps this module load-safe from latch.ts (composition root).
    const { getLatch } = await import("../latch");
    latch = await getLatch();
    const rec = await latch.agentStore.getRecord(meta.principal, meta.agent);
    // File the verdicts under the AGENT's owner, not the runner's — a colleague's
    // run on my agent is graded against MY rubrics, so the result is mine to see.
    evalOwner = evalOwnerFor(meta.principal, rec, runOwner);
    // `rubricsOf` narrows the record's host-opaque `trigger` to the platform type
    // (every write path validated it via validateRubrics).
    const evals = rubricsOf(rec).filter((e) => e.enabled);
    if (evals.length === 0) return;

    const view = extractRunView(outcome.messages);
    // Nothing judgeable (e.g. pure tool-approval turn) — except for a "loop"
    // rubric, whose evidence IS the tool trace + intermediate narration, so a
    // final-text-less turn with tool activity still qualifies (for it alone).
    const anyLoop = evals.some((e) => e.context === "loop");
    if (!view.outputText && !(anyLoop && view.toolCalls.length > 0)) return;

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
    // Without a final answer, only "loop" rubrics have evidence to judge.
    if (!view.outputText) due = due.filter((e) => e.context === "loop");
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
      await putLocal(latch, evalOwner, runOwner, meta.runId, v, "live", now);
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
  // Authoritative, principal-scoped: proves the caller owns the run AND tells us
  // which agent produced it (the eval owner is derived from the agent, never from
  // a client-supplied name).
  const run = await latch.runtime.getRun({ principal: args.principal, runId: args.runId });
  if (!run) throw new Error(`No readable run "${args.runId}".`);
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

  // Same gate as the live path — a rubric whose trigger doesn't match this
  // turn is silently absent from the results, exactly like the live judge
  // writing nothing. Depth isn't persisted on runs, so it's approximated from
  // the chat kind: exact for the drawer's user-facing chats (always depth 0);
  // a nested subagent's true depth (≥2) is unrecoverable here, so a trigger
  // like `depth gte 2` may diverge from the live verdict on a `sub_…` thread.
  const chatKind = chatKindOf(args.chatId);
  const facts: TriggerFacts = {
    turnOrdinal: turnOrdinalOf(history, args.runId),
    toolsCalled: view.toolCalls.map((c) => c.name),
    depth: chatKind === "internal" ? 1 : 0,
    chatKind,
  };
  const due = args.rubrics.filter((r) => r.enabled && rubricIsDue(r.trigger, facts));

  const results: RubricVerdictResult[] = [];
  // Same keying as the live path, so a tuning re-judge lands on the row the live
  // judge wrote instead of forking a second one under the caller's own tag.
  const runOwner = ownerTagOf(args.principal);
  const evalOwner = evalOwnerFor(
    args.principal,
    await latch.agentStore.getRecord(args.principal, run.agent),
    runOwner,
  );
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
      // Check BOTH keys: a pre-split correction sits under the runner's tag, and
      // it must still win over a re-judge that now writes under the agent's key.
      const existing = await latch.runScores.getOne(
        [evalOwner, runOwner],
        args.runId,
        v.rubric.name,
      );
      if (existing?.source === "human") return;
      results.push(v);
      await putLocal(latch, evalOwner, runOwner, args.runId, v, "rejudge", now);
    },
  });
  return results;
}

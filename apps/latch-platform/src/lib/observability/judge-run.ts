import type {
  TelemetryRunMeta,
  TelemetryRunOutcome,
} from "@intentface/latch-core";
import { postScore } from "@intentface/latch-langfuse";
import type { Principal } from "../session";
import type { AttachedEval } from "../agent-store";
import type { getLatch } from "../latch";
import { JUDGE_MODEL_ID, judgeOnce } from "../evals/judge";
import { extractRunView } from "./extract";

type Latch = Awaited<ReturnType<typeof getLatch>>;

/**
 * The online-eval judge: after a live run completes, grade it against the
 * agent's attached rubrics and push each verdict to Langfuse as a score on
 * the run's trace. Fired from the telemetry seam's `afterRun` — it must never
 * throw into the turn path, so every failure is logged and swallowed.
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
  let evals: AttachedEval[];
  let answer: string;
  let input = "";
  let tools = "none";
  try {
    // Lazy import keeps this module load-safe from latch.ts (composition root).
    const { getLatch } = await import("../latch");
    latch = await getLatch();
    const rec = await latch.agentStore.getRecord(meta.principal, meta.agent);
    evals = rec?.attachedEvals?.filter((e) => e.enabled) ?? [];
    if (evals.length === 0) return;

    const view = extractRunView(outcome.messages);
    if (!view.outputText) return; // nothing judgeable (e.g. pure tool-approval turn)
    answer = view.outputText;
    input = outcome.inputText ?? "";
    tools = view.toolNames.length ? view.toolNames.join(", ") : "none";
  } catch (e) {
    console.warn(`online judge setup failed (run ${meta.runId}):`, e);
    return;
  }

  await Promise.all(
    evals.map(async (ev) => {
      try {
        const model = latch.modelFor(ev.judgeModelId ?? JUDGE_MODEL_ID);
        const verdict = await judgeOnce(model, {
          input,
          answer,
          tools,
          criterion: ev.prompt,
          scale: ev.scale,
        });
        if (verdict.error) {
          console.warn(`online judge "${ev.name}" (run ${meta.runId}): ${verdict.error}`);
          return; // infra error → no score, mirroring the batch tier
        }
        await postScore({
          runId: meta.runId,
          name: ev.name,
          value:
            ev.scale === "binary" ? (verdict.pass ? 1 : 0) : (verdict.score ?? 0),
          comment: verdict.reason,
          dataType: ev.scale === "binary" ? "BOOLEAN" : "NUMERIC",
        });
      } catch (e) {
        console.warn(`online judge "${ev.name}" (run ${meta.runId}) failed:`, e);
      }
    }),
  );
}

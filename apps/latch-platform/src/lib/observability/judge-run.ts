import type {
  TelemetryRunMeta,
  TelemetryRunOutcome,
} from "@intentface/latch-core";
import { postScore } from "@intentface/latch-langfuse";
import type { Principal } from "../session";
import { JUDGE_MODEL_ID, judgeOnce } from "../evals/judge";
import { extractRunView } from "./extract";

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
  // Lazy import keeps this module load-safe from latch.ts (composition root).
  const { getLatch } = await import("../latch");
  const { agentStore, modelFor } = await getLatch();

  const rec = await agentStore.getRecord(meta.principal, meta.agent);
  const evals = rec?.attachedEvals?.filter((e) => e.enabled) ?? [];
  if (evals.length === 0) return;

  const { outputText, toolNames } = extractRunView(outcome.messages);
  if (!outputText) return; // nothing judgeable (e.g. pure tool-approval turn)
  const input = outcome.inputText ?? "";
  const tools = toolNames.length ? toolNames.join(", ") : "none";

  await Promise.all(
    evals.map(async (ev) => {
      try {
        const model = modelFor(ev.judgeModelId ?? JUDGE_MODEL_ID);
        const verdict = await judgeOnce(model, {
          input,
          answer: outputText,
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

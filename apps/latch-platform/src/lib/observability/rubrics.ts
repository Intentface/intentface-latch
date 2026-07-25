import type { AttachedEval } from "../agent-store";
import { JUDGE_MODEL_ID } from "../evals/judge";

/**
 * Score names the observability layer treats specially — a rubric may not claim
 * one. `user-feedback` is the 👍/👎 score `listObservabilityFn` pulls out as the
 * feedback rate; a rubric of that name would be absorbed into it (and collide on
 * the derived score id), vanishing from the per-rubric aggregates.
 */
const RESERVED_SCORE_NAMES = new Set(["user-feedback"]);

/**
 * Validation shared by every surface that writes attached rubrics — the Agent
 * Builder's `attach_evals` tool and the chat evals panel's save — so the rules
 * (kebab names, uniqueness, non-empty prompts, ≤7, known judge model) can't
 * drift between them. Returns cleaned rubrics or a single human error string.
 */
export function validateRubrics(
  evals: AttachedEval[],
  knownModelId: (id: string) => boolean,
): { ok: true; rubrics: AttachedEval[] } | { ok: false; error: string } {
  if (evals.length > 7) {
    return { ok: false, error: "At most 7 rubrics (each adds a judge call per run)." };
  }
  // Kebab names double as Langfuse score names — keep them clean + unique.
  const badName = evals.filter((e) => !/^[a-z0-9][a-z0-9-]*$/.test(e.name));
  if (badName.length) {
    return { ok: false, error: `Rubric names must be kebab-case: ${badName.map((e) => e.name).join(", ")}.` };
  }
  const reserved = evals.filter((e) => RESERVED_SCORE_NAMES.has(e.name));
  if (reserved.length) {
    return { ok: false, error: `Reserved score name(s): ${reserved.map((e) => e.name).join(", ")}.` };
  }
  const seen = new Set<string>();
  for (const e of evals) {
    if (seen.has(e.name)) return { ok: false, error: `Duplicate rubric name "${e.name}".` };
    seen.add(e.name);
  }
  const blank = evals.filter((e) => !e.prompt.trim());
  if (blank.length) {
    return { ok: false, error: `Empty rubric prompt in: ${blank.map((e) => e.name).join(", ")}.` };
  }
  const tooLong = evals.filter((e) => e.prompt.length > 1000);
  if (tooLong.length) {
    return { ok: false, error: `Rubric prompt over 1000 chars: ${tooLong.map((e) => e.name).join(", ")}.` };
  }
  // The judge model must exist in the catalog — modelFor() silently falls back
  // to the default model, which would silently change the judge.
  const judgeIds = new Set(evals.map((e) => e.judgeModelId ?? JUDGE_MODEL_ID));
  const missing = [...judgeIds].filter((id) => !knownModelId(id));
  if (missing.length) {
    return { ok: false, error: `Judge model(s) not in the catalog: ${missing.join(", ")}.` };
  }
  return {
    ok: true,
    rubrics: evals.map((e) => ({
      name: e.name,
      prompt: e.prompt.trim(),
      judgeModelId: e.judgeModelId,
      scale: e.scale,
      enabled: e.enabled,
    })),
  };
}

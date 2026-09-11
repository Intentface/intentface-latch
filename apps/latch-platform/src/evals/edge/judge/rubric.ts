/**
 * Edge Eval v0 — Judge v0: the guide's rubric (Step 3, lines 172-200) as one evaluator per
 * dimension (Step 6, line 346: "prefer one evaluator per dimension … disagreements are
 * easier to debug").
 *
 * Every evaluator receives what the guide lists at line 336-344: the user question, the
 * relevant client context (the live client plane), the relevant expert stance (the
 * category's pillar playbook), the candidate answer (turn 2 — the guide's line 206: judge
 * the full recommendation, first-turn quality is separate) and case-specific criteria
 * (none in the pilot; the contract fields plug in here for the benchmark).
 *
 * Wording that must stay verbatim: the client-specificity counterfactual (guide line 350).
 * Two hard failures are deterministic and come from the runner's cell checks, not a judge:
 * `source_or_path_leakage` and `required_memory_write_missing`.
 */
import { z } from "zod";

export type Category = "INSIGHTS" | "INFRA" | "AX" | "CODE";

export const PILLAR_FOR: Record<Category, string> = {
  INFRA: "agent-infra",
  AX: "ax",
  CODE: "agentic-coding-practises",
  INSIGHTS: "insights",
};

export const SCALED_DIMENSIONS = ["decision_quality", "client_specificity", "expert_stance_fidelity", "stage_calibration"] as const;
export const BINARY_DIMENSIONS = ["grounding", "actionability", "decisiveness", "first_turn_quality"] as const;
export type ScaledDimension = (typeof SCALED_DIMENSIONS)[number];
export type BinaryDimension = (typeof BINARY_DIMENSIONS)[number];
export type Dimension = ScaledDimension | BinaryDimension | "hard_failure";

/** The guide's hard-failure vocabulary (line 190-199). Judge-assigned subset + deterministic ones. */
export const JUDGE_HARD_FAILURES = [
  "invented_client_fact",
  "invented_house_stance",
  "missed_required_fact",
  "wrong_stage",
  "failed_to_recommend",
  "unnecessary_clarification",
  "none",
] as const;
export const DETERMINISTIC_HARD_FAILURES = ["source_or_path_leakage", "required_memory_write_missing"] as const;
export type HardFailure = (typeof JUDGE_HARD_FAILURES)[number] | (typeof DETERMINISTIC_HARD_FAILURES)[number];

export const ScaledVerdict = z.object({
  score: z.number().int().min(0).max(3),
  reason: z.string().describe("Two sentences at most: the decisive evidence, quoted or paraphrased from the answer."),
});
export const BinaryVerdict = z.object({
  pass: z.boolean(),
  reason: z.string().describe("Two sentences at most: the decisive evidence."),
});
export const HardFailureVerdict = z.object({
  failure: z.enum(JUDGE_HARD_FAILURES),
  reason: z.string().describe("Two sentences at most. For 'none', say what you checked."),
});

export interface DimensionSpec {
  name: Dimension;
  kind: "scaled" | "binary" | "categorical";
  /** The criterion, phrased for the judge. Scaled ones carry rung anchors 0–3. */
  criterion: string;
  /** What this evaluator judges: the full recommendation (turn 2) or the clarifier (turn 1). */
  target: "turn2" | "turn1";
}

export const DIMENSIONS: DimensionSpec[] = [
  {
    name: "decision_quality",
    kind: "scaled",
    target: "turn2",
    criterion: `Is the recommendation itself good — would a senior AI-strategy advisor who knows this client stand behind it?
0 = wrong or harmful for this client; 1 = defensible but shallow, or hedged into a non-decision; 2 = sound recommendation with a real trade-off named; 3 = the move a strong advisor would make, sequenced against what has to be true first, with the trade-off and the reason both explicit.
Judge the substance, not the polish.`,
  },
  {
    name: "client_specificity",
    kind: "scaled",
    target: "turn2",
    criterion: `Does the advice materially depend on THIS client?
Rule (apply it literally): Mentioning client facts is not personalization. If changing the client would not materially change the recommendation, sequencing, or trade-off, the answer is still generic.
0 = generic best practice; the client could be anyone; 1 = client facts are mentioned but the recommendation would not change if they were different; 2 = at least one of recommendation, sequencing or trade-off genuinely turns on a stated client fact; 3 = the recommendation, its sequencing AND its trade-off all follow from this client's placement, constraints and roadmap, and a different client would get materially different advice.
Use the CLIENT CONTEXT below as the truth about the client. An answer that relies on client facts NOT in the context is inventing, not personalizing — cap it at 1.`,
  },
  {
    name: "expert_stance_fidelity",
    kind: "scaled",
    target: "turn2",
    criterion: `Does the answer correctly apply IF's point of view, as written in the EXPERT STANCE below?
0 = contradicts a stance, or asserts a "house view" the stance does not hold; 1 = compatible with the stance but does not use it — generic consulting advice; 2 = applies at least one stance correctly to this question; 3 = applies the relevant stances precisely, including where the stance says it is wrong or where it does not apply, and does not overreach beyond what the stance supports.
Presenting external or general knowledge as IF's view is a fidelity failure, not a style issue.`,
  },
  {
    name: "stage_calibration",
    kind: "scaled",
    target: "turn2",
    criterion: `Is the advice right for the client's CURRENT stage and aimed at the NEXT rung, per the placement in the CLIENT CONTEXT?
0 = prescribes the ceiling to a team at the floor (or the floor to a team already past it) — wrong stage; 1 = roughly stage-aware but the next step is either too big a leap or re-prescribes something they already have; 2 = anchored on the current rung and aimed at the next, with the prerequisite named; 3 = as 2, and the sequencing explicitly uses the placement's named next rung, confidence and open questions.
An answer that ignores the placement entirely cannot score above 1.`,
  },
  {
    name: "grounding",
    kind: "binary",
    target: "turn2",
    criterion: `Are the important claims supported? pass = every specific fact about the client traces to the CLIENT CONTEXT, every claim attributed to IF traces to the EXPERT STANCE, and anything external is presented as external. fail = at least one important claim is invented, misattributed, or presented with unearned confidence (a specific number, company, tool outcome or client fact with no source in the material below).
Minor stylistic flourishes do not fail this; a single invented client fact or house stance does.`,
  },
  {
    name: "actionability",
    kind: "binary",
    target: "turn2",
    criterion: `Is there a useful next move? pass = the client could start on a concrete, appropriately-scoped step this week and knows what has to be true first. fail = the answer is analysis without a move, or the move is so abstract ("invest in observability") that the client still has to decide what to do.`,
  },
  {
    name: "decisiveness",
    kind: "binary",
    target: "turn2",
    criterion: `Does it recommend rather than survey? pass = one clear recommendation with a reason and a trade-off. fail = a menu of options with no pick, a recommendation buried under so many caveats that no decision is made, or a clarifying question in place of an answer when the follow-up already confirmed the direction.`,
  },
  {
    name: "first_turn_quality",
    kind: "binary",
    target: "turn1",
    criterion: `Judge ONLY the first answer (TURN 1). Edge's first response must be SHORT — five sentences or fewer — and do three things: reflect back what it understood the question to be, name the direction it would take in one sentence (not the full recommendation), and ask exactly ONE sharpening thing (either "is this the direction you want?" or the single missing constraint). pass = all of that, and nothing leaked about internal files, tools or workspaces. fail = gives the full recommendation already, asks more than one thing, exceeds the length, or narrates loading context ("let me pull up…").`,
  },
  {
    name: "hard_failure",
    kind: "categorical",
    target: "turn2",
    criterion: `Pick the single most severe hard failure present in the answer, or "none".
invented_client_fact — states something specific about the client that is not in the CLIENT CONTEXT (numbers, systems, decisions, people).
invented_house_stance — attributes to IF / "our view" a position the EXPERT STANCE does not contain, or contradicts it while claiming it.
missed_required_fact — ignores a client fact in the CONTEXT that decisively changes the recommendation (e.g. recommends metering while the context says engineering capacity is the binding constraint and observability is unbuilt).
wrong_stage — prescribes something for a materially different maturity rung than the placement shows.
failed_to_recommend — no recommendation is made.
unnecessary_clarification — asks a clarifying question although the follow-up already confirmed the direction and the context answers it.
none — none of the above. Check each one before choosing none.`,
  },
];

export const dimensionSchema = (kind: DimensionSpec["kind"]) =>
  kind === "scaled" ? ScaledVerdict : kind === "binary" ? BinaryVerdict : HardFailureVerdict;

/** Stable per-category reference block — first in the prompt so it caches across cells. */
export function referenceBlock(args: { clientContext: string; expertStance: string; pillar: string; caseCriteria?: string }): string {
  return `You are one evaluator inside an automated eval of "Edge", an AI-strategy advisor embedded with one client team. You grade ONE dimension of ONE answer. Judge only that dimension — not overall quality, tone, or anything the criterion does not say. Be literal about the rung anchors. When genuinely ambiguous, score low and say why.

The material below is the truth for this evaluation. The client is fictional; treat the CLIENT CONTEXT as complete: anything about the client that is not in it is unknown, and an answer asserting it is inventing.

=== CLIENT CONTEXT (the client's own context plane; placement first) ===
${args.clientContext}

=== EXPERT STANCE (IF's official playbook for the "${args.pillar}" pillar — the house view this question routes to) ===
${args.expertStance}

=== CASE-SPECIFIC CRITERIA ===
${args.caseCriteria ?? "None for this run (pilot). Judge against the rubric dimension alone."}`;
}

export function cellBlock(args: {
  dimension: DimensionSpec;
  question: string;
  followup: string;
  turn1: string;
  turn2: string;
  tools: string;
}): string {
  const target =
    args.dimension.target === "turn1"
      ? `THE ANSWER UNDER JUDGMENT is TURN 1 below (the first response). Turn 2 is shown only for context.`
      : `THE ANSWER UNDER JUDGMENT is TURN 2 below (the full recommendation after the client confirmed the direction). Turn 1 is context.`;
  return `DIMENSION: ${args.dimension.name}
CRITERION:
${args.dimension.criterion}

${target}

USER QUESTION (turn 1):
${args.question}

TURN 1 — Edge's first response:
${args.turn1 || "(empty)"}

USER FOLLOW-UP (turn 2):
${args.followup}

TURN 2 — Edge's full recommendation:
${args.turn2 || "(empty)"}

TOOLS EDGE CALLED (names only, in order; "(inert)" = the write was accepted but had no effect):
${args.tools || "none"}`;
}

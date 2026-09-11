/**
 * Edge Eval v0 — the PAIRWISE dimension: the one judgment humans and the judge make on the
 * same artefact (plan, approved flow improvement 1).
 *
 * The absolute rubric (rubric.ts) is a diagnostic: nine dimensions, each on its own call,
 * each anchored 0–3 or pass/fail. The humans never see it — they see a blinded pair of
 * recommendations and answer one question: which would you rather the client received?
 * Comparing the two therefore compared different questions. This module is the shared
 * definition of that single question: the two Langfuse score configs the reviewers annotate
 * against, the prompt the judge answers with, and the normalization from a model's reply
 * into the same −2…+2 / one-of-14 value space.
 *
 * Orientation is LEFT-NEGATIVE throughout (−2 = strongly prefer LEFT), exactly as the human
 * config reads in the UI; which arm each side holds is known only from review/pairs.json,
 * so neither the judge nor the reviewer can see it.
 */
import { z } from "zod";

export const PREFERENCE_CONFIG = {
  name: "edge_pairwise_preference",
  description: "Which recommendation would you rather the client received? −2 strong left … +2 strong right. Judge the substance for THIS client, not polish.",
  categories: [
    { label: "strong left", value: -2 },
    { label: "left", value: -1 },
    { label: "tie", value: 0 },
    { label: "right", value: 1 },
    { label: "strong right", value: 2 },
  ],
};

/** One primary reason per judgment; further reasons go in the comment. */
export const REASON_LABELS = [
  "tie_or_no_reason",
  "invented_client_fact",
  "invented_house_stance",
  "missed_required_fact",
  "wrong_stage",
  "failed_to_recommend",
  "unnecessary_clarification",
  "generic_advice",
  "better_grounding",
  "better_sequencing",
  "better_trade_off",
  "more_actionable",
  "more_decisive",
  "style_only",
] as const;
export type ReasonLabel = (typeof REASON_LABELS)[number];

export const REASON_CONFIG = {
  name: "edge_primary_reason",
  description: "The single most important reason for your preference. Put further reasons in the comment.",
  categories: REASON_LABELS.map((label, value) => ({ label, value })),
};

/** Judge-sourced scores are posted under their own names so they never mix with the humans'. */
export const JUDGE_PREFERENCE_SCORE = `${PREFERENCE_CONFIG.name}_judge`;
export const JUDGE_REASON_SCORE = `${REASON_CONFIG.name}_judge`;

/** Tolerant like the rubric's schemas — a "+1", a trailing period or a near-miss label is a normalization job, not a retry. */
export const PairwiseVerdict = z.object({
  preference: z.number().describe("−2 = the LEFT recommendation is clearly better for this client, −1 = somewhat better, 0 = genuinely equivalent, 1 = RIGHT somewhat better, 2 = RIGHT clearly better."),
  primary_reason: z.string().describe(`Exactly one of: ${REASON_LABELS.join(", ")}. The single most important reason for the preference; "tie_or_no_reason" only with preference 0.`),
  reason: z.string().describe("At most 60 words: the decisive difference, quoted or paraphrased from the two answers."),
});

export interface PairwiseValue {
  preference: number;
  primary_reason: ReasonLabel;
}

/** Coerce a verdict into the humans' value space; throws only on the unrecoverable. */
export function normalizePairwise(raw: { preference?: number; primary_reason?: string }): PairwiseValue {
  if (typeof raw.preference !== "number" || Number.isNaN(raw.preference)) throw new Error(`pairwise verdict without a numeric preference: ${JSON.stringify(raw)}`);
  const preference = Math.max(-2, Math.min(2, Math.round(raw.preference)));
  const key = String(raw.primary_reason ?? "")
    .toLowerCase()
    .replace(/[^a-z_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hit = REASON_LABELS.find((r) => key === r) ?? REASON_LABELS.find((r) => key.startsWith(r) || key.includes(r));
  if (!hit) throw new Error(`unrecognized primary_reason "${raw.primary_reason}"`);
  // A reason that contradicts the preference is a coding error on the judge's part, not a
  // verdict to keep: "tie_or_no_reason" with a side picked, or a real reason with a tie.
  if (preference === 0 && hit !== "tie_or_no_reason") return { preference, primary_reason: "tie_or_no_reason" };
  if (preference !== 0 && hit === "tie_or_no_reason") throw new Error(`primary_reason tie_or_no_reason with preference ${preference}`);
  return { preference, primary_reason: hit };
}

/** The LEFT/RIGHT body — byte-identical in intent to the trace the reviewers open. */
export function pairBody(args: { left: { turn1: string; turn2: string }; right: { turn1: string; turn2: string } }): string {
  return [
    `---`,
    `## LEFT`,
    ``,
    `### First response`,
    args.left.turn1,
    ``,
    `### Recommendation`,
    args.left.turn2,
    ``,
    `---`,
    `## RIGHT`,
    ``,
    `### First response`,
    args.right.turn1,
    ``,
    `### Recommendation`,
    args.right.turn2,
  ].join("\n");
}

/** The judge's task block. The reference material (client, stance, contract) is prepended by the caller. */
export function pairwiseBlock(args: {
  question: string;
  followup: string;
  left: { turn1: string; turn2: string };
  right: { turn1: string; turn2: string };
}): string {
  return `DIMENSION: pairwise_preference

You are shown TWO advisors' answers to the same question and the same follow-up, labelled LEFT and RIGHT. They come from different configurations of the same product and the order is randomized; you are not told which is which, and there is no prior about which should win.

Answer the question the human reviewers answer: **which recommendation would you rather the client received?** Judge the SUBSTANCE for this client — is the move right for their stage, does it use their actual facts, does it apply the house stance correctly, is anything invented? Length, formatting, confidence and polish are not merits. An answer that invents a client fact or a house stance is worse than one that is thinner but true.

Scale (left-negative): −2 = LEFT clearly better · −1 = LEFT somewhat better · 0 = genuinely equivalent · 1 = RIGHT somewhat better · 2 = RIGHT clearly better. Use 0 only when you would be indifferent, not as a hedge.

Then give the SINGLE most important reason, one of: ${REASON_LABELS.join(", ")}. The failure-shaped reasons (invented_client_fact, invented_house_stance, missed_required_fact, wrong_stage, failed_to_recommend, unnecessary_clarification, generic_advice) name what the LOSING side did; the strength-shaped ones (better_grounding, better_sequencing, better_trade_off, more_actionable, more_decisive) name what the WINNING side did. "style_only" means the two are equivalent in substance and you preferred one on presentation — a preference you should express as 0 unless the presentation itself changes what the client would do.

USER QUESTION (turn 1):
${args.question}

USER FOLLOW-UP (turn 2):
${args.followup}

${pairBody({ left: args.left, right: args.right })}`;
}

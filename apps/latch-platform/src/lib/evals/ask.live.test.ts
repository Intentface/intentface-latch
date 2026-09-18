import { describe, expect, it } from "vitest";
import { anthropic } from "@ai-sdk/anthropic";
import { askOfTrace, type Question } from "./ask";

/**
 * The same three questions from the CTO-infra-agent case, asked of real
 * transcripts by a REAL evaluation model. The hermetic suite proves the
 * wiring; only this proves the judge actually distinguishes the behaviours —
 * a question that reads well to a human and means nothing to a judge is the
 * failure mode that makes eval suites decorative.
 *
 * Live model calls — skipped unless LIVE_JUDGE=1 (needs ANTHROPIC_API_KEY):
 *   LIVE_JUDGE=1 npx vitest run ask.live
 *
 * Swapping the judge is the `model` line and nothing else:
 *   typeSafeAi.evaluationModel("jev-latest")
 */
const live = process.env.LIVE_JUDGE === "1";

const JUDGE = "claude-haiku-4-5-20251001";

const msg = (role: string, parts: unknown[]) => ({ role, parts });
const ask = (text: string) => msg("user", [{ type: "text", text }]);
const read = (path: string, text: string) => ({
  type: "tool-read_file",
  toolCallId: `t_${path}`,
  input: { path },
  output: { text },
});

const VPC_DOC =
  "VPC limits (us-east-1). Peering connections: 125 per VPC. Route tables: 200 per VPC. " +
  "Requests for an increase go through the platform team.";

/** Read the right doc, answered from it. */
const GROUNDED = [
  ask("What's our VPC peering limit in us-east-1?"),
  msg("assistant", [
    read("docs/networking/vpc-limits.md", VPC_DOC),
    { type: "text", text: "You can have up to 125 peering connections per VPC in us-east-1." },
  ]),
];

/** Read nothing, answered from the model's own memory — the dangerous one. */
const UNGROUNDED = [
  ask("What's our VPC peering limit in us-east-1?"),
  msg("assistant", [
    { type: "text", text: "AWS allows up to 50 peering connections per VPC by default." },
  ]),
];

/** Ambiguous question — the agent asks instead of guessing. */
const ASKED = [
  ask("What's our peering limit?"),
  msg("assistant", [
    { type: "text", text: "Which region are you asking about? The limits differ per region." },
  ]),
];

/** Same ambiguous question — the agent picks a region silently. */
const GUESSED = [
  ask("What's our peering limit?"),
  msg("assistant", [
    read("docs/networking/vpc-limits.md", VPC_DOC),
    { type: "text", text: "It's 125." },
  ]),
];

const QUESTIONS: Record<string, Question> = {
  grounded: {
    ask: "Is every factual claim in the agent's answer supported by the content of a document it actually opened in this conversation?",
  },
  opened_doc: {
    ask: "Did the agent open at least one document before answering?",
  },
  ambiguity: {
    type: "choice",
    ask: "The user's question did not say which region or account tier. What did the agent do?",
    options: {
      asked: "Asked the user to clarify which region or tier, without stating a limit",
      answered: "Stated a specific limit without establishing which region or tier applies",
      not_ambiguous: "The question was not actually ambiguous",
    },
    bad: ["answered"],
  },
};

describe.skipIf(!live)("asking real questions of real transcripts (LIVE)", () => {
  const model = anthropic.evaluationModel(JUDGE);
  const verdictsFor = async (messages: unknown[]) => {
    const { verdicts, usage } = await askOfTrace({ model, messages, questions: QUESTIONS });
    return {
      by: Object.fromEntries(verdicts.map((v) => [v.id, v])),
      usage,
    };
  };

  it("separates an answer grounded in a retrieved document from one invented", async () => {
    const good = await verdictsFor(GROUNDED);
    const bad = await verdictsFor(UNGROUNDED);

    expect(good.by.grounded!.failed).toBe(false);
    expect(good.by.opened_doc!.failed).toBe(false);

    expect(bad.by.grounded!.failed).toBe(true);
    expect(bad.by.opened_doc!.failed).toBe(true);
  }, 60_000);

  it("separates asking for clarification from silently guessing", async () => {
    const asked = await verdictsFor(ASKED);
    const guessed = await verdictsFor(GUESSED);

    expect(asked.by.ambiguity!.answer).toBe("asked");
    expect(asked.by.ambiguity!.failed).toBe(false);

    expect(guessed.by.ambiguity!.answer).toBe("answered");
    expect(guessed.by.ambiguity!.failed).toBe(true);
  }, 60_000);

  it("answers all three questions in one call, and reports what it cost", async () => {
    const { usage } = await verdictsFor(GROUNDED);
    expect(usage.inputTokens).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[live] one 3-question pass: ${JSON.stringify(usage)}`);
  }, 60_000);
});

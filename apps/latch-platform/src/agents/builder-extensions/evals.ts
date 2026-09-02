import { tool } from "ai";
import { z } from "zod";
import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { normalizeAgentName, rubricsOf } from "@/lib/agent-store";
import { validateRubrics } from "@/lib/observability/rubrics";
import { evalSetTools } from "../shared-read-tools";

/**
 * Builder extension: online evals. Attaches LLM-judge rubrics to an agent
 * (persisted on the record as `attachedEvals`, judged on every live run) and
 * delegates rubric drafting to the read-only `eval-author` subagent. Nudges
 * ride on save/test results, where the model actually acts on them.
 */

/** One online-eval rubric to attach to an agent (judged on every live run). */
const ATTACHED_EVAL_INPUT = z.object({
  name: z.string().describe("Kebab-case id — becomes the Langfuse score name (e.g. 'stays-on-topic')."),
  prompt: z
    .string()
    .max(1000)
    .describe(
      "ONE observable quality of a good response, judgeable from the user message, the final answer, and tool NAMES alone.",
    ),
  judgeModelId: z.string().optional().describe("Judge model override; defaults to the pinned judge."),
  scale: z
    .enum(["binary", "score"])
    .default("binary")
    .describe("binary → pass/fail; score → graded 0–1 (only for genuinely graded qualities)."),
  enabled: z.boolean().default(true),
  trigger: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'WHEN the judge runs — a structural predicate tree; omit to judge every turn. Leaves: {"kind":"turn","eq"|"gte"|"lte"|"everyNth":N} (1-based turn # in the chat; everyNth matches turns N, 2N, …), {"kind":"toolCalled","name"?:string}, {"kind":"depth","eq"|"gte"|"lte":N} (0 = top-level; mentioning depth is the ONLY way to judge subagent turns), {"kind":"chatKind","is":"user"|"internal"}. Combinators: {"kind":"all"|"any","of":[…]}, {"kind":"not","of":…}. E.g. greet-on-first-message → {"kind":"turn","eq":1}.',
    ),
  context: z
    .enum(["turn", "chat", "loop"])
    .optional()
    .describe(
      "WHAT the judge sees: turn (default: last user msg + final answer + tool-name summary), chat (plus the conversation so far), loop (this turn full-fidelity: all assistant text + tool calls WITH outputs, subagents as one-line summaries).",
    ),
});

const PROMPT = `EVALS (attach_evals + the eval-author subagent):
test_agent is one ad-hoc trial; ATTACHED EVALS are the continuous version — LLM-judge rubrics that run automatically on EVERY live run of the agent, pushing verdicts to Langfuse as scores. The user watches them land in realtime on the Observability page while using the agent for real. Use them to measure quality on real traffic instead of eyeballing one answer.
- A rubric = {name, prompt, scale, judgeModelId?, enabled}: name is kebab-case (it becomes the score name, e.g. "stays-on-topic"); prompt states ONE observable quality a judge can verify from the user message, the final answer, and tool NAMES alone (never argument values); scale "binary" (pass/fail — prefer it) or "score" (graded 0–1, only for genuinely graded qualities like helpfulness depth).
- DRAFTING IS DELEGATED — never draft rubrics inline. Call spawn_agent(agent: "eval-author") with a compact brief distilled from this conversation: the target agent's name, its purpose, expected behaviors, edge cases, refusal/escalation rules. The eval-author reads the agent's config and connection tools itself and answers with ONLY a JSON array of rubrics matching attach_evals' schema. Show them to the user, apply their edits, then attach_evals (it validates names, prompts, and judge models; it REPLACES the agent's rubric set, so always pass the full list — get_agent shows the current one).
- 3–7 rubrics is the sweet spot — every enabled rubric costs one judge call per live run.
- REVIEWING IS DELEGATED TOO — when scores look off (a rubric always passes, always fails, or judges the wrong thing), continue the SAME eval-author thread with the rubric names and example verdicts/comments from the Observability page; it answers verdicts {name, cause, suggestion} — apply them via attach_evals (rewritten rubrics) or save_agent (when the AGENT's behavior is what's wrong).
- Keep ONE eval-author thread per agent's eval work — reuse the threadId from the first spawn_agent, so the eval-author remembers why each rubric exists.
- WORKFLOW addendum — EVAL IT: once the agent basically works (after TEST IT), offer to attach online evals — brief the eval-author subagent to draft judge rubrics, let the user curate, then attach_evals. From then on every real run gets scored; point the user at the Observability page to watch quality live. When MODIFYING an agent that has attached evals (get_agent shows them), remind the user the Observability page will show whether real-run scores moved.`;

const nudge = (rubrics: { name: string }[], afterTest: boolean): string =>
  rubrics.length > 0
    ? `This agent has online eval(s): ${rubrics.map((e) => e.name).join(", ")} — every live run gets judged; watch scores on the Observability page.`
    : afterTest
      ? "No online evals attached yet. If this test looks good, SUGGEST attaching judge rubrics (delegate drafting to the eval-author, then attach_evals) so every real run gets scored."
      : "No online evals attached yet — after testing, suggest attaching judge rubrics (brief the eval-author) so real usage gets scored on the Observability page.";

export const evalsExtension: AgentBuilderExtension<Principal> = {
  name: "evals",
  promptSections: [PROMPT],
  // Eval drafting + failure diagnosis delegate to the read-only Eval Author
  // (the runtime injects a `spawn_agent` tool for it). It MUST stay
  // read-only: subagent runs are auto-approved, so any write tool on it
  // would bypass the user-approval gates.
  subagents: ["eval-author"],
  reservedNames: ["eval-author"],
  toolApproval: {
    // Attaching persists AND adds a judge call to every live run.
    attach_evals: "user-approval",
  },
  // The record schema keeps `trigger` opaque; if a save carries rubrics, run
  // the platform's real validation so a malformed trigger tree never persists.
  validateSave: async (_principal, record) => {
    if (!record.attachedEvals?.length) return undefined;
    const { getLatch } = await import("@/lib/latch");
    const { models } = await getLatch();
    const valid = validateRubrics(rubricsOf(record), (id) => models.some((m) => m.id === id));
    return valid.ok ? undefined : valid.error;
  },
  decorateSaveResult: async (principal, agentName, result) => {
    const { getLatch } = await import("@/lib/latch");
    const { agentStore } = await getLatch();
    const rubrics = rubricsOf(await agentStore.getRecord(principal, agentName)).filter((e) => e.enabled);
    return {
      ...result,
      attachedEvals: rubrics.map((e) => e.name),
      note: `${String(result.note ?? "")} ${nudge(rubrics, false)}`.trim(),
    };
  },
  decorateTestResult: async (principal, agentName, result) => {
    const { getLatch } = await import("@/lib/latch");
    const { agentStore } = await getLatch();
    const rubrics = rubricsOf(await agentStore.getRecord(principal, agentName)).filter((e) => e.enabled);
    return { ...result, note: nudge(rubrics, true) };
  },
  tools: async (principal) => {
    const { getLatch } = await import("@/lib/latch");
    const { agentStore, models, evalStore } = await getLatch();
    return {
      ...evalSetTools(principal, evalStore),

      attach_evals: tool({
        description:
          "Attach ONLINE evals to an agent: LLM-judge rubrics that run automatically on live runs — every top-level turn by default, or only the turns a rubric's `trigger` selects — pushing verdicts to Langfuse as scores the user watches on the Observability page. REPLACES the agent's current attached evals (pass the full list). Pauses for the user's approval.",
        inputSchema: z.object({
          agentName: z.string().describe("The agent to attach the rubrics to."),
          evals: z
            .array(ATTACHED_EVAL_INPUT)
            .max(7)
            .describe("The FULL set of rubrics (replaces existing). Empty array detaches all."),
        }),
        execute: async ({ agentName, evals }) => {
          const name = normalizeAgentName(agentName);
          const rec = await agentStore.getRecord(principal, name);
          if (!rec) return { error: `No editable agent named "${name}". Use list_agents.` };
          // `trigger` arrives as loose JSON — validateRubrics runs the real AST
          // validation (validateTrigger) and rejects malformed trees with a
          // message the model can act on.
          const valid = validateRubrics(
            evals as unknown as Parameters<typeof validateRubrics>[0],
            (id) => models.some((m) => m.id === id),
          );
          if (!valid.ok) return { error: valid.error };
          const attached = valid.rubrics;
          await agentStore.upsert(principal, { ...rec, attachedEvals: attached });
          return {
            saved: true,
            agentName: name,
            attachedEvals: attached.map((e) => ({ name: e.name, scale: e.scale, enabled: e.enabled })),
            note: "Every completed live run of this agent is now judged against these rubrics; scores appear on the Observability page (and in Langfuse) within seconds of each run.",
          };
        },
      }),
    };
  },
};

import { tool } from "ai";
import { z } from "zod";
import type { TurnWriter } from "@intentface/latch-core";
import { normalizeAgentName } from "@intentface/latch-agent-builder";
import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { collectMatcherPatterns, isRiskyRegex } from "@/lib/evals/grade";
import { JUDGE_MODEL_ID } from "@/lib/evals/judge";
import { repeatsOf, runEvalCases } from "@/lib/evals/run";
import { compactResult, runPassRate } from "@/lib/evals/store";
import type { EvalCase, EvalProgressData, EvalStore } from "@/lib/evals/store";

/**
 * The evals extension for the Agent Builder: eval sets as an agent's
 * regression suite. Contributes the eval tools, the EVALS prompt section, the
 * read-only `eval-author` delegate, and the save/test-time nudges (the model
 * acts on tool results far more reliably than on distant prompt instructions).
 */

/** Personal owner key — same derivation as agent-store's ownerKey(p, "user"). */
export const personalOwner = (p: Principal): string =>
  [p.orgId, p.userId ?? ""].map(encodeURIComponent).join("/");

const EVAL_EXPECTED = z.object({
  assertions: z
    .object({
      contains: z.array(z.string()).optional().describe("Substrings the answer must include (case-insensitive)."),
      notContains: z.array(z.string()).optional().describe("Substrings the answer must NOT include."),
      regex: z.array(z.string()).optional().describe("JS regexes the answer must match."),
    })
    .optional(),
  toolCalls: z
    .array(
      z.object({
        tool: z.string().describe("Tool the agent must call."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Subset of the call\'s args that must match (deep-equal per key). A value of {"$regex": "..."} matches the actual value against the pattern instead — for dynamic values like dates.',
          ),
        maxCalls: z.number().int().min(1).optional().describe("Max times the tool may be called (catches loops)."),
      }),
    )
    .optional(),
  forbiddenTools: z.array(z.string()).optional().describe("Tools the agent must NOT call."),
  toolOrder: z
    .array(z.string())
    .min(2)
    .optional()
    .describe("Tools that must appear in this relative order (other calls may interleave). Use for 'orient before generating' style checks."),
  maxTotalToolCalls: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Budget: max tool calls in the whole case (catches runaway loops)."),
  rubric: z
    .array(z.string())
    .max(5)
    .optional()
    .describe(
      "Plain-language criteria a pinned LLM judge grades (one call per criterion, temperature 0) — for qualities substring checks can't express ('explains WHY, not just what'). A failed criterion fails the case; keep each criterion one observable quality.",
    ),
});

const EVAL_CASE_INPUT = z.object({
  id: z
    .string()
    .optional()
    .describe("Stable id — keep it constant across saves so run history stays comparable. Defaults to a slug of name."),
  name: z.string().describe("Short human label, e.g. 'refund question escalates'."),
  input: z.string().max(4000).describe("The user message to send the agent."),
  expected: EVAL_EXPECTED.describe("At least one of assertions / toolCalls / forbiddenTools."),
  repeats: z
    .number()
    .int()
    .min(2)
    .max(5)
    .optional()
    .describe(
      "Flakiness measurement: run the case N times, pass on a majority, record the pass rate. Only for behaviors observed to be nondeterministic — each repeat costs a full agent run.",
    ),
});

/** The slice of a tool call's options we use: its id + the turn's stream writer. */
type ToolCallEnv = { toolCallId?: string; context?: { writer?: TurnWriter } };

/**
 * The user's eval sets, as a tool — shared between the builder (via this
 * extension) and the eval-author subagent so the two can't drift.
 */
export function listEvalSetsTool(principal: Principal, evalStore: EvalStore) {
  return tool({
    description: "The user's eval sets (optionally for one agent), with their full cases — read before editing a set.",
    inputSchema: z.object({ agentName: z.string().optional() }),
    execute: async ({ agentName }) => {
      const sets = await evalStore.listSets(
        personalOwner(principal),
        agentName ? normalizeAgentName(agentName) : undefined,
      );
      return sets.map((s) => ({ agentName: s.agentName, setName: s.name, cases: s.cases }));
    },
  });
}

const EVALS_PROMPT = `EVALS (save_eval_set / run_evals / list_eval_sets / list_eval_runs + the eval-author subagent):
test_agent is one ad-hoc trial; an EVAL SET is the repeatable version — the agent's regression suite. Use it to prove a change helped instead of eyeballing one answer.
- A case = a name, one user message (input), and checks (expected): assertions on the answer (contains / notContains / regex), toolCalls the agent must make (optionally with an args subset and maxCalls), forbiddenTools, toolOrder (relative order), maxTotalToolCalls (loop budget), and rubric — plain-language criteria graded by a pinned LLM judge for qualities substrings can't express. A failed rubric criterion fails the case like any other check; a judge infra error never does (it shows as a warning). Every case needs at least one check. A case may set repeats (2–5) to measure flakiness: majority verdict + recorded pass rate.
- DRAFTING IS DELEGATED — never draft cases inline. Call spawn_agent(agent: "eval-author") with a compact brief distilled from this conversation: the target agent's name, its purpose, expected behaviors, edge cases, refusal/escalation rules, and anything the user said should be tested. The eval-author reads the agent's config, existing sets, and connection tools itself, and answers with ONLY a JSON array of cases matching save_eval_set's schema. Show those cases to the user, apply their edits, then save_eval_set (its validation catches empty checks and bad regexes). If the answer isn't valid JSON, re-prompt the SAME threadId to reply with only the corrected JSON.
- Keep case ids STABLE across edits (save_eval_set defaults id to a slug of name) — run history is only comparable when ids persist. When a set already exists, tell the eval-author it's an EDIT so it preserves existing ids.
- run_evals runs every case in an isolated safe-mode thread (approval-gated tools stubbed; other tools run for real) and returns per-case pass/fail with reasons plus the score delta vs the previous run. It costs one full agent run per case. The user watches live per-case progress in an in-chat card while it runs — don't re-list every case afterwards; go straight to the failures and what you'll change.
- DIAGNOSIS IS DELEGATED TOO — never read failure transcripts yourself. Continue the SAME eval-author thread (pass its threadId to spawn_agent) with the runId and which cases failed; it reads the transcripts and answers a JSON array of verdicts {caseId, cause, fixTarget: "agent"|"case"|"rubric", suggestion}. Apply them: fixTarget "agent" → fold the suggestion into the instructions and save_agent; fixTarget "case" → update that case and save_eval_set; fixTarget "rubric" → replace that rubric criterion with the suggested wording and save_eval_set. Then run_evals again and report the delta ("8/12 → 11/12"). Iterate until the set passes or the user is satisfied.
- Keep ONE eval-author thread per agent's eval work — reuse the threadId from the first spawn_agent for edits and diagnoses, so the eval-author remembers why each check exists.

EVAL WORKFLOW: once the agent basically works (after the test step), offer to create an eval set — brief the eval-author subagent to draft the cases, let the user curate, save_eval_set, then run_evals. On failures, have the eval-author diagnose (same thread), apply its verdicts, and re-run until the score is good; report each delta. When MODIFYING an agent that has an eval set (list_eval_sets), run_evals after the change to prove it didn't regress anything.`;

/** The live services the eval tools run against, resolved lazily per call. */
async function services() {
  // Lazy import avoids a static import cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  return getLatch();
}

export function evalsExtension(): AgentBuilderExtension<Principal> {
  return {
    name: "evals",
    subagents: ["eval-author"],
    reservedNames: ["eval-author"],
    toolApproval: {
      // Saving persists, running costs one agent run per case.
      save_eval_set: "user-approval",
      run_evals: "user-approval",
    },
    promptSections: [EVALS_PROMPT],

    // Nudges matched to the agent's actual eval state, appended to the
    // save/test tool results.
    decorateSaveResult: async (principal, name, result) => {
      const { evalStore } = await services();
      const sets = await evalStore.listSets(personalOwner(principal), name);
      return {
        ...result,
        evalSets: sets.map((s) => s.name),
        note:
          `${String(result.note ?? "")} ` +
          (sets.length
            ? `This agent has eval set(s): ${sets.map((s) => s.name).join(", ")} — offer to run_evals now to prove this change didn't regress anything.`
            : "No eval set exists yet — after testing, suggest creating one (brief the eval-author) so future changes can be regression-checked."),
      };
    },
    decorateTestResult: async (principal, name, result) => {
      const { evalStore } = await services();
      const sets = await evalStore.listSets(personalOwner(principal), name);
      return {
        ...result,
        note:
          sets.length > 0
            ? `This agent has eval set(s): ${sets.map((s) => s.name).join(", ")} — if you changed the agent, offer run_evals to prove nothing regressed.`
            : "No eval set exists for this agent yet. If this test looks good, SUGGEST creating an eval set to the user (delegate drafting to the eval-author) so future changes can be regression-checked.",
      };
    },

    tools: async (principal) => {
      const { runtime, agentStore, models, modelFor, evalStore } = await services();
      return {
        list_eval_sets: listEvalSetsTool(principal, evalStore),

        save_eval_set: tool({
          description:
            "Create or update a named eval set for an agent (upsert by agentName+setName): repeatable test cases with deterministic checks. Draft the cases yourself from what you know the agent should do — happy paths, edge cases, refusals — and let the user curate. Pauses for the user's approval.",
          inputSchema: z.object({
            agentName: z.string().describe("The agent these cases test."),
            setName: z.string().optional().describe('Set name; defaults to "default".'),
            cases: z.array(EVAL_CASE_INPUT).min(1).max(30),
          }),
          execute: async ({ agentName, setName, cases }) => {
            const agent = normalizeAgentName(agentName);
            const known = new Set((await runtime.listAgents(principal)).map((a) => a.name));
            if (!known.has(agent)) {
              return { error: `Unknown agent "${agent}". Use list_agents.` };
            }
            // A case must carry at least one POPULATED check — `assertions: {}` or
            // empty arrays would create an always-pass case.
            const empty = cases.filter((c) => {
              const a = c.expected.assertions;
              return !(
                a?.contains?.length ||
                a?.notContains?.length ||
                a?.regex?.length ||
                c.expected.toolCalls?.length ||
                c.expected.forbiddenTools?.length ||
                c.expected.toolOrder?.length ||
                c.expected.maxTotalToolCalls != null ||
                c.expected.rubric?.length
              );
            });
            if (empty.length) {
              return { error: `Case(s) with no checks (would always pass): ${empty.map((c) => c.name).join(", ")}.` };
            }
            // Blank check values are as bad as none: `contains: [""]` matches every
            // answer. Reject any blank/whitespace assertion string or tool name.
            const blank = cases.filter((c) => {
              const a = c.expected.assertions;
              return [
                ...(a?.contains ?? []),
                ...(a?.notContains ?? []),
                ...(a?.regex ?? []),
                ...(c.expected.forbiddenTools ?? []),
                ...(c.expected.toolCalls ?? []).map((t) => t.tool),
                ...(c.expected.toolOrder ?? []),
                ...(c.expected.rubric ?? []),
              ].some((s) => s.trim().length === 0);
            });
            if (blank.length) {
              return { error: `Blank assertion value or tool name in case(s): ${blank.map((c) => c.name).join(", ")}.` };
            }
            // Reject unsafe/invalid assertion regexes at save time (ReDoS guard) —
            // the grader also refuses them, but failing here lets you fix the case.
            const badRegex = cases.filter((c) =>
              [
                ...(c.expected.assertions?.regex ?? []),
                // {"$regex": "..."} arg matchers go through the same grader guards.
                ...(c.expected.toolCalls ?? []).flatMap((t) => collectMatcherPatterns(t.args)),
              ].some((r) => {
                if (isRiskyRegex(r)) return true;
                try {
                  new RegExp(r);
                  return false;
                } catch {
                  return true;
                }
              }),
            );
            if (badRegex.length) {
              return {
                error:
                  `Unsafe or invalid regex in case(s): ${badRegex.map((c) => c.name).join(", ")}. ` +
                  "Max 200 chars, no nested quantifiers (e.g. (a+)+); prefer simple patterns or contains.",
              };
            }
            // Stable ids: keep provided ones, slug the rest, dedupe with a suffix.
            const seen = new Set<string>();
            const withIds: EvalCase[] = cases.map((c) => {
              let id = normalizeAgentName(c.id ?? c.name) || "case";
              while (seen.has(id)) id = `${id}-2`;
              seen.add(id);
              return {
                id,
                name: c.name,
                input: c.input,
                expected: c.expected,
                ...(c.repeats ? { repeats: c.repeats } : {}),
              };
            });
            const name = setName?.trim() || "default";
            await evalStore.saveSet({ owner: personalOwner(principal), agentName: agent, name, cases: withIds });
            return {
              saved: true,
              agentName: agent,
              setName: name,
              caseCount: withIds.length,
              note: "Run it with run_evals; keep case ids stable across edits so history stays comparable.",
            };
          },
        }),

        run_evals: tool({
          description:
            "Run an agent's eval set: every case runs in an isolated safe-mode thread (approval-gated tools stubbed, other tools execute for real) and is graded deterministically. Returns per-case pass/fail with reasons plus the delta vs the previous run. Costs one full agent run per case — pauses for the user's approval.",
          inputSchema: z.object({
            agentName: z.string(),
            setName: z.string().optional().describe('Defaults to "default".'),
          }),
          execute: async ({ agentName, setName }, options) => {
            const agent = normalizeAgentName(agentName);
            const name = setName?.trim() || "default";
            const owner = personalOwner(principal);
            const set = await evalStore.getSet(owner, agent, name);
            if (!set) {
              return { error: `No eval set "${name}" for agent "${agent}". Create one with save_eval_set.` };
            }
            // Pin the agent's config so this run stays comparable after edits.
            const records = await agentStore.listRecords(principal);
            const snapshot = records.find((r) => r.name === agent) ?? null;
            const previous = (await evalStore.listRuns(owner, agent, name, 1)).at(0);

            // Rubric criteria need the pinned judge. modelFor() silently falls
            // back to the default model for unknown ids — that would silently
            // change the judge, so check the catalog explicitly and error loudly.
            const needsJudge = set.cases.some((c) => c.expected.rubric?.length);
            if (needsJudge && !models.some((m) => m.id === JUDGE_MODEL_ID)) {
              return {
                error:
                  `This set has rubric criteria, which are graded by the pinned judge model "${JUDGE_MODEL_ID}" — ` +
                  "but it's not in the model catalog (provider key missing or catalog offline). " +
                  "Fix the provider setup or remove the rubric checks.",
              };
            }
            const judgeModel = needsJudge ? modelFor(JUDGE_MODEL_ID) : undefined;

            // Stream live progress into the chat while the cases run: one
            // `data-eval-progress` part, reconciled in place by id, that the
            // EvalRunCard renders (the run takes ~a minute per wave of cases —
            // without this the turn is silent until the tool result lands).
            const env = options as ToolCallEnv;
            const soFar: EvalProgressData["results"] = [];
            // Progress ticks count ATTEMPTS (a case with repeats: 3 is 3 ticks) so
            // the card's counter reflects work done, not just cases resolved.
            const totalAttempts = set.cases.reduce((n, c) => n + repeatsOf(c), 0);
            const writeProgress = (completed: number) => {
              env.context?.writer?.write({
                type: "data-eval-progress",
                id: `evalprog_${env.toolCallId ?? "run"}`,
                data: {
                  toolCallId: env.toolCallId,
                  agentName: agent,
                  setName: name,
                  total: totalAttempts,
                  completed,
                  totalCases: set.cases.length,
                  results: soFar,
                } satisfies EvalProgressData,
              });
            };
            writeProgress(0);

            const results = await runEvalCases({
              runtime,
              principal,
              agent,
              cases: set.cases,
              judgeModel,
              // onResult fires before the same unit's onAttempt tick, so the new
              // row is always included in the very next progress write.
              onResult: (r) => soFar.push(compactResult(r)),
              onAttempt: (completed) => writeProgress(completed),
            });
            const passed = results.filter((r) => r.pass).length;
            const failed = results.length - passed;
            const run = await evalStore.saveRun({
              owner,
              agentName: agent,
              setName: name,
              agentSnapshot: snapshot,
              results,
              passCount: passed,
              failCount: failed,
              // Recorded like agentSnapshot: which judge graded this run's rubrics.
              judgeModelId: needsJudge ? JUDGE_MODEL_ID : null,
            });
            const delta = previous ? passed - previous.passCount : undefined;
            // Attempt-level pass RATE — with repeats in play this moves when a
            // case gets flakier even though its majority verdict (and passCount)
            // doesn't, so run-over-run comparison sees degradation early.
            const passRate = runPassRate(results);
            const prevRate = previous ? runPassRate(previous.results) : undefined;
            const rateDelta = prevRate === undefined ? undefined : Math.round((passRate - prevRate) * 100);
            const hasRepeats = results.some((r) => r.repeats != null);
            return {
              runId: run.id,
              agentName: agent,
              setName: name,
              passed,
              failed,
              total: results.length,
              passRate: Math.round(passRate * 1000) / 1000,
              judgeModelId: needsJudge ? JUDGE_MODEL_ID : undefined,
              previous: previous
                ? {
                    runId: previous.id,
                    passed: previous.passCount,
                    total: previous.passCount + previous.failCount,
                    passRate: prevRate === undefined ? undefined : Math.round(prevRate * 1000) / 1000,
                  }
                : null,
              results: results.map(compactResult),
              summary:
                `${passed}/${results.length} passed` +
                (delta === undefined ? "" : delta === 0 ? " (no change)" : ` (${delta > 0 ? "+" : ""}${delta} vs previous)`) +
                (hasRepeats
                  ? ` · pass rate ${Math.round(passRate * 100)}%` +
                    (rateDelta === undefined ? "" : ` (${rateDelta >= 0 ? "+" : ""}${rateDelta}pp vs previous)`)
                  : ""),
            };
          },
        }),

        list_eval_runs: tool({
          description: "Past eval runs for an agent (newest first) — scores over time, to judge whether changes helped.",
          inputSchema: z.object({
            agentName: z.string(),
            setName: z.string().optional(),
            limit: z.number().optional(),
          }),
          execute: async ({ agentName, setName, limit }) => {
            const runs = await evalStore.listRuns(
              personalOwner(principal),
              normalizeAgentName(agentName),
              setName?.trim() || undefined,
              limit ?? 10,
            );
            return runs.map((r) => ({
              runId: r.id,
              setName: r.setName,
              passed: r.passCount,
              failed: r.failCount,
              total: r.passCount + r.failCount,
              failedCases: r.results.filter((c) => !c.pass).map((c) => c.caseName),
              at: new Date(r.createdAt).toISOString(),
            }));
          },
        }),
      };
    },
  };
}

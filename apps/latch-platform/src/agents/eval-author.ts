import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { sharedReadTools } from "./shared-read-tools";

/**
 * The Eval Author — an internal helper the Agent Builder delegates eval work
 * to, so case drafting and failure-transcript reading don't pollute the
 * builder's context. Spawned via `spawn_agent` (auto-approved, isolated
 * `sub_` thread), it holds READ-ONLY tools by design: subagent runs have no
 * human in the loop, so anything that persists (save_eval_set, save_agent)
 * stays with the builder where user approval gates it.
 *
 * Its answers are a strict JSON contract (see instructions) that the builder
 * feeds into save_eval_set / applies as fixes.
 */

/** One message of a stored transcript, with diagnosis-grade tool-call detail. */
export interface TranscriptMessage {
  role: string;
  text: string;
  toolCalls: { tool: string; args?: unknown; blocked?: boolean; output?: string }[];
}

/** How much of each field survives. Truncation is always MARKED — see below. */
export interface TranscriptLimits {
  /** Assistant/user text per message. */
  text?: number;
  /** Serialized tool result per call. */
  toolOutput?: number;
}

/**
 * Per-message view of a stored transcript: text plus every tool call it made.
 *
 * Truncation is marked with `…[truncated]` rather than silently cutting. A
 * reader — an agent diagnosing a failure, or a judge asked whether an answer
 * was grounded in what the agent retrieved — cannot otherwise tell a short
 * result from a long one that was cut, and will confidently conclude the
 * evidence was missing when it was merely clipped.
 *
 * The defaults suit diagnosis, where the point is a compact overview. Callers
 * that need to READ the evidence (grounding checks) should raise `toolOutput`.
 */
export function transcriptOf(
  messages: unknown[],
  limits: TranscriptLimits = {},
): TranscriptMessage[] {
  const maxText = limits.text ?? 4000;
  const maxToolOutput = limits.toolOutput ?? 500;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);
  return messages.map((m) => {
    const parts = (((m as { parts?: unknown[] }).parts ?? []) as Record<string, unknown>[]);
    const text = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
    const toolCalls: TranscriptMessage["toolCalls"] = [];
    for (const p of parts) {
      const type = p.type as string | undefined;
      if (!type) continue;
      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const toolName =
          typeof p.toolName === "string"
            ? p.toolName
            : type.startsWith("tool-")
              ? type.slice(5)
              : "unknown";
        const blocked = (p.output as { __blocked?: boolean } | undefined)?.__blocked;
        toolCalls.push({
          tool: toolName,
          args: p.input,
          blocked: blocked || undefined,
          output: p.output === undefined ? undefined : clip(JSON.stringify(p.output), maxToolOutput),
        });
      }
    }
    return { role: (m as { role?: string }).role ?? "unknown", text: clip(text, maxText), toolCalls };
  });
}

/** Build the read-only toolset bound to one Principal + the live Latch services. */
async function evalAuthorTools(principal: Principal): Promise<Record<string, unknown>> {
  // Lazy import avoids a static import cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  const { runtime, agentStore, allConnections, evalStore } = await getLatch();

  return {
    ...sharedReadTools(principal, { agentStore, allConnections, evalStore }),

    read_transcript: tool({
      description:
        "Read a thread's full transcript: each message's text plus every tool call it made (name, args, blocked marker, output preview). Use it on a failing case's threadId to see what the agent actually did.",
      inputSchema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }) => {
        const history = await runtime.loadHistory({ chatId: threadId, principal });
        // loadHistory returns [] for unknown AND unowned threads alike — an
        // empty transcript would read as "the agent did nothing" in diagnosis.
        if (history.length === 0) return { error: `No readable thread "${threadId}" (wrong id?).` };
        return transcriptOf(history);
      },
    }),
  };
}

export const evalAuthor = defineAgent<Principal, { orgId: string }>(
  {
    model: anthropic("claude-sonnet-4-6"),
    instructions: `You are the Eval Author — an internal helper the Agent Builder delegates eval work to. You receive one briefing message and reply with structured JSON the builder acts on. Your tools are READ-ONLY; you never save anything — persistence and user approval stay with the Agent Builder.

OUTPUT CONTRACT (hard rule): your FINAL answer must be exactly one fenced \`\`\`json code block and NOTHING else — no preamble, no prose before or after. If you can't complete the task, the block contains {"error": "<one-line reason>"}. If a follow-up message points out your JSON was malformed, reply with ONLY the corrected block.

You author ONLINE EVALS: judge rubrics attached to an agent that run automatically on live runs — a pinned LLM judge grades each qualifying turn and the verdict lands as a score (named after the rubric) the user watches on the Observability page. By default the judge sees the user message, the agent's final answer, and the tool calls it made — each tool NAME with a compact view of its key ARGUMENTS (long values truncated). So criteria about which subagent was delegated to (spawn_agent's agent arg), which tool ran, or what was written are all fair game.

Each rubric may carry two optional CONDITION fields:
- "trigger" — WHEN the judge runs (omit → every turn). A structural predicate tree over facts of the finished turn, never message content. Leaves: {"kind":"turn","eq"|"gte"|"lte"|"everyNth":N} (1-based turn # within the chat; everyNth matches turns N, 2N, …), {"kind":"toolCalled","name"?:string} (name omitted → any tool), {"kind":"depth","eq"|"gte"|"lte":N} (0 = top-level), {"kind":"chatKind","is":"user"|"internal"}. Combinators: {"kind":"all"|"any","of":[…]}, {"kind":"not","of":node}. Rubrics skip subagent (depth>0) turns unless the trigger mentions depth. Examples: greets on first message → {"kind":"turn","eq":1}; spot-check every 5th turn → {"kind":"turn","everyNth":5}.
- "context" — WHAT the judge sees: "turn" (default, described above), "chat" (adds the conversation's user/assistant text so far — for criteria about consistency or not repeating itself), "loop" (this turn full-fidelity: all assistant text plus every tool call WITH its output, subagents as one-line summaries — the only scope where criteria may reference tool OUTPUTS).
Content conditionality ("IF the user asks about pricing…") stays ENGLISH inside the prompt — triggers are structural only. Prefer no trigger and "turn" context unless the criterion genuinely needs otherwise.

You operate in one of two modes, decided by the incoming message:

MODE 1 — AUTHOR (the message is a brief: agent name, purpose, expected behaviors, edge cases, refusal rules).
Ground yourself first: get_agent for the target's instructions/connections/capabilities AND its current attachedEvals (built-in agents aren't editable and won't resolve — then work from the brief alone); list_connection_tools when a rubric depends on which tools exist — never guess a tool name. When the agent already has attached evals, this is an EDIT: keep the names of rubrics you're not changing STABLE (score history in Langfuse is only comparable when names persist) and return the FULL replacement list.
Then answer with a JSON ARRAY of rubrics, each:
  {"name": string, "prompt": string, "judgeModelId"?: string, "scale": "boolean" | "score", "enabled": true, "trigger"?: <trigger tree>, "context"?: "turn" | "chat" | "loop"}
HARD LIMITS (these are SAVE-TIME REJECTIONS, not preferences — a draft that breaks one cannot be stored and the user sees an error instead of your work):
- At most 7 rubrics in the array.
- "name" matches ^[a-z0-9][a-z0-9-]*$ (kebab-case), unique within the array, and is never "user-feedback" (reserved).
- "prompt" is non-empty and AT MOST 1000 CHARACTERS. Count them. A prompt that needs more than 1000 characters is a sign you are measuring more than one thing — split it, do not compress it.
- "context" is exactly one of "turn" | "chat" | "loop"; "scale" is "boolean" | "score".

SPLIT BUNDLED QUALITIES. If the requested quality contains an "and" joining two things a run could satisfy separately, it is TWO rubrics, even when you were asked for one. "uses the tool and follows the format" becomes "uses-search-tool" and "follows-digest-format". Bundling them produces a score nobody can act on: a 0 does not say which half broke, the prompt runs long, and a run that got the data right but the formatting wrong is recorded identically to one that invented the data.

Craft rules:
- 3–7 rubrics covering the qualities that make this agent good: correctness of scope ("answers the question that was asked"), tone, tool discipline ("uses a search tool before claiming facts"), refusal/escalation rules, formatting promises. Every enabled rubric costs one judge call per live run — quality over quantity.
- name: kebab-case, short, stable — it becomes the Langfuse score name ("stays-on-topic", "escalates-refunds").
- prompt: ONE observable quality per rubric, judgeable from the user message + final answer + the tool calls (names + key args). Criteria may reference tool names AND salient argument values (e.g. "delegates to the running-coach-memory-writer subagent via spawn_agent", "writes the run to the runs table"), but not tool OUTPUTS or anything the judge can't see. Write it so a reasonable judge can verify it on ANY real run — unlike test cases there is no fixed input, so avoid criteria that only apply to one scenario ("mentions Paris"); prefer conditionals ("IF the user asks about pricing, quotes exact catalog prices").
- scale: prefer "boolean" (clear pass/fail; "binary" is the same thing under its older name). Use "score" only for genuinely graded qualities ("depth of explanation") — and say in the prompt what 0 and 1 look like.
- When genuinely ambiguous whether a quality is judgeable, leave it out and note it in a rubric prompt you DO include only if observable.

MODE 2 — RUBRIC REVIEW (the message names an agent and pastes rubric names with example verdicts/comments from the Observability page).
Ground yourself with get_agent (instructions + current attachedEvals); use read_transcript on any threadIds the briefing includes to see what the agent actually did. Decide for each problem rubric whether the AGENT misbehaved or the RUBRIC is unjudgeable, too strict, or about the wrong thing (the judge's comments show its read).
Then answer with a JSON ARRAY of verdicts, one per problem rubric:
  {"name": string, "cause": string, "fixTarget": "agent" | "rubric", "suggestion": string}
- cause: one or two sentences on what's actually happening.
- fixTarget "agent": the behavior is wrong → suggestion is the concrete instruction change (quote the sentence(s) to add or rewrite).
- fixTarget "rubric": the behavior is right but the rubric misjudges it → suggestion is the full replacement rubric prompt (same name unless renaming is the fix).
- Never suggest weakening a rubric just to make a genuinely wrong behavior pass.

If a human chats with you directly: briefly explain you're the Agent Builder's eval helper and ask for an authoring brief or rubric-review examples — then still answer in the JSON contract.`,
    toolSources: [
      {
        async open(principal) {
          return { tools: await evalAuthorTools(principal), close: async () => {} };
        },
      },
    ],
    smoothStream: true,
  },
  {
    title: "Eval Author",
    description:
      "Internal helper used by the Agent Builder to draft eval cases and diagnose failed runs. Returns strict JSON.",
  },
);

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

/** Per-message view of a stored transcript: text plus every tool call it made. */
export function transcriptOf(messages: unknown[]): TranscriptMessage[] {
  return messages.map((m) => {
    const parts = (((m as { parts?: unknown[] }).parts ?? []) as Record<string, unknown>[]);
    const text = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
      .slice(0, 4000);
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
          output: p.output === undefined ? undefined : JSON.stringify(p.output).slice(0, 500),
        });
      }
    }
    return { role: (m as { role?: string }).role ?? "unknown", text, toolCalls };
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

You author ONLINE EVALS: judge rubrics attached to an agent that run automatically on EVERY live run — a pinned LLM judge grades the run and the verdict lands as a score (named after the rubric) the user watches on the Observability page. The judge sees the user message, the agent's final answer, and tool NAMES (no args).

You operate in one of two modes, decided by the incoming message:

MODE 1 — AUTHOR (the message is a brief: agent name, purpose, expected behaviors, edge cases, refusal rules).
Ground yourself first: get_agent for the target's instructions/connections/capabilities AND its current attachedEvals (built-in agents aren't editable and won't resolve — then work from the brief alone); list_connection_tools when a rubric depends on which tools exist — never guess a tool name. When the agent already has attached evals, this is an EDIT: keep the names of rubrics you're not changing STABLE (score history in Langfuse is only comparable when names persist) and return the FULL replacement list.
Then answer with a JSON ARRAY of rubrics, each:
  {"name": string, "prompt": string, "judgeModelId"?: string, "scale": "binary" | "score", "enabled": true}
Craft rules:
- 3–7 rubrics covering the qualities that make this agent good: correctness of scope ("answers the question that was asked"), tone, tool discipline ("uses a search tool before claiming facts"), refusal/escalation rules, formatting promises. Every enabled rubric costs one judge call per live run — quality over quantity.
- name: kebab-case, short, stable — it becomes the Langfuse score name ("stays-on-topic", "escalates-refunds").
- prompt: ONE observable quality per rubric, judgeable from the user message + final answer + tool NAMES alone. Never write a criterion about tool ARGUMENT values or anything invisible to the judge. Write it so a reasonable judge can verify it on ANY real run — unlike test cases there is no fixed input, so avoid criteria that only apply to one scenario ("mentions Paris"); prefer conditionals ("IF the user asks about pricing, quotes exact catalog prices").
- scale: prefer "binary" (clear pass/fail). Use "score" only for genuinely graded qualities ("depth of explanation") — and say in the prompt what 0 and 1 look like.
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

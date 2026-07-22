import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { compactResult } from "@/lib/evals/store";
import { personalOwner, sharedReadTools } from "./shared-read-tools";

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

    get_eval_run: tool({
      description:
        "Full results of one eval run by runId: per-case pass/fail, reasons, answer preview, tool calls, and the threadId of each case's transcript (read it with read_transcript).",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        const run = await evalStore.getRun(personalOwner(principal), runId);
        if (!run) return { error: `No eval run "${runId}".` };
        return {
          runId: run.id,
          agentName: run.agentName,
          setName: run.setName,
          passed: run.passCount,
          failed: run.failCount,
          results: run.results.map(compactResult),
        };
      },
    }),

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

You operate in one of two modes, decided by the incoming message:

MODE 1 — AUTHOR (the message is a brief: agent name, purpose, expected behaviors, edge cases, refusal rules).
Ground yourself first: get_agent for the target's instructions/connections/capabilities (built-in agents aren't editable and won't resolve — then work from the brief alone); list_eval_sets to see existing cases (when EDITING a set, keep existing case ids STABLE — run history is only comparable when ids persist); list_connection_tools for the REAL tool names when writing toolCalls / forbiddenTools checks — never guess a tool name.
Then answer with a JSON ARRAY of cases, each:
  {"id"?: string, "name": string, "input": string, "expected": {"assertions"?: {"contains"?: string[], "notContains"?: string[], "regex"?: string[]}, "toolCalls"?: [{"tool": string, "args"?: object, "maxCalls"?: number}], "forbiddenTools"?: string[], "toolOrder"?: string[], "maxTotalToolCalls"?: number}}
Craft rules:
- 5–15 cases covering happy paths, edge cases, ambiguous inputs, and things the agent should refuse or escalate (unless the brief asks otherwise).
- Every case needs at least one POPULATED check — an empty expected would always pass and is rejected at save time.
- Prefer toolCalls checks for tool-using agents (most reliable); args is a SUBSET match, so pin only the arguments that matter. For dynamic values (dates, ids) use a matcher: {"date": {"$regex": "^2026-"}} — same regex limits as assertion regexes.
- toolOrder (≥2 names) checks RELATIVE order ("orient before generating a plan"); other calls may interleave. maxCalls / maxTotalToolCalls bound repeated calls — use when the agent is prone to loops, not by default.
- contains strings: short and distinctive, case-insensitive — models rephrase, so never assert long exact sentences.
- regex: max 200 chars, no nested quantifiers like (a+)+; prefer contains when a plain substring works.
- input is the user message verbatim (max 4000 chars); name is a short human label like "refund question escalates".

MODE 2 — DIAGNOSE (the message names a runId and which cases failed).
Call get_eval_run for the full results, then read_transcript on each failing case's threadId to see what the agent actually said and which tools it called with what args. Decide for each failure whether the AGENT misbehaved or the CASE's check is brittle (behavior right, phrasing/assertion wrong).
Then answer with a JSON ARRAY of verdicts, one per failing case:
  {"caseId": string, "cause": string, "fixTarget": "agent" | "case", "suggestion": string}
- cause: one or two sentences on what actually happened in the transcript.
- fixTarget "agent": the behavior is wrong → suggestion is the concrete instruction change (quote the sentence(s) to add or rewrite).
- fixTarget "case": the behavior is right but the check failed on phrasing → suggestion is the replacement check (e.g. swap a long contains for a distinctive short one, or a toolCalls check).
- Never suggest weakening a check just to make a genuinely wrong behavior pass.

If a human chats with you directly: briefly explain you're the Agent Builder's eval helper and ask for an authoring brief or a runId to diagnose — then still answer in the JSON contract.`,
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

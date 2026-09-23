import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import { transcriptOf } from "./eval-author";

/**
 * The Evals Agent: reads an agent's threads the way a reviewer would, says
 * what went wrong, and helps decide what to do about it.
 *
 * What it may do alone is what costs nothing and changes nothing a person
 * relies on: read results and threads, and PROPOSE notes. A proposed note is
 * a suggestion until a person accepts it on the Failures page — it never
 * counts toward patterns or rulings on its own, because agents miss the
 * failures that take product judgment. It never rules on the judge (that
 * would be the judge grading itself) and never publishes.
 *
 * Every tool takes the name of the agent UNDER TEST; the Evals Agent itself
 * works on the caller's behalf, with the caller's access.
 */

const Agent = z.string().describe("Name of the agent being evaluated, e.g. edge-v2");

async function evalsTools(principal: Principal): Promise<Record<string, unknown>> {
  // Lazy imports avoid a static cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  const { agentOwnerKey, normalizeAgentName } = await import("@/lib/agent-store");
  const { summarize, compareVersions } = await import("@/lib/evals/v2/runner");
  const { runtime, agentStore, evals } = await getLatch();

  /** The owner this agent's eval data lives under — or an error the model can read. */
  const scope = async (agent: string) => {
    const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
    if (!rec) return { error: `No agent "${agent}" that you can edit.` } as const;
    return { owner: agentOwnerKey(principal, rec.scope), name: rec.name, rec } as const;
  };

  return {
    list_question_sets: tool({
      description:
        "The agent's question sets (fixed questions it is evaluated on) and their runs, newest first. Start here to find a run id.",
      inputSchema: z.object({ agent: Agent }),
      execute: async ({ agent }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const sets = await evals.listDatasets(o.owner, o.name);
        const checks = await evals.listRubrics(o.owner, o.name);
        return {
          questionSets: await Promise.all(
            sets.map(async (d) => ({
              id: d.id,
              name: d.name,
              questions: (await evals.listInputs(d.id)).length,
              runs: (await evals.listRuns(o.owner, d.id)).slice(0, 8).map((r) => ({
                runId: r.runId,
                versions: r.versions,
                threads: r.threads,
                at: new Date(r.createdAt).toISOString(),
              })),
            })),
          ),
          checks: checks.map((r) => ({ id: r.id, version: r.version, checks: r.checks.map((c) => `${c.id}: ${c.label}`) })),
        };
      },
    }),

    run_results: tool({
      description:
        "Pass rates per check and version for one run, and the question-by-question comparison between the first two versions (improved/regressed counts, p-value). Use it to see where to look.",
      inputSchema: z.object({ agent: Agent, questionSetId: z.string(), runId: z.string(), checksId: z.string() }),
      execute: async ({ agent, questionSetId, runId, checksId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const rubric = await evals.getRubric(o.owner, checksId);
        if (!rubric) return { error: `No checks "${checksId}".` };
        const threads = await evals.listThreads(o.owner, { datasetId: questionSetId, runId });
        const verdicts = await evals.listVerdicts({ threadIds: threads.map((t) => t.threadId), rubricVersion: rubric.version });
        if (!verdicts.length) return { error: `Run ${runId} has no verdicts for ${checksId} v${rubric.version} yet.` };
        const order = (v: string) => (v === "live" ? "" : v);
        const s = summarize(threads, verdicts, rubric).sort((a, b) => order(a.version).localeCompare(order(b.version)));
        const [a, b] = s.map((x) => x.version);
        return {
          checksVersion: rubric.version,
          versions: s.map((x) => ({
            version: x.version,
            threads: x.threads,
            errored: x.errors,
            checks: x.checks.map((c) => ({
              check: rubric.checks.find((k) => k.id === c.checkId)?.label ?? c.checkId,
              passed: `${c.passed}/${c.total}`,
              everyTry: `${c.allPassed}/${c.inputs} questions`,
              answers: c.answers,
            })),
          })),
          ...(a && b
            ? {
                comparison: compareVersions(threads, verdicts, rubric.checks.map((c) => c.id), a, b).map((c) => ({
                  check: rubric.checks.find((k) => k.id === c.checkId)?.label ?? c.checkId,
                  [`${a}→${b}`]: `+${c.improved} −${c.regressed} of ${c.pairs}`,
                  p: Number(c.p.toFixed(3)),
                })),
              }
            : {}),
        };
      },
    }),

    list_threads: tool({
      description:
        "Threads of a run or question set, with which checks each failed and whether a person or you already noted it. Filter to failures, or to threads nobody has read yet.",
      inputSchema: z.object({
        agent: Agent,
        runId: z.string().optional(),
        questionSetId: z.string().optional(),
        only: z.enum(["all", "failed", "unread"]).default("all"),
        limit: z.number().int().min(1).max(60).default(25),
      }),
      execute: async ({ agent, runId, questionSetId, only, limit }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const threads = (
          await evals.listThreads(o.owner, {
            agentName: o.name,
            ...(runId ? { runId } : {}),
            ...(questionSetId ? { datasetId: questionSetId } : {}),
          })
        ).filter((t) => !t.error);
        const verdicts = await evals.listVerdicts({ threadIds: threads.map((t) => t.threadId) });
        const notes = new Map((await evals.listNotes(o.owner, o.name)).map((n) => [n.threadId, n]));
        const suggested = new Set((await evals.listSuggestions(o.owner, o.name)).map((s) => s.threadId));
        const failedBy = new Map<string, string[]>();
        for (const v of verdicts) if (v.failed) (failedBy.get(v.threadId) ?? failedBy.set(v.threadId, []).get(v.threadId)!).push(v.checkId);
        return threads
          .filter((t) => (only === "failed" ? failedBy.has(t.threadId) : only === "unread" ? !notes.has(t.threadId) && !suggested.has(t.threadId) : true))
          .slice(0, limit)
          .map((t) => {
            const n = notes.get(t.threadId);
            return {
              threadId: t.threadId,
              version: t.version,
              question: t.inputId,
              try: (t.attempt ?? 0) + 1,
              failedChecks: failedBy.get(t.threadId) ?? [],
              note: n ? (n.ok ? "a person marked it fine" : `a person noted: ${n.text}`) : suggested.has(t.threadId) ? "you already suggested a note" : null,
            };
          });
      },
    }),

    read_thread: tool({
      description:
        "Read one thread in full: the question, every message with each tool call (arguments and a preview of what it returned), the answer, what a good answer conveys, and the judge's verdicts. Read before you suggest a note.",
      inputSchema: z.object({ agent: Agent, threadId: z.string() }),
      execute: async ({ agent, threadId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const t = await evals.getThread(o.owner, threadId);
        if (!t) return { error: `No eval thread "${threadId}" for ${o.name}.` };
        const history = await runtime.loadHistory({ chatId: threadId, principal });
        const input = t.datasetId && t.inputId ? (await evals.listInputs(t.datasetId)).find((i) => i.id === t.inputId) : undefined;
        const verdicts = await evals.listVerdicts({ threadIds: [threadId] });
        return {
          version: t.version,
          question: input?.prompt,
          aGoodAnswerConveys: input?.facts?.answer,
          mustNot: input?.facts?.mustNot,
          transcript: transcriptOf(history),
          verdicts: verdicts.map((v) => ({ check: v.checkId, answer: v.answer, failed: v.failed, confidence: v.confidence })),
        };
      },
    }),

    read_agent: tool({
      description: "The agent's configuration — instructions, model, tools — as live, as the unpublished draft, or at a published version.",
      inputSchema: z.object({ agent: Agent, version: z.string().default("live").describe('"live", "@draft" or "@3"') }),
      execute: async ({ agent, version }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const rec =
          version === "live"
            ? o.rec
            : version === "@draft"
              ? (await agentStore.getDraft(principal, o.name, o.rec.scope))?.record
              : await agentStore.getVersion(principal, o.name, o.rec.scope, Number(version.replace("@", "")));
        if (!rec) return { error: `${o.name} has no ${version}.` };
        return { version, model: rec.modelId, instructions: rec.instructions, tools: rec.tools, connections: rec.connections };
      },
    }),

    list_notes: tool({
      description:
        "What people have written about threads (their notes, the ones marked fine), the failure modes found so far, and your own open suggestions.",
      inputSchema: z.object({ agent: Agent }),
      execute: async ({ agent }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const [notes, modes, suggestions] = await Promise.all([
          evals.listNotes(o.owner, o.name),
          evals.listModes(o.owner, o.name),
          evals.listSuggestions(o.owner, o.name),
        ]);
        return {
          notes: notes.map((n) => ({ threadId: n.threadId, ...(n.ok ? { looksFine: true } : { wentWrong: n.text }), mode: modes.find((m) => m.id === n.modeId)?.name })),
          failureModes: modes.map((m) => ({ name: m.name, description: m.description, threads: notes.filter((n) => n.modeId === m.id).length })),
          yourSuggestions: suggestions.map((s) => ({ threadId: s.threadId, status: s.status, ...(s.ok ? { looksFine: true } : { wentWrong: s.text }) })),
        };
      },
    }),

    suggest_note: tool({
      description:
        "Propose a note on a thread you have READ: the first thing that went wrong, as the user would see it — or that it looks fine. A person accepts or rejects it on the Failures page; it counts for nothing until then. Do not suggest on threads a person already noted, or ones whose suggestion was rejected.",
      inputSchema: z.object({
        agent: Agent,
        threadId: z.string(),
        wentWrong: z
          .string()
          .optional()
          .describe("The first thing that went wrong, from the user's side, specific and short. Omit when it looks fine."),
        looksFine: z.boolean().default(false),
        why: z.string().describe("What in the thread shows it — quote or point at the message or tool call."),
      }),
      execute: async ({ agent, threadId, wentWrong, looksFine, why }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        if (!(await evals.getThread(o.owner, threadId))) return { error: `No eval thread "${threadId}".` };
        if ((await evals.listNotes(o.owner, o.name)).some((n) => n.threadId === threadId)) return { error: "A person already noted this thread; theirs stands." };
        const prior = (await evals.listSuggestions(o.owner, o.name)).find((s) => s.threadId === threadId);
        if (prior?.status === "rejected") return { error: "Your earlier suggestion here was rejected; do not propose it again." };
        const text = (wentWrong ?? "").trim();
        if (!text && !looksFine) return { error: "Say what went wrong, or set looksFine." };
        await evals.saveSuggestion({
          owner: o.owner,
          threadId,
          agentName: o.name,
          text: looksFine ? "" : text,
          ok: looksFine,
          why: why.trim(),
          status: "open",
          createdAt: Date.now(),
        });
        return { saved: true, note: "Waiting for a person on the Failures page." };
      },
    }),
  };
}

export const evalsAgent = defineAgent<Principal, { orgId: string }>(
  {
    model: anthropic("claude-sonnet-4-6"),
    instructions: `You help people evaluate their AI agents in Latch. You read conversations ("threads") the agent had on a fixed set of questions, work out what went wrong, and help decide what to do about it.

How to work:
- Find the facts before you speak. list_question_sets → run_results to see where the agent fails → list_threads (only "failed" or "unread") → read_thread. Never describe a thread you have not read.
- When you read a thread, look for the FIRST thing that went wrong, from the user's side: it did not answer what was asked, it asked a question instead of answering, it claimed something no tool returned, it used the wrong tool, it contradicted what a good answer conveys, it broke a must-not. Stop at the first upstream error; later problems usually follow from it.
- Then suggest_note: specific and short ("Recommended WCAG 2.2 as the baseline; the docs say 2.1 AA"), never vague ("answer could be better"). Say why, pointing at the message or tool call. If it looks fine, say so — that is useful too.
- Some failures need knowledge you do not have: what the business wants, what this user needed. When you are unsure, say that in the note's why rather than guessing, and leave it to the person.
- Group what you found only in words; turning notes into failure modes and checks is done on the Failures page once a person has accepted them.

What you never do: accept your own suggestions, rule on whether the judge was right, change or publish the agent, or start runs. Those belong to the person.

Be brief. Lead with what you found ("4 of 6 failures end with a question instead of an answer"), then the evidence. Name threads by question number and version ("#3 on @draft"), not ids, unless asked.`,
    toolSources: [
      {
        async open(principal) {
          return { tools: await evalsTools(principal), close: async () => {} };
        },
      },
    ],
    smoothStream: true,
  },
  {
    title: "Evals",
    description: "Reads an agent's eval threads, finds what went wrong, and suggests notes for you to accept on the Failures page.",
  },
);

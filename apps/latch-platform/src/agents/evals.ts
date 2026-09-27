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

const Question = z.object({
  prompt: z.string().describe("The question, worded the way a real person would ask it"),
  answer: z.string().optional().describe("What a good answer conveys — substance, not wording"),
  mustNot: z.array(z.string()).optional().describe("Things the answer must not do, in plain words"),
  followUps: z.array(z.string()).optional().describe("Further messages in the same thread after the first answer"),
  mustSay: z.array(z.string()).optional().describe("Things the answer must say, in plain words — each graded as a yes/no"),
  decline: z.boolean().optional().describe("True when the right answer is a polite refusal"),
  asks: z.array(z.string()).optional().describe('Yes/no questions for the grader about this answer, e.g. "Is the tone friendly?"'),
  calls: z
    .array(
      z.object({
        tool: z.string().describe("Tool name; * matches anything, e.g. *_read_file"),
        never: z.boolean().optional().describe("True: the tool must NOT be called"),
        match: z
          .array(z.object({ path: z.string().describe('An argument name, or "result"'), op: z.enum(["contains", "equals", "not_contains", "any"]), value: z.string().optional() }))
          .optional(),
      }),
    )
    .optional()
    .describe("Tool calls this input expects, checked exactly from the log"),
  extra: z.string().optional().describe('Other facts as a JSON object, read by checks as {{facts.name}}'),
});

/** Checks are validated by the same rules as the Checks page; the shape here only guides the model. */
const CheckInput = z.object({
  id: z.string().optional().describe("Give it to change an existing check; omit to add one"),
  kind: z.enum(["asked", "counted"]).describe("asked = a question for the judge; counted = a rule over the tool log"),
  label: z.string().describe("What passing means, as the grid shows it"),
  ask: z.string().optional().describe("asked: the question, phrased so yes (or the good options) means the agent did well"),
  shape: z
    .any()
    .optional()
    .describe('asked: {"type":"boolean","bad":"false"} | {"type":"choice","options":{"id":"meaning"},"bad":["id"]} | {"type":"score","levels":[{"name","means"}],"bad":0}'),
  spec: z
    .any()
    .optional()
    .describe('counted: {"op":"called"|"never_called"|"called_with"|"at_least"|"at_most"|"repeated"|"before"|"before_answering"|"stopped_for_approval","tool":"glob", ...}'),
  judge: z.string().optional(),
  because: z.string().optional().describe("Why the check exists"),
});

type QuestionInput = z.infer<typeof Question>;
const editable = (q: QuestionInput, id: string) => ({
  id,
  prompt: q.prompt,
  followUps: q.followUps ?? [],
  answer: q.answer ?? "",
  mustNot: q.mustNot ?? [],
  mustSay: q.mustSay ?? [],
  asks: q.asks ?? [],
  decline: q.decline ?? false,
  calls: q.calls ?? [],
  extra: q.extra ?? "{}",
});


async function evalsTools(principal: Principal): Promise<Record<string, unknown>> {
  // Lazy imports avoid a static cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  const { agentOwnerKey, normalizeAgentName } = await import("@/lib/agent-store");
  const { runtime, agentStore, evals } = await getLatch();
  const { planRun, startPlannedRun } = await import("@/lib/evals-jobs");
  const { groupNotes, draftCheck, addCheckFromMode } = await import("@/lib/failures-actions");
  const { createQuestionSet, editQuestions, createChecks, editChecks, createVariant } = await import("@/lib/evals-actions");
  const { startJudgeJob } = await import("@/lib/evals-jobs");
  const { toEditable } = await import("@/lib/evals/v2/validate");
  const { computeGrid } = await import("@/lib/evals-grid");
  const { cellsOf, columnRate, versus, verdictFor } = await import("@/lib/evals/v2/score");

  /**
   * The Results page, as the person sees it: each column's score (the average
   * input's share of tests passed), how it moved against the baseline input
   * by input, and every cell. Per check comes after, to see where to look.
   */
  const pageView = (g: NonNullable<Awaited<ReturnType<typeof computeGrid>>>) => {
    const cells = cellsOf(g);
    const [base] = g.columns;
    const pct = (r: number | null) => (r === null ? "not graded" : `${Math.round(r * 100)}%`);
    const cellText = (inputId: string, label: string) => {
      const c = cells.get(`${inputId}|${label}`);
      if (!c) return "not answered";
      return c.tries.map((t) => (t.error ? "broke" : t.of ? `${t.pass}/${t.of}` : "not graded")).join(", ");
    };
    const judged = new Set(g.columns.map((c) => c.judgedWith));
    return {
      howToRead:
        "Exactly what the person sees. A cell counts tests — each of an input's own expectations (each expected call, each must-say item) plus the checks every input gets; several tries are listed. A column's score is the average input's share of tests passed. Against the baseline, each input scored higher, lower or the same; the verdict comes from how lopsided that is (Clearly: less than 1 in 20 by chance; Maybe: less than 1 in 4).",
      baseline: base.label,
      columns: g.columns.map((c, i) => {
        const v = i ? versus(g, cells, base.label, c.label) : null;
        const sameSetup = i > 0 && !!c.setup && c.setup === base.setup;
        return {
          result: c.label,
          runId: c.runId,
          version: c.version,
          score: pct(columnRate(g, cells, c.label)),
          ...(v
            ? {
                vsBaseline: {
                  higher: v.up,
                  lower: v.down,
                  same: v.same,
                  verdict: sameSetup ? "Same setup as the baseline — the moves are noise" : verdictFor(v),
                  p: Number(v.p.toFixed(3)),
                },
              }
            : { role: "baseline" }),
          errored: g.errors[i]?.errors ?? 0,
          checksVersion: c.judgedWith,
        };
      }),
      inputs: g.inputs.map((i) => ({
        id: i.id,
        prompt: i.prompt.length > 90 ? `${i.prompt.slice(0, 90)}…` : i.prompt,
        ...Object.fromEntries(g.columns.map((c) => [c.label, cellText(i.id, c.label)])),
      })),
      byCheck: g.checks.map((c) => ({
        check: c.label,
        type: c.type,
        ...Object.fromEntries(g.columns.map((col, i) => [col.label, `${c.cells[i].passed}/${c.cells[i].total} answers`])),
      })),
      ...(g.crossRun ? { caveat: "These results come from different runs, answered at different times; a change outside the agent (documents, tools, the model provider) would show up as a difference too." } : {}),
      ...(judged.size > 1 ? { warning: `The columns were graded under different versions of the checks (${[...judged].join(", ")}). judge_run the older run under the latest checks before trusting the comparison.` } : {}),
    };
  };

  /** Question ids that failed any check in a run — what "re-run the failures" means. */
  const failedQuestions = async (owner: string, runId: string) => {
    const threads = await evals.listThreads(owner, { runId });
    const verdicts = await evals.listVerdicts({ threadIds: threads.map((t) => t.threadId) });
    const failed = new Set(verdicts.filter((v) => v.failed).map((v) => v.threadId));
    return [...new Set(threads.filter((t) => failed.has(t.threadId) && t.inputId).map((t) => t.inputId!))];
  };
  const modeByName = async (owner: string, name: string, mode: string) =>
    (await evals.listModes(owner, name)).find((m) => m.id === mode || m.name.toLowerCase() === mode.toLowerCase());

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
                ...(r.name ? { name: r.name } : {}),
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
        "One run as the Results page shows it: each version's score, how it moved against the first version (live, if it ran) input by input and the verdict, every cell, then per check. Use it to see where to look.",
      inputSchema: z.object({ agent: Agent, questionSetId: z.string(), runId: z.string(), checksId: z.string() }),
      execute: async ({ agent, questionSetId, runId, checksId }) => {
        const g = await computeGrid(principal, { agent, datasetId: questionSetId, rubricId: checksId, runId });
        if (!g) return { error: `No results for run ${runId}: check the agent, question set, checks and run id.` };
        if ("error" in g) return g;
        if (g.runId !== runId) return { error: `Run ${runId} is not a run of this question set.` };
        return pageView(g);
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
      description:
        "The agent's configuration — instructions, model, its connection tools AND the built-in tools its settings switch on (sandbox, default tools, web, memory, authored tools, subagents) — as live, as the unpublished draft, or at a published version. Read it before writing questions, so they exercise what the agent can actually do.",
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
        const { builtInToolsOf } = await import("@/lib/agent-tools");
        return {
          version,
          model: rec.modelId,
          instructions: rec.instructions,
          connections: rec.connections,
          /** Tools from its connections: which are enabled, how described, which need approval. */
          connectionTools: rec.tools,
          /** Tools its settings switch on — sandbox, default tools, web, memory, authored, subagents. It can use these too. */
          builtInTools: builtInToolsOf(rec),
          ...(rec.exec?.effort ? { reasoningEffort: rec.exec.effort } : {}),
        };
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

    find_patterns: tool({
      description:
        "Group the notes PEOPLE have accepted into failure modes with counts (one small model call). Needs at least 5 notes. Your open suggestions do not count until accepted.",
      inputSchema: z.object({ agent: Agent }),
      execute: async ({ agent }) => groupNotes(principal, agent),
    }),

    triage: tool({
      description:
        "Record what to do about a failure mode: 'fix' when the cause is plain (a missing or wrong instruction, a broken tool) and a change should just be made and re-run; 'measure' when it is subjective, recurring or risky and needs a check; 'leave' when it is rare or harmless. A person's decision always wins over yours.",
      inputSchema: z.object({
        agent: Agent,
        mode: z.string().describe("Failure mode name or id"),
        decision: z.enum(["fix", "measure", "leave"]),
        why: z.string().describe("One or two sentences, pointing at the evidence."),
      }),
      execute: async ({ agent, mode, decision, why }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const m = await modeByName(o.owner, o.name, mode);
        if (!m) return { error: `No failure mode "${mode}". Use list_notes to see them.` };
        const ok = await evals.decideMode(o.owner, m.id, { decision, why, by: "agent" });
        return ok ? { saved: true } : { error: `A person already decided "${m.decision}" for this mode; theirs stands.` };
      },
    }),

    estimate_run: tool({
      description:
        "What a run would cost, priced from what this question set's earlier threads cost. Free. Call it before start_run and pass the cost it returns.",
      inputSchema: z.object({
        agent: Agent,
        questionSetId: z.string(),
        checksId: z.string(),
        versions: z.array(z.string()).describe('e.g. ["live", "@draft"]'),
        questions: z.array(z.string()).optional().describe("Question ids; omit with onlyFailedIn or for all"),
        onlyFailedIn: z.string().optional().describe("A run id: re-run only the questions that failed a check in it"),
        repeats: z.number().int().min(1).max(5).default(1),
      }),
      execute: async ({ agent, questionSetId, checksId, versions, questions, onlyFailedIn, repeats }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const inputIds = onlyFailedIn
          ? await failedQuestions(o.owner, onlyFailedIn)
          : questions ?? (await evals.listInputs(questionSetId)).map((i) => i.id);
        const p = await planRun(principal, { agent, datasetId: questionSetId, rubricId: checksId, versions, inputIds, repeats });
        if (!p.ok) return p;
        return {
          questions: p.inputIds,
          agentRuns: p.estimate.agentRuns,
          judgeCalls: p.estimate.judgeCalls,
          estimatedCost: p.estimate.cost,
          basis: p.estimate.basis,
          ...(p.same.length ? { warning: `${p.same.join(", ")} is the same configuration as another version picked; comparing them measures noise.` } : {}),
          ...(p.reusable.length
            ? {
                alreadyAnswered: p.reusable.map((r) => ({
                  version: r.version,
                  runId: r.runId,
                  answeredAs: r.as,
                  on: new Date(r.at).toISOString().slice(0, 10),
                })),
                note: "These versions have not changed since a run that already answered every one of these questions. Leave them out of start_run and pass them as compareWith instead, unless something outside the agent may have changed since (documents, tools, connections) or the person asks for a fresh baseline.",
              }
            : {}),
        };
      },
    }),

    start_run: tool({
      description:
        "Run questions against versions and judge them. Costs money, so a person approves it first — put the plan and the cost from estimate_run in `summary`. Returns a job id; follow it with job_status.",
      inputSchema: z.object({
        summary: z.string().describe('For the person approving, e.g. "Re-run the 4 questions that failed, on live and @draft, once each: 8 agent runs, about $0.60."'),
        name: z.string().optional().describe('What the run tests, as the Run picker will show it, e.g. "stricter read-failure rule"'),
        agent: Agent,
        questionSetId: z.string(),
        checksId: z.string(),
        versions: z.array(z.string()),
        questions: z.array(z.string()).describe("Question ids, as estimate_run returned them"),
        repeats: z.number().int().min(1).max(5).default(1),
        estimatedCost: z.number().nullable().describe("The cost estimate_run returned"),
        compareWith: z
          .array(z.object({ runId: z.string(), version: z.string() }))
          .optional()
          .describe("Existing results to compare the new ones against (baseline first), from estimate_run's alreadyAnswered — versions you did not re-run"),
      }),
      execute: async ({ agent, questionSetId, checksId, versions, questions, repeats, estimatedCost, name, compareWith }) => {
        const r = await startPlannedRun(
          principal,
          { agent, datasetId: questionSetId, rubricId: checksId, versions, inputIds: questions, repeats, ...(name ? { name } : {}), ...(compareWith?.length ? { compareWith } : {}) },
          estimatedCost,
        );
        return r.ok
          ? {
              jobId: r.id,
              runId: r.id,
              estimatedCost: r.estimate.cost,
              next: compareWith?.length
                ? `Call job_status until it is done, then compare_results with ${JSON.stringify([...compareWith, ...versions.map((version) => ({ runId: r.id, version }))])}.`
                : "Call job_status until it is done.",
            }
          : r;
      },
    }),

    job_status: tool({
      description: "How a run is going: running, judging, done, failed or cancelled, with progress. When done, use run_results with its run id.",
      inputSchema: z.object({ agent: Agent, jobId: z.string() }),
      execute: async ({ agent, jobId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const j = await evals.getJob(o.owner, jobId);
        if (!j) return { error: `No job "${jobId}".` };
        return { status: j.status, done: `${j.done}/${j.total}`, failedToRun: j.failed, runId: j.runId, ...(j.error ? { error: j.error } : {}) };
      },
    }),

    propose_fix: tool({
      description:
        "Change the agent's instructions in its unpublished DRAFT (@draft) — never the live agent. Each edit replaces one exact passage (quote it from read_agent) or appends. A person approves the diff first, and only a person publishes. Then compare live and @draft with estimate_run/start_run on the questions that failed.",
      inputSchema: z.object({
        summary: z.string().describe("For the person approving: what changes and which failure it should fix."),
        agent: Agent,
        edits: z
          .array(
            z.object({
              find: z.string().optional().describe("Exact passage to replace, copied from the current draft (or live if there is no draft). Omit to append."),
              replace: z.string().describe("The new text"),
            }),
          )
          .min(1),
      }),
      execute: async ({ agent, edits }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const draft = await agentStore.getDraft(principal, o.name, o.rec.scope);
        const base = draft?.record ?? o.rec;
        let instructions = base.instructions;
        for (const e of edits) {
          if (!e.find) {
            instructions = `${instructions.trimEnd()}\n\n${e.replace.trim()}`;
            continue;
          }
          const at = instructions.indexOf(e.find);
          if (at < 0) return { error: `Passage not found in the ${draft ? "draft" : "live"} instructions: "${e.find.slice(0, 80)}…". Read them again with read_agent.` };
          if (instructions.indexOf(e.find, at + 1) >= 0) return { error: `Passage appears more than once; quote more of it: "${e.find.slice(0, 80)}…"` };
          instructions = instructions.slice(0, at) + e.replace + instructions.slice(at + e.find.length);
        }
        const published = (await agentStore.listVersions(principal, o.name, o.rec.scope)).find((v) => v.published)?.version;
        await agentStore.saveDraft(principal, o.name, o.rec.scope, { ...base, instructions }, draft?.baseVersion ?? published);
        return { saved: "@draft", startedFrom: draft ? "the existing draft" : "live", note: "Not published. A person publishes from the agent editor." };
      },
    }),

    propose_check: tool({
      description: "Draft a yes/no check that would catch a failure mode, from the notes behind it. Nothing is saved; show the person the draft.",
      inputSchema: z.object({ agent: Agent, mode: z.string().describe("Failure mode name or id") }),
      execute: async ({ agent, mode }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const m = await modeByName(o.owner, o.name, mode);
        if (!m) return { error: `No failure mode "${mode}".` };
        const r = await draftCheck(principal, { agent, modeId: m.id });
        return r.ok ? { label: r.draft.label, ask: r.draft.ask, basedOnNotes: r.examples, checks: r.rubrics } : r;
      },
    }),

    add_check: tool({
      description:
        "Add a check to a set of checks as a new version. The notes behind the failure mode become its first rulings (noted threads fail, threads marked fine pass). A person approves it first.",
      inputSchema: z.object({
        summary: z.string().describe("For the person approving: the check and where it goes."),
        agent: Agent,
        mode: z.string(),
        checksId: z.string(),
        label: z.string(),
        ask: z.string().describe("Yes/no question; yes means the agent did well"),
      }),
      execute: async ({ agent, mode, checksId, label, ask }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const m = await modeByName(o.owner, o.name, mode);
        if (!m) return { error: `No failure mode "${mode}".` };
        const r = await addCheckFromMode(principal, { agent, modeId: m.id, rubricId: checksId, label, ask });
        return r.ok ? { ...r, next: `Nothing has judged v${r.version} yet. Judge a run with it from the Results page.` } : r;
      },
    }),

    list_questions: tool({
      description: "Every question in a set: the prompt, follow-ups, what a good answer conveys, must-nots, expected tool calls, and other facts.",
      inputSchema: z.object({ agent: Agent, questionSetId: z.string() }),
      execute: async ({ agent, questionSetId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const set = await evals.getDataset(o.owner, questionSetId);
        if (!set) return { error: `No question set "${questionSetId}".` };
        return {
          name: set.name,
          whoIsAsking: set.audience ?? null,
          howAnswersShouldRead: set.note ?? null,
          questions: (await evals.listInputs(set.id)).map(toEditable),
        };
      },
    }),

    create_question_set: tool({
      description: "Start a new question set for the agent, optionally with its first questions. A person approves it first.",
      inputSchema: z.object({
        summary: z.string().describe("For the person approving: what the set is for and how many questions."),
        agent: Agent,
        name: z.string(),
        whoIsAsking: z.string().optional().describe("One line: the audience, e.g. 'a product lead at a client, not an engineer'"),
        howAnswersShouldRead: z.string().optional().describe("E.g. 'free-standing advice; never cites the source'"),
        questions: z.array(Question).optional(),
      }),
      execute: async ({ agent, name, whoIsAsking, howAnswersShouldRead, questions }) =>
        createQuestionSet(principal, {
          agent,
          name,
          ...(whoIsAsking ? { audience: whoIsAsking } : {}),
          ...(howAnswersShouldRead ? { note: howAnswersShouldRead } : {}),
          questions: (questions ?? []).map((q, i) => editable(q, String(i + 1))),
        }),
    }),

    edit_questions: tool({
      description:
        "Add, change or delete questions in a set, or change who is asking / how answers should read. A question keeps its id when changed; give an id to change one, omit it to add. A person approves it first.",
      inputSchema: z.object({
        summary: z.string().describe("For the person approving: what changes and why."),
        agent: Agent,
        questionSetId: z.string(),
        upserts: z.array(Question.extend({ id: z.string().optional() })).optional(),
        deletes: z.array(z.string()).optional().describe("Question ids to delete"),
        whoIsAsking: z.string().optional(),
        howAnswersShouldRead: z.string().optional(),
      }),
      execute: async ({ agent, questionSetId, upserts, deletes, whoIsAsking, howAnswersShouldRead }) =>
        editQuestions(principal, {
          agent,
          questionSetId,
          upserts: (upserts ?? []).map((q) => ({ ...editable(q, q.id ?? ""), ...(q.id ? { id: q.id } : { id: undefined }) })),
          ...(deletes ? { deletes } : {}),
          ...(whoIsAsking !== undefined ? { audience: whoIsAsking } : {}),
          ...(howAnswersShouldRead !== undefined ? { note: howAnswersShouldRead } : {}),
        }),
    }),

    list_checks: tool({
      description: "Every check in a set of checks, in full (question and answer shape for judge checks, rule for tool-log checks), and its version.",
      inputSchema: z.object({ agent: Agent, checksId: z.string() }),
      execute: async ({ agent, checksId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const r = await evals.getRubric(o.owner, checksId);
        return r ? { version: r.version, defaultJudge: r.defaultJudge, checks: r.checks } : { error: `No checks "${checksId}".` };
      },
    }),

    create_checks: tool({
      description: "Start a new set of checks for the agent (with one starter check if you give none). A person approves it first.",
      inputSchema: z.object({ summary: z.string(), agent: Agent, name: z.string(), checks: z.array(CheckInput).optional() }),
      execute: async ({ agent, name, checks }) =>
        createChecks(principal, { agent, name, ...(checks?.length ? { checks: checks.map((c, i) => ({ ...c, id: c.id ?? `check-${i + 1}` }) as never) } : {}) }),
    }),

    edit_checks: tool({
      description:
        "Add, change or delete checks. Saves a new version; earlier results stay with the version that produced them, and nothing is scored under the new one until judge_run. Give an id to change a check, omit it to add. A person approves it first.",
      inputSchema: z.object({
        summary: z.string().describe("For the person approving: what changes and why."),
        agent: Agent,
        checksId: z.string(),
        upserts: z.array(CheckInput).optional(),
        deletes: z.array(z.string()).optional().describe("Check ids to delete"),
      }),
      execute: async ({ agent, checksId, upserts, deletes }) =>
        editChecks(principal, { agent, checksId, ...(upserts ? { upserts } : {}), ...(deletes ? { deletes } : {}) }),
    }),

    list_variants: tool({
      description: "The agent's saved variants — versions with one thing changed (model, reasoning effort, an added instruction line). Run one with estimate_run/start_run using version `~<id>`.",
      inputSchema: z.object({ agent: Agent }),
      execute: async ({ agent }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        return (await evals.listVariants(o.owner, o.name)).map((v) => ({ id: v.id, runAs: `~${v.id}`, name: v.name, base: v.base, change: v.change }));
      },
    }),

    create_variant: tool({
      description:
        "Save a variant: a version (live, @draft, @3) with ONE thing changed — the model, the reasoning effort, or a line added to the instructions — to run as its own column without saving a version or touching @draft. Free; returns `runAs` for estimate_run/start_run.",
      inputSchema: z.object({
        agent: Agent,
        base: z.string().describe('The version it starts from: "live", "@draft", "@3"'),
        model: z.string().optional().describe("A model id to run on instead"),
        effort: z.enum(["minimal", "low", "medium", "high"]).optional().describe("Reasoning effort instead"),
        addInstructions: z.string().optional().describe("A line appended to the instructions"),
      }),
      execute: async ({ agent, base, model, effort, addInstructions }) => {
        const r = await createVariant(principal, { agent, base, change: { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(addInstructions ? { addInstructions } : {}) } });
        return r.ok ? { ...r, runAs: `~${r.id}`, next: "estimate_run with versions [runAs] on the inputs it should fix, then start_run." } : r;
      },
    }),

    compare_results: tool({
      description:
        "Compare results from any runs exactly as the Results page shows them: the first is the baseline; each column's score, how many inputs scored higher or lower than the baseline and the verdict, every cell, then per check. Use it for a new @draft result against a live result from an earlier run, so live need not run again.",
      inputSchema: z.object({
        agent: Agent,
        questionSetId: z.string(),
        checksId: z.string(),
        results: z.array(z.object({ runId: z.string(), version: z.string() })).min(2).max(6).describe("Baseline first"),
      }),
      execute: async ({ agent, questionSetId, checksId, results }) => {
        const g = await computeGrid(principal, { agent, datasetId: questionSetId, rubricId: checksId, columns: results });
        if (!g) return { error: "Nothing to compare: check the agent, question set, checks and run ids." };
        if ("error" in g) return g;
        return pageView(g);
      },
    }),

    judge_run: tool({
      description:
        "Re-judge an existing run under the latest version of a set of checks. Only the judge runs, never the agent, so it costs a few cents. Follow it with job_status.",
      inputSchema: z.object({ agent: Agent, questionSetId: z.string(), checksId: z.string(), runId: z.string() }),
      execute: async ({ agent, questionSetId, checksId, runId }) => {
        const r = await startJudgeJob(principal, { agent, datasetId: questionSetId, rubricId: checksId, runId });
        return r.ok ? { jobId: r.id, next: "Call job_status until it is done, then run_results." } : r;
      },
    }),

    stop_run: tool({
      description: "Stop a run or judging job. Threads already running finish and are kept; nothing new starts.",
      inputSchema: z.object({ agent: Agent, jobId: z.string() }),
      execute: async ({ agent, jobId }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const j = await evals.getJob(o.owner, jobId);
        if (!j || (j.status !== "running" && j.status !== "judging")) return { error: "That job is not running." };
        await evals.updateJob(jobId, { status: "cancelled", updatedAt: Date.now() });
        return { stopped: true };
      },
    }),

    rename_failure_mode: tool({
      description: "Give a failure mode a clearer name or description.",
      inputSchema: z.object({ agent: Agent, mode: z.string(), name: z.string(), description: z.string() }),
      execute: async ({ agent, mode, name, description }) => {
        const o = await scope(agent);
        if ("error" in o) return o;
        const m = await modeByName(o.owner, o.name, mode);
        if (!m) return { error: `No failure mode "${mode}".` };
        await evals.updateMode(o.owner, m.id, { name, description });
        return { saved: true };
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
    // Reading threads for the failure that takes judgment, and deciding
    // whether a fix is real, is the hard part of evals — worth the strongest model.
    model: anthropic("claude-opus-5-5"),
    instructions: `You help people evaluate their AI agents in Latch. You read conversations ("threads") the agent had on a fixed set of questions, work out what went wrong, and help decide what to do about it.

How to work:
- Find the facts before you speak. list_question_sets → run_results to see where the agent fails → list_threads (only "failed" or "unread") → read_thread. Never describe a thread you have not read.
- When you read a thread, look for the FIRST thing that went wrong, from the user's side: it did not answer what was asked, it asked a question instead of answering, it claimed something no tool returned, it used the wrong tool, it contradicted what a good answer conveys, it broke a must-not. Stop at the first upstream error; later problems usually follow from it.
- Then suggest_note: specific and short ("Recommended WCAG 2.2 as the baseline; the docs say 2.1 AA"), never vague ("answer could be better"). Say why, pointing at the message or tool call. If it looks fine, say so — that is useful too.
- Some failures need knowledge you do not have: what the business wants, what this user needed. When you are unsure, say that in the note's why rather than guessing, and leave it to the person.

Deciding what to do (after people have accepted notes): find_patterns, then triage each failure mode.
- "fix" when the cause is plain — an instruction that is missing, wrong or ambiguous; a tool that fails. Do not build a check for these: propose_fix on @draft, then re-run ONLY the questions that failed (estimate_run with onlyFailedIn) on @draft, and report question by question whether it helped and whether anything got worse.
- Do not re-run a baseline that has not changed. estimate_run says when a version (usually live) already answered these questions in an earlier run (alreadyAnswered): run only the changed version, pass the old result as compareWith, then compare_results. Re-run the baseline only when something outside the agent may have changed since (its documents, tools, connections, or a long time), when the person asks, or when a result came from a different number of tries; say that the comparison spans runs.
- "measure" when it is subjective, recurring or risky — something that could come back after other changes. propose_check, show the person the draft, and add_check once they agree.
- "leave" when it is rare and harmless. Say so; not every failure is worth effort.
A fix is judged by whether the failed questions pass now without others breaking — a handful of re-runs cannot prove it; say how many questions it rests on, and when a full run would be worth its cost.

Money and changes: estimate_run is free; always call it and put the cost in start_run's summary. start_run, propose_fix and add_check wait for the person's approval. propose_fix only ever writes @draft.

The tests themselves: you can read, create and edit question sets (list_questions, create_question_set, edit_questions) and checks (list_checks, create_checks, edit_checks), each behind the person's approval. Never loosen a check or a question so that a failing agent passes — the tests measure the agent, not the other way round. Change a test when it is wrong: it asks the wrong thing, a good answer it describes is out of date, or it cannot be judged from the thread; say which. After editing checks, judge_run re-scores a run under the new version (judge only, a few cents).

Writing a judge check — pick what the judge returns, in JEV's three types:
- yes/no ({"type":"boolean"}): one true-or-false statement about the answer. Phrase it so yes is good. The judge returns P(yes); 0.5 means it is unsure.
- choice ({"type":"choice","options":{...},"bad":[...]}): one of a set of labels with no order — where the substance came from, which kind of mistake. The label IS the diagnosis, so name labels by what happened (answered_it, answered_adjacent, too_generic). Add an "other" label when the list may not be exhaustive, and mark which labels fail.
- score ({"type":"score","levels":[...],"bad":n}): a place on an ordered spectrum, worst first — too short / about right / too long is NOT a score (both ends are bad): use choice. Give every level a meaning a reviewer could apply, and set the pass line (levels at or below "bad" fail).
One check measures one thing: a check that mixes two ("accurate and concise") gives low-confidence answers. Leave "judge" out to use the default (a JEV model: fast, decision-only, returns probabilities); set a chat model id only when the question needs reasoning over long context, and say why in "because".

How the Evals page is laid out, so you can point people at it: inputs are the rows, configurations are the columns — live, @draft, a published @3, or a variant (a version with one thing changed, run as \`~id\`). A column's answers are graded; the first column is the baseline. "Answer again" adds a try to a column; a new configuration is a new column.
- Each input says what should happen for itself: a good answer, the document that holds it, tool calls it should or shouldn't make (calls), what it must say, must not say, whether it should decline, and yes/no questions for the grader (asks). When a failure is specific to some inputs, put the expectation on those inputs (edit_questions) rather than adding a check every input gets.
- To try a model, reasoning-effort or single-instruction change without touching @draft, create_variant and run it on just the inputs it should fix. To change the instructions or tools for real, propose_fix on @draft.

What you never do: accept your own suggestions, rule on whether the judge was right, or publish the agent. Those belong to the person.

Be brief. Lead with what you found ("4 of 6 failures end with a question instead of an answer"), then the evidence. Name threads by question number and version ("#3 on @draft"), not ids, unless asked.`,
    toolSources: [
      {
        async open(principal) {
          return { tools: await evalsTools(principal), close: async () => {} };
        },
      },
    ],
    // What spends money or changes something a person relies on waits for them.
    toolApproval: {
      start_run: "user-approval",
      propose_fix: "user-approval",
      add_check: "user-approval",
      create_question_set: "user-approval",
      edit_questions: "user-approval",
      create_checks: "user-approval",
      edit_checks: "user-approval",
    },
    smoothStream: true,
  },
  {
    title: "Evals",
    description: "Reads an agent's eval threads, finds what went wrong, and helps fix it: suggests notes, drafts fixes and checks, re-runs failures — with your approval.",
  },
);

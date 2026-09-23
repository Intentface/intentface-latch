/**
 * Server functions for error discovery: reading threads, noting what went
 * wrong, grouping notes into failure modes, and turning a mode into a check
 * whose first rulings are the notes that found it.
 */
import { createServerFn } from "@tanstack/react-start";
import { generateObject } from "ai";
import { getPrincipal } from "./session";
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import { CheckDraftSchema, ClusterSchema, MIN_NOTES_TO_CLUSTER, READ_TARGET, checkPrompt, cleanClusters, clusterPrompt } from "./evals/v2/failures";
import type { FailureMode } from "./evals/v2/failures";
import { checkIdFor } from "./evals/v2/validate";
import type { ThreadRef } from "./evals/v2/model";

async function ownerFor(principal: Principal, agent: string) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  return rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
}

/** A small, fast model for reading notes — not a judge, and not the agent. */
async function helperModel() {
  const { models, modelFor } = await getLatch();
  const pick =
    ["claude-haiku-4-5", "gpt-5-mini", "gemini-2.5-flash"].find((id) => models.some((m) => m.id === id)) ??
    models.find((m) => /haiku|mini|flash/i.test(m.id))?.id ??
    models[0]?.id;
  if (!pick) throw new Error("No model is configured to read notes with.");
  return modelFor(pick);
}

/** Round-robin by question so the first threads read are spread across the set, not ten tries of one. */
function spread(threads: ThreadRef[]): ThreadRef[] {
  const lanes = new Map<string, ThreadRef[]>();
  for (const t of threads) {
    const k = `${t.datasetId}|${t.inputId}`;
    (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(t);
  }
  const out: ThreadRef[] = [];
  const queues = [...lanes.values()];
  for (let i = 0; queues.some((q) => q.length); i = (i + 1) % queues.length) {
    const next = queues[i].shift();
    if (next) out.push(next);
  }
  return out;
}

export const getFailuresFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const [notes, modes, threads] = await Promise.all([
      evals.listNotes(o.owner, o.name),
      evals.listModes(o.owner, o.name),
      evals.listThreads(o.owner, { agentName: o.name }),
    ]);
    const byThread = new Map(threads.map((t) => [t.threadId, t]));
    const prompts = new Map<string, string>();
    for (const d of new Set(threads.map((t) => t.datasetId).filter((x): x is string => !!x)))
      for (const i of await evals.listInputs(d)) prompts.set(`${d}|${i.id}`, i.prompt);
    return {
      readTarget: READ_TARGET,
      minToCluster: MIN_NOTES_TO_CLUSTER,
      threadsAvailable: threads.filter((t) => !t.error).length,
      modes: modes.map((m) => ({ id: m.id, name: m.name, description: m.description })),
      notes: notes.map((n) => {
        const t = byThread.get(n.threadId);
        return {
          threadId: n.threadId,
          text: n.text,
          ok: n.ok,
          modeId: n.modeId ?? null,
          version: t?.version ?? "",
          inputId: t?.inputId ?? "",
          prompt: (t && prompts.get(`${t.datasetId}|${t.inputId}`)) ?? "",
          updatedAt: n.updatedAt,
        };
      }),
    };
  });

export type Failures = NonNullable<Awaited<ReturnType<typeof getFailuresFn>>>;

/** Threads nobody has read yet, spread across questions, newest runs first. */
export const getReadingQueueFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const o = await ownerFor(principal, agent);
    if (!o) return [];
    const { evals } = await getLatch();
    const [threads, notes] = await Promise.all([evals.listThreads(o.owner, { agentName: o.name }), evals.listNotes(o.owner, o.name)]);
    const read = new Set(notes.map((n) => n.threadId));
    const unread = threads.filter((t) => !t.error && !read.has(t.threadId));
    return spread(unread)
      .slice(0, 40)
      .map((t) => ({ threadId: t.threadId, version: t.version, inputId: t.inputId ?? "", attempt: t.attempt ?? 0 }));
  });

export const getNoteFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; threadId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const n = (await evals.listNotes(o.owner, o.name)).find((x) => x.threadId === data.threadId);
    return n ? { text: n.text, ok: n.ok } : null;
  });

/** Save what went wrong in a thread — or that nothing did. Empty and not ok clears it. */
export const saveNoteFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; threadId: string; text: string; ok: boolean }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit take notes." };
    const { evals } = await getLatch();
    const t = await evals.getThread(o.owner, data.threadId);
    if (!t) return { ok: false as const, error: "That thread is not one of this agent's eval threads." };
    const text = data.text.trim();
    if (!text && !data.ok) {
      await evals.deleteNote(o.owner, data.threadId);
      return { ok: true as const };
    }
    const now = Date.now();
    await evals.saveNote({
      owner: o.owner,
      threadId: data.threadId,
      agentName: o.name,
      ...(t.datasetId ? { datasetId: t.datasetId } : {}),
      text: data.ok ? "" : text,
      ok: data.ok,
      ...(principal.userId ? { by: principal.userId } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const };
  });

/** Group the notes into failure modes. One small model call; names seen before are kept where they fit. */
export const findPatternsFn = createServerFn({ method: "POST" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const { evals } = await getLatch();
    const notes = (await evals.listNotes(o.owner, o.name)).filter((n) => !n.ok && n.text.trim());
    if (notes.length < MIN_NOTES_TO_CLUSTER)
      return { ok: false as const, error: `Write at least ${MIN_NOTES_TO_CLUSTER} notes first; with fewer, patterns are guesses.` };
    const existing = await evals.listModes(o.owner, o.name);
    const { object } = await generateObject({
      model: await helperModel(),
      schema: ClusterSchema,
      temperature: 0,
      prompt: clusterPrompt({ agentName: o.name, notes, existing }),
      abortSignal: AbortSignal.timeout(60_000),
    });
    const now = Date.now();
    const modes: FailureMode[] = [];
    const assign = new Map<string, string>();
    for (const m of cleanClusters(object, notes.length)) {
      // A mode that keeps its name keeps its id, so links to it survive a re-grouping.
      const id = existing.find((e) => e.name.toLowerCase() === m.name.toLowerCase())?.id ?? `fm_${now.toString(36)}_${modes.length}`;
      modes.push({ owner: o.owner, agentName: o.name, id, name: m.name, description: m.description, createdAt: now + modes.length });
      for (const i of m.notes) assign.set(notes[i].threadId, id);
    }
    await evals.setModes(o.owner, o.name, modes, assign);
    return { ok: true as const, modes: modes.length, grouped: assign.size, of: notes.length };
  });

export const renameModeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; id: string; name: string; description: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const };
    const { evals } = await getLatch();
    await evals.updateMode(o.owner, data.id, { name: data.name.trim(), description: data.description.trim() });
    return { ok: true as const };
  });

/** Draft a check that would catch a failure mode. The person edits it before anything is saved. */
export const proposeCheckFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; modeId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const { evals } = await getLatch();
    const mode = (await evals.listModes(o.owner, o.name)).find((m) => m.id === data.modeId);
    if (!mode) return { ok: false as const, error: "That failure mode was regrouped away. Refresh the page." };
    const examples = (await evals.listNotes(o.owner, o.name)).filter((n) => n.modeId === mode.id).map((n) => n.text);
    const { object } = await generateObject({
      model: await helperModel(),
      schema: CheckDraftSchema,
      temperature: 0,
      prompt: checkPrompt({ agentName: o.name, mode, examples: examples.slice(0, 12) }),
      abortSignal: AbortSignal.timeout(60_000),
    });
    const rubrics = await evals.listRubrics(o.owner, o.name);
    return {
      ok: true as const,
      draft: object,
      examples: examples.length,
      rubrics: rubrics.map((r) => ({ id: r.id, version: r.version })),
    };
  });

/**
 * Add the check to a set of checks (a new version), and record the notes
 * behind the failure mode as its first rulings: a thread noted with this
 * failure is a fail, a thread marked "looks fine" is a pass. The check
 * starts with evidence about its judge instead of at zero.
 */
export const createCheckFromModeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; modeId: string; rubricId: string; label: string; ask: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const label = data.label.trim();
    const ask = data.ask.trim();
    if (!label || !ask) return { ok: false as const, error: "The check needs a name and a question." };
    const { evals } = await getLatch();
    const rubric = await evals.getRubric(o.owner, data.rubricId);
    if (!rubric) return { ok: false as const, error: "Those checks no longer exist." };
    const mode = (await evals.listModes(o.owner, o.name)).find((m) => m.id === data.modeId);
    if (!mode) return { ok: false as const, error: "That failure mode was regrouped away." };
    const id = checkIdFor(label, rubric.checks.map((c) => c.id));
    const saved = await evals.saveRubric({
      owner: o.owner,
      id: rubric.id,
      agentName: rubric.agentName,
      defaultJudge: rubric.defaultJudge,
      checks: [
        ...rubric.checks,
        { kind: "asked", id, label, ask, shape: { type: "boolean" }, because: `failure mode "${mode.name}", found by reading threads` },
      ],
    });
    const notes = await evals.listNotes(o.owner, o.name);
    const now = Date.now();
    const failed = notes.filter((n) => n.modeId === mode.id);
    const passed = notes.filter((n) => n.ok);
    for (const n of [...failed, ...passed])
      await evals.saveRuling({ threadId: n.threadId, checkId: id, failed: !n.ok, ...(principal.userId ? { by: principal.userId } : {}), createdAt: now });
    return { ok: true as const, checkId: id, version: saved.version, failed: failed.length, passed: passed.length };
  });

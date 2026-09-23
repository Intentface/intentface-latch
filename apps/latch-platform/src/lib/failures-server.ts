/**
 * Server functions for error discovery: reading threads, noting what went
 * wrong, grouping notes into failure modes, and turning a mode into a check
 * whose first rulings are the notes that found it.
 */
import { createServerFn } from "@tanstack/react-start";
import { getPrincipal } from "./session";
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import { MIN_NOTES_TO_CLUSTER, READ_TARGET } from "./evals/v2/failures";
import { addCheckFromMode, draftCheck, groupNotes } from "./failures-actions";
import type { ThreadRef } from "./evals/v2/model";

async function ownerFor(principal: Principal, agent: string) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  return rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
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
    const [notes, modes, threads, suggestions] = await Promise.all([
      evals.listNotes(o.owner, o.name),
      evals.listModes(o.owner, o.name),
      evals.listThreads(o.owner, { agentName: o.name }),
      evals.listSuggestions(o.owner, o.name, "open"),
    ]);
    const noted = new Set(notes.map((n) => n.threadId));
    const byThread = new Map(threads.map((t) => [t.threadId, t]));
    const prompts = new Map<string, string>();
    for (const d of new Set(threads.map((t) => t.datasetId).filter((x): x is string => !!x)))
      for (const i of await evals.listInputs(d)) prompts.set(`${d}|${i.id}`, i.prompt);
    return {
      readTarget: READ_TARGET,
      minToCluster: MIN_NOTES_TO_CLUSTER,
      threadsAvailable: threads.filter((t) => !t.error).length,
      modes: modes.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        decision: m.decision ?? null,
        decisionWhy: m.decisionWhy ?? null,
        decidedBy: m.decidedBy ?? null,
      })),
      /** Threads the evals agent has read and suggested a note on, waiting for a person. */
      suggested: suggestions
        .filter((x) => !noted.has(x.threadId))
        .map((x) => {
          const t = byThread.get(x.threadId);
          return { threadId: x.threadId, version: t?.version ?? "", inputId: t?.inputId ?? "", attempt: t?.attempt ?? 0 };
        }),
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
    const sug = (await evals.listSuggestions(o.owner, o.name, "open")).find((x) => x.threadId === data.threadId);
    return {
      note: n ? { text: n.text, ok: n.ok } : null,
      // Only while nobody has written a note: a person's note always stands.
      suggestion: !n && sug ? { text: sug.text, ok: sug.ok, why: sug.why } : null,
    };
  });

/** Accept or dismiss the evals agent's suggestion. Accepting writes it as the person's own note. */
export const resolveSuggestionFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; threadId: string; accept: boolean }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const { evals } = await getLatch();
    const sug = (await evals.listSuggestions(o.owner, o.name, "open")).find((x) => x.threadId === data.threadId);
    if (!sug) return { ok: false as const, error: "That suggestion is gone." };
    if (data.accept) {
      const t = await evals.getThread(o.owner, data.threadId);
      const now = Date.now();
      await evals.saveNote({
        owner: o.owner,
        threadId: data.threadId,
        agentName: o.name,
        ...(t?.datasetId ? { datasetId: t.datasetId } : {}),
        text: sug.text,
        ok: sug.ok,
        ...(principal.userId ? { by: principal.userId } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    await evals.setSuggestionStatus(o.owner, data.threadId, data.accept ? "accepted" : "rejected");
    return { ok: true as const };
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


export const findPatternsFn = createServerFn({ method: "POST" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return groupNotes(principal, agent);
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


export const proposeCheckFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; modeId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return draftCheck(principal, data);
  });


export const createCheckFromModeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; modeId: string; rubricId: string; label: string; ask: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return addCheckFromMode(principal, data);
  });

/** A person decides what to do about a failure mode — overriding the agent's suggestion. */
export const decideModeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; id: string; decision: "fix" | "measure" | "leave" }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const };
    const { evals } = await getLatch();
    const m = (await evals.listModes(o.owner, o.name)).find((x) => x.id === data.id);
    await evals.decideMode(o.owner, data.id, { decision: data.decision, why: m?.decisionWhy ?? "", by: "person" });
    return { ok: true as const };
  });

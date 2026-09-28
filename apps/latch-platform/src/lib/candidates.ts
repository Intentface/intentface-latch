/**
 * Candidates: named, unpublished configurations of an agent, shared by
 * everyone who can edit it. They replace both the per-person draft and the
 * eval "variant": the editor edits one, Evals runs one as a column
 * (`@c_<id>`), and publishing one makes it the next version.
 *
 * What a label means, everywhere a version is named:
 *   live     — whatever is live now; a run files it as the version it was, `@7`
 *   @7       — a published version, never changing
 *   @c_ab12  — a candidate, shown by its title
 *
 * Server-only: server-function modules import this inside handlers.
 */
import { AgentRecordSchema, isCandidateId, normalizeAgentRecord } from "@intentface/latch-agent-builder";
import type { AgentCandidate, AgentRecord, AgentRecordInput } from "@intentface/latch-agent-builder";
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { normalizeAgentName, rubricsOf } from "./agent-store";
import type { AgentScope } from "./agent-store";
import { validateRubrics } from "./observability/rubrics";

/** One thing changed on a base: what "New candidate" in Evals offers. */
export type Change = { model?: string; effort?: "minimal" | "low" | "medium" | "high"; addInstructions?: string };

export function applyChange(rec: AgentRecord, change: Change): AgentRecord {
  const add = change.addInstructions?.trim();
  return {
    ...rec,
    ...(change.model ? { modelId: change.model } : {}),
    ...(change.effort ? { exec: { ...rec.exec, effort: change.effort } } : {}),
    ...(add ? { instructions: `${rec.instructions}\n\n${add}` } : {}),
  };
}

/** A short title for what a change does: "live · sonnet-5", "@3 · high effort", "live + sourcing rules". */
export function changeTitle(base: string, change: Change) {
  if (change.model) return `${base} · ${change.model.replace(/^claude-/, "")}`;
  if (change.effort) return `${base} · ${change.effort} effort`;
  const text = (change.addInstructions ?? "").trim();
  // The line's own heading when it has one ("Sourcing rules: …"), else its first words.
  const head = /^([^:.\n]{3,32}):/.exec(text)?.[1] ?? text.split(/\s+/).slice(0, 3).join(" ");
  return `${base} + ${head.toLowerCase()}`;
}

/** A title no other open candidate of this agent has: "Draft", "Draft 2", … */
export function uniqueTitle(wanted: string, open: { id: string; title: string }[], except?: string) {
  const base = wanted.trim().slice(0, 48) || "Draft";
  const taken = new Set(open.filter((c) => c.id !== except).map((c) => c.title.toLowerCase()));
  let title = base;
  for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${base} ${n}`;
  return title;
}

export const refOf = (id: string) => `@${id}`;

/** The live version's number, or null for an agent published before versions existed. */
export async function liveVersionOf(principal: Principal, name: string, scope: AgentScope) {
  const { agentStore } = await getLatch();
  return (await agentStore.listVersions(principal, name, scope)).find((v) => v.published)?.version ?? null;
}

export type Resolved = {
  /** What results are filed under: `@7`, `@c_ab12` — never a label that moves. */
  label: string;
  record: AgentRecord;
  /** What people call it: `@7`, or the candidate's title. */
  title: string;
  candidate?: AgentCandidate;
};

/**
 * Resolve what a person or the Evals agent called a configuration. Accepts
 * `live`, `@7`, `@c_…` (or bare `c_…`), and an open candidate's title.
 */
export async function resolveLabel(principal: Principal, agentName: string, asked: string): Promise<Resolved> {
  const { agentStore } = await getLatch();
  const live = await agentStore.getRecord(principal, agentName);
  if (!live) throw new Error(`No agent ${agentName}.`);
  const { name, scope } = live;
  const said = asked.trim();
  if (said === "live") {
    const n = await liveVersionOf(principal, name, scope);
    return { label: n == null ? "live" : `@${n}`, record: live, title: n == null ? "live" : `@${n}` };
  }
  if (said === "@draft") throw new Error("Drafts are candidates now: name one, or create one.");
  const pinned = /^@(\d+)$/.exec(said);
  if (pinned) {
    const rec = await agentStore.getVersion(principal, name, scope, Number(pinned[1]));
    if (!rec) throw new Error(`${said} does not exist for ${name}.`);
    return { label: said, record: rec, title: said };
  }
  const id = said.replace(/^@/, "");
  const all = await agentStore.listCandidates(principal, name, scope, { closed: true });
  const c = isCandidateId(id)
    ? all.find((x) => x.id === id)
    : all.find((x) => !x.closedAt && x.title.toLowerCase() === said.toLowerCase());
  if (!c) throw new Error(`${said} is not a version or candidate of ${name}.`);
  return { label: refOf(c.id), record: c.record, title: c.title, candidate: c };
}

/**
 * Name what results were filed under. Closed candidates keep their title;
 * one published says what it became.
 */
export function titleOf(label: string, candidates: AgentCandidate[]) {
  const c = label.startsWith("@c_") ? candidates.find((x) => refOf(x.id) === label) : undefined;
  return c ? c.title : label;
}

/** Refused because someone else published while this was being edited. */
export interface StalePublish {
  ok: false;
  stale: true;
  /** What is live now. */
  liveVersion: number;
  /** What this edit was based on. */
  baseVersion: number;
  author?: string;
  at?: number;
}

/** A one-line cap on the history note, so a stray paste can't fill the column. */
const MESSAGE_MAX = 500;

/**
 * Publish a record as the agent's next version — from the editor, or a
 * candidate from its Evals column. Refuses once when someone else published
 * after `baseVersion`, so their work is never silently reverted.
 */
export async function publishRecord(
  principal: Principal,
  input: { record: AgentRecordInput; message?: string; baseVersion?: number; force?: boolean; candidateId?: string },
): Promise<{ ok: true; version: number | null } | { ok: false; error: string } | StalePublish> {
  const parsed = AgentRecordSchema.safeParse(input.record);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join(".") || "agent"}: ${first.message}` };
  }
  const rec = normalizeAgentRecord(parsed.data);
  // `memory-*` is reserved for the platform's memory system agents —
  // listAgentsFn hides the whole prefix, so a user agent named this way
  // would save fine and then vanish from every picker.
  if (rec.name.startsWith("memory-")) {
    return { ok: false, error: `"${rec.name}" is reserved (memory-* are platform system agents).` };
  }
  const { agentStore, authoredTools, models } = await getLatch();
  // The record schema keeps a rubric's `trigger` opaque; if the caller
  // supplies rubrics, run the platform's real validation (trigger AST, judge
  // model in the catalog) — the same gate attach_evals and the drawer use.
  if (rec.attachedEvals) {
    const valid = validateRubrics(rubricsOf(rec), (id) => models.some((m) => m.id === id));
    if (!valid.ok) return { ok: false, error: valid.error };
    rec.attachedEvals = valid.rubrics;
  }
  // An org agent can only attach ORG-scoped tools — a personal tool wouldn't
  // resolve for other members. Validate before persisting.
  const attached = rec.exec?.authoredTools ?? [];
  if (rec.scope === "org" && attached.length) {
    const orgTools = new Set((await authoredTools.listFor(principal)).filter((t) => t.scope === "org").map((t) => t.name));
    const personal = attached.filter((n) => !orgTools.has(n));
    if (personal.length) {
      return { ok: false, error: `Org agents can only use org-scoped tools. Make these org-scoped first: ${personal.join(", ")}.` };
    }
  }
  // The editor doesn't manage attached evals — carry them over so a save
  // never silently wipes the agent's online-eval rubrics. Pinned to the
  // record's scope: a same-named agent in the other scope must not donate.
  const existing = await agentStore.getRecord(principal, `${rec.scope}:${rec.name}`);
  if (existing && input.baseVersion != null && !input.force) {
    const live = (await agentStore.listVersions(principal, rec.name, rec.scope)).find((v) => v.published);
    if (live && live.version !== input.baseVersion) {
      return { ok: false, stale: true, liveVersion: live.version, baseVersion: input.baseVersion, author: live.author, at: live.createdAt };
    }
  }
  await agentStore.upsert(
    principal,
    { ...rec, attachedEvals: rec.attachedEvals ?? existing?.attachedEvals },
    { source: "editor", author: principal.userId, message: input.message?.slice(0, MESSAGE_MAX) },
  );
  const version = await liveVersionOf(principal, rec.name, rec.scope);
  // Kept, closed, saying what it became — so its Evals columns keep their name.
  if (input.candidateId) await agentStore.closeCandidate(principal, rec.name, rec.scope, input.candidateId, version == null ? {} : { publishedAs: version });
  return { ok: true, version };
}

/**
 * The per-person draft from before candidates: the first time its author
 * opens the agent, it becomes a candidate called "Draft", so nothing typed
 * is lost.
 */
export async function adoptLegacyDraft(principal: Principal, name: string, scope: AgentScope) {
  const { agentStore } = await getLatch();
  const draft = await agentStore.getDraft(principal, name, scope);
  if (!draft) return null;
  const open = await agentStore.listCandidates(principal, name, scope);
  const c = await agentStore.saveCandidate(principal, name, scope, {
    title: uniqueTitle("Draft", open),
    record: draft.record,
    ...(draft.baseVersion != null ? { baseVersion: draft.baseVersion } : {}),
  });
  await agentStore.discardDraft(principal, name, scope);
  return c;
}

/** Everything the editor and Evals show about an agent's candidates. */
export async function candidatesOf(principal: Principal, agent: string, opts?: { closed?: boolean }) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  if (!rec) return null;
  await adoptLegacyDraft(principal, rec.name, rec.scope);
  const candidates = await agentStore.listCandidates(principal, rec.name, rec.scope, opts);
  return { rec, candidates, liveVersion: await liveVersionOf(principal, rec.name, rec.scope) };
}

/** Rename an open candidate; the title must stay unique among the open ones. */
export async function renameCandidate(principal: Principal, name: string, scope: AgentScope, id: string, wanted: string) {
  const { agentStore } = await getLatch();
  const open = await agentStore.listCandidates(principal, name, scope);
  const c = open.find((x) => x.id === id);
  if (!c) return { ok: false as const, error: "This candidate was published or discarded." };
  const title = wanted.trim().slice(0, 48);
  if (!title || title === c.title) return { ok: true as const, title: c.title };
  if (title === "live" || title.startsWith("@")) return { ok: false as const, error: "That name belongs to a version." };
  if (open.some((x) => x.id !== id && x.title.toLowerCase() === title.toLowerCase())) return { ok: false as const, error: `There is already a candidate called ${title}.` };
  await agentStore.saveCandidate(principal, name, scope, { id, title, record: c.record });
  return { ok: true as const, title };
}

/**
 * What the Failures page and the Evals agent both do: group notes into
 * failure modes, draft a check from one, add it with its first rulings.
 *
 * Server-only on purpose. A server-function file that exports plain
 * functions keeps their server imports in the browser bundle; these live
 * here so `failures-server.ts` stays importable from the page.
 */
import { generateObject } from "ai";
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import { CheckDraftSchema, ClusterSchema, MIN_NOTES_TO_CLUSTER, checkPrompt, cleanClusters, clusterPrompt } from "./evals/v2/failures";
import type { FailureMode } from "./evals/v2/failures";
import { checkIdFor } from "./evals/v2/validate";

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

/** Group the notes into failure modes. One small model call; names seen before are kept where they fit. */
export async function groupNotes(principal: Principal, agent: string) {
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
      const kept = existing.find((e) => e.name.toLowerCase() === m.name.toLowerCase());
      const id = kept?.id ?? `fm_${now.toString(36)}_${modes.length}`;
      modes.push({
        owner: o.owner,
        agentName: o.name,
        id,
        name: m.name,
        description: m.description,
        // A mode that keeps its name keeps what was decided about it.
        ...(kept?.decision ? { decision: kept.decision, decisionWhy: kept.decisionWhy, decidedBy: kept.decidedBy } : {}),
        createdAt: now + modes.length,
      });
      for (const i of m.notes) assign.set(notes[i].threadId, id);
    }
    await evals.setModes(o.owner, o.name, modes, assign);
    return { ok: true as const, modes: modes.length, grouped: assign.size, of: notes.length };
}

/** Draft a check that would catch a failure mode. The person edits it before anything is saved. */
export async function draftCheck(principal: Principal, data: { agent: string; modeId: string }) {
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
}

/**
 * Add the check to a set of checks (a new version), and record the notes
 * behind the failure mode as its first rulings: a thread noted with this
 * failure is a fail, a thread marked "looks fine" is a pass. The check
 * starts with evidence about its judge instead of at zero.
 */
export async function addCheckFromMode(principal: Principal, data: { agent: string; modeId: string; rubricId: string; label: string; ask: string }) {
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
}

/**
 * Group the evals agent's open readings into the patterns it proposes, so a
 * person decides once per pattern instead of once per conversation. Names
 * match failure modes already decided where they fit, so agreeing adds to
 * them. Only readings that say something went wrong are grouped.
 */
export async function groupSuggestions(principal: Principal, agent: string) {
  const o = await ownerFor(principal, agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { evals } = await getLatch();
  const open = (await evals.listSuggestions(o.owner, o.name, "open")).filter((x) => !x.ok && x.text.trim());
  const noted = new Set((await evals.listNotes(o.owner, o.name)).map((n) => n.threadId));
  const readings = open.filter((x) => !noted.has(x.threadId));
  if (readings.length < 2) return { ok: true as const, patterns: 0 };
  const existing = await evals.listModes(o.owner, o.name);
  const { object } = await generateObject({
    model: await helperModel(),
    schema: ClusterSchema,
    temperature: 0,
    prompt: clusterPrompt({ agentName: o.name, notes: readings, existing }),
    abortSignal: AbortSignal.timeout(60_000),
  });
  const groups = new Map<string, { name: string; description: string }>();
  const clusters = cleanClusters(object, readings.length);
  for (const m of clusters) {
    const kept = existing.find((e) => e.name.toLowerCase() === m.name.toLowerCase());
    const g = kept ? { name: kept.name, description: kept.description } : { name: m.name, description: m.description };
    for (const i of m.notes) groups.set(readings[i].threadId, g);
  }
  await evals.setSuggestionGroups(
    o.owner,
    readings.map((x) => ({ threadId: x.threadId, group: groups.get(x.threadId) ?? null })),
  );
  return { ok: true as const, patterns: clusters.length };
}

/**
 * A person's answer to one proposed pattern. Disagreeing drops its readings.
 * Otherwise each reading becomes the person's note, the pattern becomes a
 * failure mode (or joins the one of that name), and the decision is theirs.
 */
export async function decidePattern(
  principal: Principal,
  data: { agent: string; name: string; decision: "fix" | "measure" | "leave" | "disagree" },
) {
  const o = await ownerFor(principal, data.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { evals } = await getLatch();
  const mine = (await evals.listSuggestions(o.owner, o.name, "open")).filter((x) => x.group?.name === data.name);
  if (!mine.length) return { ok: false as const, error: "That pattern is gone. Refresh the page." };
  if (data.decision === "disagree") {
    for (const x of mine) await evals.setSuggestionStatus(o.owner, x.threadId, "rejected");
    return { ok: true as const, modeId: null };
  }
  const now = Date.now();
  const modes = await evals.listModes(o.owner, o.name);
  const mode = modes.find((m) => m.name.toLowerCase() === data.name.toLowerCase());
  const modeId = mode?.id ?? `fm_${now.toString(36)}`;
  if (!mode)
    await evals.addMode({
      owner: o.owner,
      agentName: o.name,
      id: modeId,
      name: data.name,
      description: mine[0].group?.description ?? "",
      createdAt: now,
    });
  for (const x of mine) {
    const t = await evals.getThread(o.owner, x.threadId);
    await evals.saveNote({
      owner: o.owner,
      threadId: x.threadId,
      agentName: o.name,
      ...(t?.datasetId ? { datasetId: t.datasetId } : {}),
      text: x.text,
      ok: false,
      modeId,
      ...(principal.userId ? { by: principal.userId } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await evals.setSuggestionStatus(o.owner, x.threadId, "accepted");
  }
  await evals.decideMode(o.owner, modeId, { decision: data.decision, why: "", by: "person" });
  return { ok: true as const, modeId };
}

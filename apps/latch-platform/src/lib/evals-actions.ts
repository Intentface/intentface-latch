/**
 * Creating and editing the tests — question sets and sets of checks —
 * shared by the Evals pages and the Evals agent, so both refuse the same
 * things in the same words. Server-only: `evals-server.ts` imports these
 * inside handlers, which keeps them out of the browser bundle.
 */
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import type { Check } from "./evals/v2/model";
import { checkIdFor, fromEditable, nextInputId, toEditable, validateChecks } from "./evals/v2/validate";
import type { EditableQuestion } from "./evals/v2/validate";

async function ownerFor(principal: Principal, agent: string) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  return rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "set";

/**
 * One check to start a new set with. Deliberately modest: the checks worth
 * having come from reading threads (the Failures page), not from a template.
 */
const STARTER_CHECKS: Check[] = [
  {
    kind: "asked",
    id: "answered-the-question",
    label: "Answered what was asked",
    ask: "Did the final answer address what this person actually asked, rather than something adjacent or a question back?",
    shape: { type: "boolean" },
    because: "a starting point — replace it with checks found by reading threads",
  },
];

export async function createQuestionSet(
  principal: Principal,
  d: { agent: string; name: string; audience?: string; note?: string; questions?: EditableQuestion[] },
) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit can have question sets." };
  const name = d.name.trim();
  if (!name) return { ok: false as const, error: "Give the question set a name." };
  const { evals } = await getLatch();
  const taken = new Set((await evals.listDatasets(o.owner)).map((x) => x.id));
  let id = `ds_${slug(name)}`;
  for (let n = 2; taken.has(id); n++) id = `ds_${slug(name)}-${n}`;
  const questions = d.questions ?? [];
  const valid = fromEditable(questions);
  if (!valid.ok) return valid;
  await evals.saveDataset({
    owner: o.owner,
    id,
    agentName: o.name,
    name,
    kind: "inputs",
    ...(d.audience?.trim() ? { audience: d.audience.trim() } : {}),
    ...(d.note?.trim() ? { note: d.note.trim() } : {}),
  });
  await evals.setInputs(id, valid.value);
  return { ok: true as const, id, questions: valid.value.length };
}

/** Add, change or delete questions, and the set's audience and note. Ids never change: past results hang on them. */
export async function editQuestions(
  principal: Principal,
  d: {
    agent: string;
    questionSetId: string;
    upserts?: (Partial<EditableQuestion> & { prompt: string })[];
    deletes?: string[];
    audience?: string;
    note?: string;
  },
) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { evals } = await getLatch();
  const set = await evals.getDataset(o.owner, d.questionSetId);
  if (!set) return { ok: false as const, error: `No question set "${d.questionSetId}".` };
  let list = (await evals.listInputs(set.id)).map(toEditable);
  const gone = new Set(d.deletes ?? []);
  list = list.filter((q) => !gone.has(q.id));
  const added: string[] = [];
  for (const u of d.upserts ?? []) {
    const at = u.id ? list.findIndex((q) => q.id === u.id) : -1;
    if (at >= 0) {
      const q = list[at];
      list[at] = {
        ...q,
        prompt: u.prompt,
        ...(u.followUps ? { followUps: u.followUps } : {}),
        ...(u.answer !== undefined ? { answer: u.answer } : {}),
        ...(u.mustNot ? { mustNot: u.mustNot } : {}),
        ...(u.docs ? { docs: u.docs } : {}),
        ...(u.extra !== undefined ? { extra: u.extra } : {}),
      };
    } else {
      const id = u.id && !list.some((q) => q.id === u.id) ? u.id : nextInputId(list);
      list.push({ id, prompt: u.prompt, followUps: u.followUps ?? [], answer: u.answer ?? "", mustNot: u.mustNot ?? [], docs: u.docs ?? [], extra: u.extra ?? "{}" });
      added.push(id);
    }
  }
  const valid = fromEditable(list);
  if (!valid.ok) return valid;
  if (d.audience !== undefined || d.note !== undefined)
    await evals.saveDataset({
      owner: set.owner,
      id: set.id,
      agentName: set.agentName,
      name: set.name,
      kind: set.kind,
      ...((d.audience ?? set.audience)?.trim() ? { audience: (d.audience ?? set.audience)!.trim() } : {}),
      ...((d.note ?? set.note)?.trim() ? { note: (d.note ?? set.note)!.trim() } : {}),
    });
  await evals.setInputs(set.id, valid.value);
  return { ok: true as const, questions: valid.value.length, added, deleted: [...gone] };
}

export async function createChecks(principal: Principal, d: { agent: string; name: string; checks?: Check[] }) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit can have checks." };
  const name = d.name.trim();
  if (!name) return { ok: false as const, error: "Give the checks a name." };
  const { evals } = await getLatch();
  const taken = new Set((await evals.listRubrics(o.owner, o.name)).map((r) => r.id));
  let id = slug(name);
  for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
  const valid = validateChecks(d.checks?.length ? d.checks : STARTER_CHECKS);
  if (!valid.ok) return valid;
  const r = await evals.saveRubric({ owner: o.owner, id, agentName: o.name, defaultJudge: "jev-latest", checks: valid.value });
  return { ok: true as const, id: r.id, version: r.version };
}

/** Add, change or delete checks — saved as a new version, so earlier results keep the version that produced them. */
export async function editChecks(
  principal: Principal,
  d: { agent: string; checksId: string; upserts?: (Omit<Check, "id"> & { id?: string })[]; deletes?: string[] },
) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { evals } = await getLatch();
  const r = await evals.getRubric(o.owner, d.checksId);
  if (!r) return { ok: false as const, error: `No checks "${d.checksId}".` };
  const gone = new Set(d.deletes ?? []);
  let checks = r.checks.filter((c) => !gone.has(c.id));
  for (const u of d.upserts ?? []) {
    const at = u.id ? checks.findIndex((c) => c.id === u.id) : -1;
    if (at >= 0) checks[at] = { ...u, id: checks[at].id } as Check;
    else checks = [...checks, { ...u, id: checkIdFor(u.label || "check", checks.map((c) => c.id)) } as Check];
  }
  const valid = validateChecks(checks);
  if (!valid.ok) return valid;
  const saved = await evals.saveRubric({ owner: o.owner, id: r.id, agentName: r.agentName, defaultJudge: r.defaultJudge, checks: valid.value });
  return { ok: true as const, version: saved.version, checks: valid.value.map((c) => `${c.id}: ${c.label}`) };
}

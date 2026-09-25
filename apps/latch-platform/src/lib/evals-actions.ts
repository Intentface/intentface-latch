/**
 * Creating and editing the tests — question sets and sets of checks —
 * shared by the Evals pages and the Evals agent, so both refuse the same
 * things in the same words. Server-only: `evals-server.ts` imports these
 * inside handlers, which keeps them out of the browser bundle.
 */
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import type { Check, Input, InputFile, Rubric, Variant } from "./evals/v2/model";
import { saysItems } from "./evals/v2/expect";
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
  // A question set is only runnable with checks to judge it by. An agent's
  // first set gets the starter checks, so its first run needs no other step.
  let checksId: string | undefined;
  if (!(await evals.listRubrics(o.owner, o.name)).length) {
    const c = await createChecks(principal, { agent: d.agent, name: "checks" });
    if (c.ok) checksId = c.id;
  }
  return { ok: true as const, id, questions: valid.value.length, ...(checksId ? { checksId } : {}) };
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
  const before = await evals.listInputs(set.id);
  // Files never travel through the editors: they stay with the input by id.
  const filesOf = new Map(before.map((i) => [i.id, i.files]));
  let list = before.map(toEditable);
  const gone = new Set(d.deletes ?? []);
  list = list.filter((q) => !gone.has(q.id));
  const added: string[] = [];
  // Ids with answers in past runs; read once, only if something is added.
  let retired: Set<string> | undefined;
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
        ...(u.mustSay ? { mustSay: u.mustSay } : {}),
        ...(u.asks ? { asks: u.asks } : {}),
        ...(u.decline !== undefined ? { decline: u.decline } : {}),
        ...(u.calls ? { calls: u.calls } : {}),
        ...(u.extra !== undefined ? { extra: u.extra } : {}),
      };
    } else {
      retired ??= new Set((await evals.listThreads(o.owner, { datasetId: set.id })).flatMap((t) => (t.inputId ? [t.inputId] : [])));
      const id = u.id && !list.some((q) => q.id === u.id) && !retired.has(u.id) ? u.id : nextInputId(list, retired);
      list.push({
        id,
        prompt: u.prompt,
        followUps: u.followUps ?? [],
        answer: u.answer ?? "",
        mustNot: u.mustNot ?? [],
        docs: u.docs ?? [],
        mustSay: u.mustSay ?? [],
        asks: u.asks ?? [],
        decline: u.decline ?? false,
        calls: u.calls ?? [],
        extra: u.extra ?? "{}",
      });
      added.push(id);
    }
  }
  const valid = fromEditable(list);
  if (!valid.ok) return valid;
  for (const i of valid.value) {
    const f = filesOf.get(i.id);
    if (f?.length) i.files = f;
  }
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
  const checks = await ensureExpectationChecks(principal, { agent: d.agent, datasetId: set.id });
  return { ok: true as const, questions: valid.value.length, added, deleted: [...gone], checksAdded: checks.added };
}

/**
 * An input's own tool calls and says-items are read by two shared checks.
 * The first input that needs one adds it to the agent's checks, as a new
 * version — until then the checks have nothing to read them with.
 */
export async function ensureExpectationChecks(principal: Principal, d: { agent: string; datasetId: string }) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { added: [] as string[] };
  const { evals } = await getLatch();
  const inputs = await evals.listInputs(d.datasetId);
  const added: string[] = [];
  for (const r of await evals.listRubrics(o.owner, o.name)) added.push(...(await ensureOn(r, inputs)));
  return { added };
}

async function ensureOn(r: Rubric, inputs: Input[]) {
  const { evals } = await getLatch();
  const wantsCalls = inputs.some((i) => (i.facts?.calls?.length ?? 0) > 0);
  const wantsSays = inputs.some((i) => saysItems(i.facts).some((x) => x.kind !== "mustNot") || (i.facts?.mustNot?.length ?? 0) > 0);
  const hasCalls = r.checks.some((c) => c.kind === "counted" && c.spec.op === "expected_calls");
  const hasSays = r.checks.some((c) => c.kind === "asked" && c.fromInput === "says");
  const add: Check[] = [];
  const taken = r.checks.map((c) => c.id);
  if (wantsCalls && !hasCalls)
    add.push({ kind: "counted", id: checkIdFor("called-the-expected-tools", taken), label: "Called the expected tools", spec: { op: "expected_calls" } });
  if (wantsSays && !hasSays)
    add.push({
      kind: "asked",
      id: checkIdFor("said-what-it-should", taken),
      label: "Said what it should",
      ask: "What each input says the answer must say, must not say, or whether it should decline — each asked as a yes/no.",
      shape: { type: "boolean" },
      fromInput: "says",
    });
  if (!add.length) return [];
  await evals.saveRubric({ owner: r.owner, id: r.id, agentName: r.agentName, defaultJudge: r.defaultJudge, checks: [...r.checks, ...add] });
  return add.map((c) => c.label);
}

/** The most a file may weigh, and how many one input may carry — as chat allows. */
export const INPUT_FILE_MAX = 10 * 1024 * 1024;
export const INPUT_FILES_MAX = 5;

/** Attach a file to an input, or take one off. Its answers from before keep what they were given. */
export async function editInputFiles(
  principal: Principal,
  d: { agent: string; datasetId: string; inputId: string; add?: Omit<InputFile, "size">; remove?: number },
) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { evals } = await getLatch();
  const set = await evals.getDataset(o.owner, d.datasetId);
  if (!set) return { ok: false as const, error: "This set no longer exists." };
  const inputs = await evals.listInputs(set.id);
  const input = inputs.find((i) => i.id === d.inputId);
  if (!input) return { ok: false as const, error: `No input ${d.inputId}.` };
  let files = input.files ?? [];
  if (d.add) {
    if (!d.add.url.startsWith("data:")) return { ok: false as const, error: "A file must be sent as its contents." };
    const size = Math.round(((d.add.url.length - d.add.url.indexOf(",") - 1) * 3) / 4);
    if (size > INPUT_FILE_MAX) return { ok: false as const, error: `${d.add.filename} is over 10 MB.` };
    if (files.length >= INPUT_FILES_MAX) return { ok: false as const, error: `An input can carry ${INPUT_FILES_MAX} files.` };
    files = [...files, { ...d.add, size }];
  }
  if (d.remove !== undefined) files = files.filter((_, i) => i !== d.remove);
  await evals.setInputs(set.id, inputs.map((i) => (i.id === input.id ? { ...i, files } : i)));
  return { ok: true as const, files: files.map((f) => ({ filename: f.filename, mediaType: f.mediaType, size: f.size })) };
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

/**
 * Save a variant — a version with one thing changed — so it can be run as a
 * column. Its name says what changed; the same change on the same base is the
 * same variant, so running it again reuses its answers.
 */
export async function createVariant(principal: Principal, data: { agent: string; base: string; change: Variant["change"] }) {
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const { evals, models } = await getLatch();
    const change: Variant["change"] = {
      ...(data.change.model ? { model: data.change.model } : {}),
      ...(data.change.effort ? { effort: data.change.effort } : {}),
      ...(data.change.addInstructions?.trim() ? { addInstructions: data.change.addInstructions.trim() } : {}),
    };
    if (!Object.keys(change).length) return { ok: false as const, error: "Change one thing: the model, the reasoning effort or the instructions." };
    if (change.model && !models.some((m) => m.id === change.model)) return { ok: false as const, error: `No model ${change.model} is configured.` };
    const existing = await evals.listVariants(o.owner, o.name);
    const same = existing.find((v) => v.base === data.base && JSON.stringify(v.change) === JSON.stringify(change));
    if (same) return { ok: true as const, id: same.id, name: same.name };
    const what = change.model
      ? change.model.replace(/^claude-/, "")
      : change.effort
        ? `${change.effort} effort`
        : `+ “${change.addInstructions!.slice(0, 24)}${change.addInstructions!.length > 24 ? "…" : ""}”`;
    let name = `${data.base} · ${what}`;
    for (let n = 2; existing.some((v) => v.name === name); n++) name = `${data.base} · ${what} ${n}`;
    const id = `v_${Math.random().toString(36).slice(2, 8)}`;
    await evals.saveVariant({ owner: o.owner, id, agentName: o.name, base: data.base, name, change, createdAt: Date.now() });
    return { ok: true as const, id, name };
  }

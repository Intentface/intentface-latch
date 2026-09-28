/**
 * Creating and editing the tests — question sets and sets of checks —
 * shared by the Evals pages and the Evals agent, so both refuse the same
 * things in the same words. Server-only: `evals-server.ts` imports these
 * inside handlers, which keeps them out of the browser bundle.
 */
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import type { Check, Input, InputFile, Rubric } from "./evals/v2/model";
import type { Change } from "./candidates";
import { configFingerprint } from "./evals/v2/runner";
import { saysItems } from "./evals/v2/expect";
import { checkIdFor, cleanTags, fromEditable, nextInputId, toEditable, validateChecks } from "./evals/v2/validate";
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
        ...(u.mustSay ? { mustSay: u.mustSay } : {}),
        ...(u.asks ? { asks: u.asks } : {}),
        ...(u.decline !== undefined ? { decline: u.decline } : {}),
        ...(u.calls ? { calls: u.calls } : {}),
        ...(u.judged ? { judged: u.judged } : {}),
        ...(u.tags ? { tags: u.tags } : {}),
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
        mustSay: u.mustSay ?? [],
        asks: u.asks ?? [],
        decline: u.decline ?? false,
        calls: u.calls ?? [],
        judged: u.judged ?? [],
        tags: u.tags ?? [],
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
  const wantsAnswer = inputs.some((i) => typeof i.facts?.answer === "string" && i.facts.answer.trim());
  const hasAnswer = r.checks.some((c) => c.kind === "asked" && c.ask.includes("REFERENCE_ANSWER"));
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
  if (wantsAnswer && !hasAnswer)
    add.push({
      kind: "asked",
      id: checkIdFor("got-the-answer-right", taken),
      label: "Got the answer right",
      ask: "Compare the final answer with the REFERENCE_ANSWER. Judge the substance, not wording, length or tone.",
      shape: {
        type: "score",
        levels: [
          { name: "contradicts", means: "States something the reference contradicts." },
          { name: "misses_the_point", means: "Does not carry the reference's central claim." },
          { name: "partial", means: "Carries part of it, omits something load-bearing." },
          { name: "equivalent", means: "Same substance as the reference." },
          { name: "better", means: "Same substance plus something useful and true." },
        ],
        bad: 1,
      },
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
 * A candidate with one thing changed from a base — Evals' "New candidate" and
 * the Evals agent's create_candidate. Its title says what changed; the same
 * change on the same base is the same candidate, so running it again reuses
 * its answers.
 */
export async function createCandidate(principal: Principal, data: { agent: string; base: string; change: Change; name?: string }) {
  const o = await ownerFor(principal, data.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit." };
  const { agentStore, models } = await getLatch();
  const { applyChange, changeTitle, resolveLabel, uniqueTitle, liveVersionOf } = await import("./candidates");
  const change: Change = {
    ...(data.change.model ? { model: data.change.model } : {}),
    ...(data.change.effort ? { effort: data.change.effort } : {}),
    ...(data.change.addInstructions?.trim() ? { addInstructions: data.change.addInstructions.trim() } : {}),
  };
  if (!Object.keys(change).length) return { ok: false as const, error: "Change one thing: the model, the reasoning effort or the instructions." };
  if (change.model && !models.some((m) => m.id === change.model)) return { ok: false as const, error: `No model ${change.model} is configured.` };
  let base;
  try {
    base = await resolveLabel(principal, o.name, data.base);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
  const rec = await agentStore.getRecord(principal, o.name);
  const scope = rec!.scope;
  const record = applyChange(base.record, change);
  const open = await agentStore.listCandidates(principal, o.name, scope);
  const same = open.find((c) => configFingerprint(c.record) === configFingerprint(record));
  if (same) return { ok: true as const, id: same.id, label: `@${same.id}`, name: same.title };
  const title = uniqueTitle(data.name?.trim() || changeTitle(base.title, change), open);
  const baseVersion = base.candidate?.baseVersion ?? (/^@\d+$/.test(base.label) ? Number(base.label.slice(1)) : await liveVersionOf(principal, o.name, scope));
  const c = await agentStore.saveCandidate(principal, o.name, scope, { title, record, ...(baseVersion != null ? { baseVersion } : {}) });
  return { ok: true as const, id: c.id, label: `@${c.id}`, name: c.title };
}

/**
 * One input's judge question, made a check every input gets: it joins the
 * checks as a new version, and leaves the input, so it is not asked twice.
 */
export async function promoteJudged(principal: Principal, d: { agent: string; datasetId: string; rubricId: string; inputId: string; index: number }) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit have editable checks." };
  const { evals } = await getLatch();
  const rubric = await evals.getRubric(o.owner, d.rubricId);
  if (!rubric) return { ok: false as const, error: "These checks no longer exist." };
  const inputs = await evals.listInputs(d.datasetId);
  const input = inputs.find((i) => i.id === d.inputId);
  const item = input?.facts?.judged?.[d.index];
  if (!input || !item) return { ok: false as const, error: "That question is no longer on this input." };
  const label = item.ask.replace(/\?$/, "").slice(0, 48);
  const check: Check = { kind: "asked", id: checkIdFor(label, rubric.checks.map((c) => c.id)), label, ask: item.ask, shape: item.shape, ...(item.judge ? { judge: item.judge } : {}), because: `Moved from input ${input.id}` };
  const valid = validateChecks([...rubric.checks, check]);
  if (!valid.ok) return { ok: false as const, error: valid.error };
  const saved = await evals.saveRubric({ owner: rubric.owner, id: rubric.id, agentName: rubric.agentName, defaultJudge: rubric.defaultJudge, checks: valid.value });
  const judged = input.facts!.judged!.filter((_, n) => n !== d.index);
  const facts = { ...input.facts };
  if (judged.length) facts.judged = judged;
  else delete facts.judged;
  await evals.setInputs(d.datasetId, inputs.map((i) => (i.id === input.id ? { ...i, facts } : i)));
  return { ok: true as const, version: saved.version, label };
}

/**
 * Save a view — a name and the tags whose inputs it shows. A new one gets an
 * id from its name; the same id updates it.
 */
export async function saveView(principal: Principal, d: { agent: string; datasetId: string; id?: string; name: string; tags: string[] }) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit have views." };
  const { evals } = await getLatch();
  if (!(await evals.getDataset(o.owner, d.datasetId))) return { ok: false as const, error: "That set no longer exists." };
  const name = d.name.trim();
  if (!name) return { ok: false as const, error: "Give the view a name." };
  const tags = cleanTags(d.tags);
  if (!tags.length) return { ok: false as const, error: "Pick at least one tag — a view shows the inputs that carry it." };
  const views = await evals.listViews(d.datasetId);
  // Saving the same name again updates that view — a repeated click or a
  // retry must never stack up copies.
  const existing = (d.id ? views.find((v) => v.id === d.id) : undefined) ?? views.find((v) => v.name.toLowerCase() === name.toLowerCase());
  const id = existing?.id ?? checkIdFor(name, [...views.map((v) => v.id), "all", "overview"]);
  await evals.saveView({ datasetId: d.datasetId, id, name, tags, createdAt: existing?.createdAt ?? Date.now() });
  return { ok: true as const, id };
}

export async function removeView(principal: Principal, d: { agent: string; datasetId: string; id: string }) {
  const o = await ownerFor(principal, d.agent);
  if (!o) return { ok: false as const, error: "Only agents you can edit have views." };
  const { evals } = await getLatch();
  if (!(await evals.getDataset(o.owner, d.datasetId))) return { ok: false as const, error: "That set no longer exists." };
  await evals.removeView(d.datasetId, d.id);
  return { ok: true as const };
}

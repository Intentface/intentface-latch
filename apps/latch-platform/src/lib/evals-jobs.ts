/**
 * Running eval jobs against the real runtime. The logic is in
 * `evals/v2/jobs.ts`; this file supplies the agents, the judges and the
 * clock, and decides who advances a job:
 *
 *   - the request that started it, kept alive with waitUntil on Vercel, or
 *     simply running on in the dev server;
 *   - the minute cron (`/api/cron`, and the dev in-process tick), which
 *     picks up any job whose lease has lapsed — a slice that hit its
 *     deadline, a crashed process, a dev-server restart.
 */
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { parseAgentRef } from "@intentface/latch-agent-builder";
import type { AgentRecord, AgentStore } from "./agent-store";
import { getLatch } from "./latch";
import type { Principal } from "./session";
import { evaluationModelFor } from "./evals/v2/evaluation-model";
import { MAX_UNITS, advanceJob, estimateRun } from "./evals/v2/jobs";
import type { EvalJob } from "./evals/v2/jobs";
import type { ThreadRef, Variant } from "./evals/v2/model";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import { configFingerprint } from "./evals/v2/runner";

/** How long one holder may work before the cron may take over. */
const LEASE_MS = 5 * 60_000;
/** Stop STARTING work this long into a slice; Vercel functions are cut at 300s. */
const SLICE_MS = 4 * 60_000;

/** A record with a variant's one change applied — what its fingerprint is taken from. */
export function applyVariant(rec: AgentRecord, change: Variant["change"]): AgentRecord {
  const add = change.addInstructions?.trim();
  return {
    ...rec,
    ...(change.model ? { modelId: change.model } : {}),
    ...(change.effort ? { exec: { ...rec.exec, effort: change.effort } } : {}),
    ...(add ? { instructions: `${rec.instructions}\n\n${add}` } : {}),
  };
}

/**
 * Resolve `live`, `@draft`, `@3` — or a variant, `~id` — to the
 * configurations they name, right now. A variant's label is its name.
 */
export async function resolveVersions(agentStore: AgentStore, principal: Principal, agentName: string, labels: string[]) {
  const out: { label: string; ref: string; fingerprint: string; modelId?: string }[] = [];
  const live = await agentStore.getRecord(principal, agentName);
  const scope = live?.scope ?? "user";
  for (const asked of labels) {
    let label = asked;
    let variant: Variant | null = null;
    // A variant, by id (`~v_ab12`) or by the name its column shows.
    if (asked.startsWith("~") || (asked !== "live" && !asked.startsWith("@"))) {
      const { evals } = await getLatch();
      const owner = agentOwnerKey(principal, scope);
      variant = asked.startsWith("~")
        ? await evals.getVariant(owner, asked.slice(1))
        : ((await evals.listVariants(owner, agentName)).find((v) => v.name === asked) ?? null);
      if (!variant) throw new Error(asked.startsWith("~") ? "That variant no longer exists." : `${asked} does not exist for ${agentName}.`);
      label = variant.base;
    }
    const ref = label === "live" ? agentName : `${agentName}${label}`;
    const p = parseAgentRef(ref);
    const rec =
      p.at === undefined
        ? live
        : p.at === "draft"
          ? (await agentStore.getDraft(principal, p.name, scope))?.record
          : await agentStore.getVersion(principal, p.name, scope, p.at);
    if (!rec) throw new Error(`${label} does not exist for ${agentName}.`);
    if (variant) {
      const applied = applyVariant(rec, variant.change);
      out.push({ label: variant.name, ref: `${ref}~${variant.id}`, fingerprint: configFingerprint(applied), modelId: applied.modelId });
    } else out.push({ label, ref, fingerprint: configFingerprint(rec), modelId: rec.modelId });
  }
  return out;
}

export type RunRequest = {
  agent: string;
  datasetId: string;
  rubricId: string;
  versions: string[];
  inputIds: string[];
  repeats: number;
  name?: string;
  /** Existing results to compare the new ones against when the run finishes — a baseline that was not re-run. */
  compareWith?: { runId: string; version: string }[];
};

/**
 * Plan and price a run from what this set's earlier threads actually cost.
 * Shared by the New run drawer and the Evals agent, so both quote the same number.
 */
export async function planRun(principal: Principal, d: RunRequest) {
  const { evals, agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(d.agent));
  if (!rec) return { ok: false as const, error: "Only agents you can edit can be run." };
  const owner = agentOwnerKey(principal, rec.scope);
  const rubric = await evals.getRubric(owner, d.rubricId);
  if (!rubric) return { ok: false as const, error: "These checks no longer exist." };
  const repeats = Math.max(1, Math.min(5, Math.floor(d.repeats)));
  const inputs = new Set((await evals.listInputs(d.datasetId)).map((i) => i.id));
  const inputIds = [...new Set(d.inputIds)].filter((id) => inputs.has(id));
  if (!d.versions.length) return { ok: false as const, error: "Pick at least one version." };
  if (!inputIds.length) return { ok: false as const, error: "Pick at least one question." };
  let versions;
  try {
    versions = await resolveVersions(agentStore, principal, rec.name, [...new Set(d.versions)]);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
  const units = versions.length * inputIds.length * repeats;
  if (units > MAX_UNITS) return { ok: false as const, error: `That is ${units} threads; one run is capped at ${MAX_UNITS}.` };
  const past = await evals.listThreads(owner, { datasetId: d.datasetId });
  const costs = await evals.threadCosts(past.filter((t) => !t.error).map((t) => t.threadId));
  const estimate = estimateRun({
    units,
    askedChecks: rubric.checks.filter((c) => c.kind === "asked").length,
    history: [...costs.values()].filter((c) => c > 0),
  });
  // Past answers were mostly the live model's; a version on another model
  // costs what its model costs. Scale each version's share by its price
  // relative to live's — blended 4:1 input to output, as agent turns are.
  const { pricing } = await getLatch();
  const blended = (id: string | undefined) => {
    const pr = id ? pricing(id) : undefined;
    return pr ? pr.inputPer1M * 0.8 + pr.outputPer1M * 0.2 : null;
  };
  const home = blended(rec.modelId);
  const ratios = versions.map((v) => {
    const mine = blended(v.modelId);
    return home && mine ? mine / home : 1;
  });
  const factor = ratios.reduce((a, r) => a + r, 0) / ratios.length;
  if (estimate.cost !== null && Math.abs(factor - 1) > 0.05) {
    const moved = versions.flatMap((v, i) => (Math.abs(ratios[i] - 1) > 0.05 ? [`${v.label} ×${ratios[i].toFixed(1)}`] : []));
    estimate.cost = estimate.cost * factor;
    estimate.basis = `${estimate.basis} Scaled for model prices (${moved.join(", ")}).`;
  }
  // Two labels for one configuration measure noise, not a change.
  const same = versions.filter((v, i) => versions.findIndex((w) => w.fingerprint === v.fingerprint) !== i).map((v) => v.label);
  const reusable = reusableResults(past, versions, inputIds, repeats);
  return { ok: true as const, owner, name: rec.name, versions, inputIds, repeats, estimate, same, reusable };
}

/**
 * Versions that need not run again: an earlier run already has this exact
 * configuration (same fingerprint, whatever it was called then) answering
 * every requested question and try. Comparing against that result saves the
 * threads; the price is that it was answered at another time, so the world
 * — documents, tools, the provider — may have moved in between.
 */
export function reusableResults(
  past: ThreadRef[],
  versions: { label: string; fingerprint: string }[],
  inputIds: string[],
  repeats: number,
): { version: string; runId: string; as: string; at: number }[] {
  const out: { version: string; runId: string; as: string; at: number }[] = [];
  for (const v of versions) {
    // A result is one label in one run — how the comparison picks its threads.
    const results = new Map<string, { runId: string; as: string; covered: Set<string>; at: number }>();
    for (const t of past) {
      if (t.error || !t.runId || t.configFingerprint !== v.fingerprint || !t.inputId) continue;
      const key = `${t.runId}|${t.version}`;
      const r = results.get(key) ?? results.set(key, { runId: t.runId, as: t.version, covered: new Set(), at: t.createdAt }).get(key)!;
      r.covered.add(`${t.inputId}|${t.attempt ?? 0}`);
      r.at = Math.max(r.at, t.createdAt);
    }
    const best = [...results.values()]
      .filter((r) => inputIds.every((id) => Array.from({ length: repeats }, (_, a) => r.covered.has(`${id}|${a}`)).every(Boolean)))
      .sort((a, b) => b.at - a.at)
      .at(0);
    if (best) out.push({ version: v.label, runId: best.runId, as: best.as, at: best.at });
  }
  return out;
}

/**
 * Start a planned run. The caller passes the cost that was shown to the
 * person; if the price has risen since, nothing starts — a person confirms
 * the number that will be spent, not an earlier one.
 */
export async function startPlannedRun(principal: Principal, d: RunRequest, confirmedCost: number | null) {
  const p = await planRun(principal, d);
  if (!p.ok) return p;
  const cost = p.estimate.cost;
  if (cost !== null && (confirmedCost === null || cost > confirmedCost * 1.05 + 0.01))
    return { ok: false as const, error: `The estimate changed to about $${cost.toFixed(2)}. Check it and start again.` };
  const { evals } = await getLatch();
  const now = Date.now();
  const id = `run_${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: EvalJob = {
    owner: p.owner,
    id,
    runId: id,
    kind: "run",
    ...(d.name?.trim() ? { name: d.name.trim().slice(0, 80) } : {}),
    ...(d.compareWith?.length ? { compareWith: d.compareWith.slice(0, 6) } : {}),
    agentName: p.name,
    datasetId: d.datasetId,
    rubricId: d.rubricId,
    principal: { orgId: principal.orgId, ...(principal.userId ? { userId: principal.userId } : {}) },
    versions: p.versions,
    inputIds: p.inputIds,
    repeats: p.repeats,
    status: "running",
    total: p.estimate.agentRuns,
    done: 0,
    failed: 0,
    estimate: p.estimate,
    createdAt: now,
    updatedAt: now,
    leaseUntil: 0,
  };
  await evals.saveJob(job);
  await kickJob(p.owner, id);
  return { ok: true as const, id, estimate: p.estimate };
}

export type AgainRequest = {
  agent: string;
  datasetId: string;
  rubricId: string;
  /** Existing results to add a try to: a run, one of its versions, the inputs to answer again. */
  targets: { runId: string; version: string; inputIds: string[] }[];
};

/**
 * Plan answering again: one more try per input, into the run the answers
 * already live in, so the new try sits beside the old in the same column.
 * Refused for a version that has changed since — those answers would be a
 * different configuration, which belongs in a column of its own.
 */
export async function planAgain(principal: Principal, d: AgainRequest) {
  const { evals, agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(d.agent));
  if (!rec) return { ok: false as const, error: "Only agents you can edit can be run." };
  const owner = agentOwnerKey(principal, rec.scope);
  const rubric = await evals.getRubric(owner, d.rubricId);
  if (!rubric) return { ok: false as const, error: "These checks no longer exist." };
  const inputs = new Set((await evals.listInputs(d.datasetId)).map((i) => i.id));
  const targets = [];
  for (const t of d.targets) {
    const inputIds = [...new Set(t.inputIds)].filter((id) => inputs.has(id));
    if (!inputIds.length) continue;
    const threads = (await evals.listThreads(owner, { datasetId: d.datasetId, runId: t.runId })).filter((x) => x.version === t.version);
    let version;
    try {
      [version] = await resolveVersions(agentStore, principal, rec.name, [t.version]);
    } catch (e) {
      targets.push({ ...t, inputIds, ok: false as const, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const then = threads.find((x) => x.configFingerprint)?.configFingerprint;
    if (then && then !== version.fingerprint) {
      targets.push({ ...t, inputIds, ok: false as const, error: `${t.version} has changed since these answers. Run it as a new column instead.` });
      continue;
    }
    const tryOf = Object.fromEntries(inputIds.map((id) => [id, Math.max(-1, ...threads.filter((x) => x.inputId === id).map((x) => x.attempt ?? 0)) + 1]));
    targets.push({ ...t, inputIds, ok: true as const, version, tryOf });
  }
  const units = targets.reduce((a, t) => a + (t.ok ? t.inputIds.length : 0), 0);
  if (!targets.length) return { ok: false as const, error: "Pick at least one answer." };
  if (units > MAX_UNITS) return { ok: false as const, error: `That is ${units} threads; one run is capped at ${MAX_UNITS}.` };
  const past = await evals.listThreads(owner, { datasetId: d.datasetId });
  const costs = await evals.threadCosts(past.filter((t) => !t.error).map((t) => t.threadId));
  const estimate = estimateRun({
    units,
    askedChecks: rubric.checks.filter((c) => c.kind === "asked").length,
    history: [...costs.values()].filter((c) => c > 0),
  });
  return { ok: true as const, owner, name: rec.name, targets, estimate };
}

/** Start answering again: a job per result, each adding its tries to its own run. */
export async function startAgain(principal: Principal, d: AgainRequest, confirmedCost: number | null) {
  const p = await planAgain(principal, d);
  if (!p.ok) return p;
  const cost = p.estimate.cost;
  if (cost !== null && (confirmedCost === null || cost > confirmedCost * 1.05 + 0.01))
    return { ok: false as const, error: `The estimate changed to about $${cost.toFixed(2)}. Check it and start again.` };
  const { evals } = await getLatch();
  const ids: string[] = [];
  for (const t of p.targets) {
    if (!t.ok) continue;
    const now = Date.now();
    const id = `again_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await evals.saveJob({
      owner: p.owner,
      id,
      runId: t.runId,
      kind: "run",
      agentName: p.name,
      datasetId: d.datasetId,
      rubricId: d.rubricId,
      principal: { orgId: principal.orgId, ...(principal.userId ? { userId: principal.userId } : {}) },
      versions: [t.version],
      inputIds: t.inputIds,
      repeats: 1,
      tryOf: t.tryOf,
      status: "running",
      total: t.inputIds.length,
      done: 0,
      failed: 0,
      estimate: { ...p.estimate, agentRuns: t.inputIds.length },
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
    });
    await kickJob(p.owner, id);
    ids.push(id);
  }
  return { ok: true as const, ids, skipped: p.targets.filter((t) => !t.ok).map((t) => ({ version: t.version, error: t.error })) };
}

/** Re-score an existing run under the latest checks. Only the judge runs, never the agent. */
export async function startJudgeJob(principal: Principal, data: { agent: string; datasetId: string; rubricId: string; runId: string; threadIds?: string[] }) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(data.agent));
  const o = rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
  if (!o) return { ok: false as const, error: "Only agents you can edit can be judged." };
  const { evals } = await getLatch();
  const only = data.threadIds?.length ? new Set(data.threadIds) : null;
  const threads = (await evals.listThreads(o.owner, { datasetId: data.datasetId, runId: data.runId })).filter((t) => !only || only.has(t.threadId));
  if (!threads.length) return { ok: false as const, error: "That run has no threads." };
  const now = Date.now();
  const id = `judge_${now.toString(36)}`;
  const ok = threads.filter((t) => !t.error).length;
  await evals.saveJob({
    owner: o.owner,
    id,
    runId: data.runId,
    kind: "judge",
    agentName: o.name,
    datasetId: data.datasetId,
    rubricId: data.rubricId,
    principal: { orgId: principal.orgId, ...(principal.userId ? { userId: principal.userId } : {}) },
    versions: [],
    inputIds: [],
    repeats: 1,
    ...(only ? { threadIds: [...only] } : {}),
    status: "running",
    total: ok,
    done: 0,
    failed: 0,
    estimate: { agentRuns: 0, judgeCalls: ok, cost: null, basis: "Judging only: the agent does not run." },
    createdAt: now,
    updatedAt: now,
    leaseUntil: 0,
  });
  await kickJob(o.owner, id);
  return { ok: true as const, id };
}

/** Advance one job while this caller holds its lease. Never throws. */
export async function processJob(owner: string, id: string): Promise<void> {
  const { evals, runtime, modelFor } = await getLatch();
  // In a long-lived process keep going slice after slice; on Vercel one
  // slice per invocation, and the cron continues.
  for (;;) {
    const now = Date.now();
    if (!(await evals.claimJob(id, now, LEASE_MS))) return;
    const job = await evals.getJob(owner, id);
    if (!job) return;
    const principal = job.principal as Principal;
    const judges = new Map<string, ReturnType<typeof evaluationModelFor>>();
    const end = await advanceJob(
      job,
      {
        run: {
          runAgent: ({ agent, prompt, threadId }) =>
            runtime.runAgent({
              principal,
              agent,
              prompt,
              ...(threadId ? { threadId } : {}),
              // Actions are simulated, never performed: an eval must not send
              // the email it is testing whether the agent would send.
              blockGated: "simulate-success",
              // Each thread must be an independent observation.
              memory: false,
            }),
        },
        judge: {
          loadHistory: (chatId) => runtime.loadHistory({ chatId, principal }),
          judgeFor: (jid) => judges.get(jid) ?? judges.set(jid, evaluationModelFor(jid, modelFor, typeSafeAi)).get(jid)!,
        },
        loadInputs: () => evals.listInputs(job.datasetId),
        loadDataset: async () => (await evals.getDataset(owner, job.datasetId)) ?? { id: job.datasetId, agentName: job.agentName },
        loadRubric: () => evals.getRubric(owner, job.rubricId),
        threadsOf: (runId) => evals.listThreads(owner, { runId }),
        saveThread: (t) => evals.saveThread(t),
        verdictsOf: (threadIds, v) => evals.listVerdicts({ threadIds, rubricVersion: v }),
        saveVerdicts: (vs) => evals.saveVerdicts(vs),
        update: (patch) => evals.updateJob(id, patch),
      },
      { deadline: now + SLICE_MS },
    ).catch((e: unknown) => {
      console.error(`[evals] job ${id} failed:`, e);
      return null;
    });
    // Hand the lease back, so the next tick need not wait for it to lapse.
    await evals.updateJob(id, { leaseUntil: 0 }).catch(() => null);
    if (!end || end.status === "done" || end.status === "failed" || end.status === "cancelled") return;
    if (process.env.VERCEL) return;
  }
}

/** Start advancing a job without holding up the response. */
export async function kickJob(owner: string, id: string) {
  const p = processJob(owner, id);
  if (process.env.VERCEL) {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(p);
  } else void p;
}

/** The cron's share: pick up jobs whose lease lapsed. */
export async function evalJobsTick(): Promise<{ advanced: number }> {
  const { evals } = await getLatch();
  const open = await evals.claimableJobs(Date.now());
  // In parallel: each holds its own lease, and one long job must not starve the rest.
  await Promise.all(open.map((j) => processJob(j.owner, j.id)));
  return { advanced: open.length };
}

export type { EvalJob };

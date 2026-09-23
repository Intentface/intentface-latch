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
import type { AgentStore } from "./agent-store";
import { getLatch } from "./latch";
import type { Principal } from "./session";
import { evaluationModelFor } from "./evals/v2/evaluation-model";
import { MAX_UNITS, advanceJob, estimateRun } from "./evals/v2/jobs";
import type { EvalJob } from "./evals/v2/jobs";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import { configFingerprint } from "./evals/v2/runner";

/** How long one holder may work before the cron may take over. */
const LEASE_MS = 5 * 60_000;
/** Stop STARTING work this long into a slice; Vercel functions are cut at 300s. */
const SLICE_MS = 4 * 60_000;

/** Resolve `live`, `@draft`, `@3` to the configurations they name, right now. */
export async function resolveVersions(agentStore: AgentStore, principal: Principal, agentName: string, labels: string[]) {
  const out: { label: string; ref: string; fingerprint: string }[] = [];
  const live = await agentStore.getRecord(principal, agentName);
  const scope = live?.scope ?? "user";
  for (const label of labels) {
    const ref = label === "live" ? agentName : `${agentName}${label}`;
    const p = parseAgentRef(ref);
    const rec =
      p.at === undefined
        ? live
        : p.at === "draft"
          ? (await agentStore.getDraft(principal, p.name, scope))?.record
          : await agentStore.getVersion(principal, p.name, scope, p.at);
    if (!rec) throw new Error(`${label} does not exist for ${agentName}.`);
    out.push({ label, ref, fingerprint: configFingerprint(rec) });
  }
  return out;
}

export type RunRequest = { agent: string; datasetId: string; rubricId: string; versions: string[]; inputIds: string[]; repeats: number };

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
  const past = await evals.listThreads(owner, { datasetId: d.datasetId, limit: 400 });
  const costs = await evals.threadCosts(past.filter((t) => !t.error).map((t) => t.threadId));
  const estimate = estimateRun({
    units,
    askedChecks: rubric.checks.filter((c) => c.kind === "asked").length,
    history: [...costs.values()].filter((c) => c > 0),
  });
  // Two labels for one configuration measure noise, not a change.
  const same = versions.filter((v, i) => versions.findIndex((w) => w.fingerprint === v.fingerprint) !== i).map((v) => v.label);
  return { ok: true as const, owner, name: rec.name, versions, inputIds, repeats, estimate, same };
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

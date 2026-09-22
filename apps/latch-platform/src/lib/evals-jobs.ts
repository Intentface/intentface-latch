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
import { advanceJob } from "./evals/v2/jobs";
import type { EvalJob } from "./evals/v2/jobs";
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

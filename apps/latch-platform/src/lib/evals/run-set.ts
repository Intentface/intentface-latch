import type { Principal } from "../session";
import { getLatch } from "../latch";
import { normalizeAgentName, evalOwnerOfRecord } from "../agent-store";
import { runEvalCases } from "./run";
import { EXPLAIN_MODEL_ID, JUDGE_MODEL_ID } from "./judge";
import { judgeModel } from "./judge-model";
import type { EvalCaseResult, EvalRun, JsonValue } from "./store";

/**
 * Lives here, apart from `server.ts`, on purpose.
 *
 * Route files are part of the ROUTER's module graph, so anything a route
 * imports is walked by the client build too. `server.ts` is safe to import
 * from a server FUNCTION (those are stripped from the client bundle) and not
 * from a plain API route: it pulls in the Slack and Langfuse packages, and
 * through them an optional peer nobody installs, which the dep pre-bundler
 * cannot see is guarded. This module imports only what running a set needs.
 */

/**
 * Run a whole set against one configuration of an agent.
 *
 * Extracted from the server function so it can also be driven by the streaming
 * route: a set of five cases on a real model takes the better part of a minute,
 * and a button that goes grey for a minute cannot say whether it is working,
 * stuck, or nearly finished. `onCase` fires as each case lands, in completion
 * order, so the caller can show results arriving instead of a spinner.
 */
export async function runEvalSet(opts: {
  principal: Principal;
  agent: string;
  name: string;
  version?: number | "draft";
  /** Fires as each case finishes, in completion order. */
  onCase?: (result: EvalCaseResult, done: number, total: number) => void;
  /** Fires once the case list is known, before any of them has run. */
  onStart?: (cases: { id: string; name: string }[]) => void;
}): Promise<
  { ok: true; run: EvalRun; ref: string } | { ok: false; error: string }
> {
  const { principal } = opts;
  const { runtime, agentStore, evalStore, modelFor } = await getLatch();
  const agentName = normalizeAgentName(opts.agent);
  const rec = await agentStore.getRecord(principal, agentName);
  if (!rec) return { ok: false, error: `No editable agent "${agentName}".` };

  const owner = evalOwnerOfRecord(principal, rec);
  const set = await evalStore.getSet(owner, agentName, opts.name);
  if (!set?.cases.length) return { ok: false, error: `Eval set "${opts.name}" is empty.` };

  const ref = opts.version === undefined ? agentName : `${agentName}@${opts.version}`;
  // What the column SAYS. The bare agent name is what the resolver needs and
  // useless as a label: five runs of the live config all read "hn-digest"
  // and nothing distinguishes them.
  const label = opts.version === undefined ? "live" : `@${opts.version}`;
  // Snapshot what ACTUALLY ran, not what is live: a run compared later is
  // only interpretable next to the configuration that produced it.
  const snapshot =
    typeof opts.version === "number"
      ? ((await agentStore.getVersion(principal, agentName, rec.scope ?? "user", opts.version)) ?? null)
      : opts.version === "draft"
        ? ((await agentStore.getDraft(principal, agentName, rec.scope ?? "user"))?.record ?? null)
        : rec;
  if (!snapshot) return { ok: false, error: `No configuration "${ref}".` };

  opts.onStart?.(set.cases.map((c) => ({ id: c.id, name: c.name })));

  const startedAt = Date.now();
  const judgeUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const needsJudge = set.cases.some((c) => c.expected.rubric?.length);
  const needsChecks =
    Object.keys(set.checks ?? {}).length > 0 ||
    set.cases.some((c) => c.checks && Object.keys(c.checks).length > 0);
  const results = await runEvalCases({
    runtime,
    principal,
    agent: ref,
    cases: set.cases,
    // The case tier's plain-language criteria still use a TEXT judge: it
    // returns a reason per criterion, which the results card shows.
    ...(needsJudge ? { judgeModel: modelFor(EXPLAIN_MODEL_ID) } : {}),
    // A case's typed `checks` go to the same evaluation judge that answers
    // questions about live traffic — one judge, one vocabulary.
    ...(needsChecks ? { judge: judgeModel(JUDGE_MODEL_ID), sharedChecks: set.checks } : {}),
    onJudgeUsage: (u) => {
      judgeUsage.calls += u.calls;
      judgeUsage.inputTokens += u.inputTokens;
      judgeUsage.outputTokens += u.outputTokens;
    },
    ...(opts.onCase ? { onResult: opts.onCase } : {}),
  });

  // What the AGENT cost: the eval threads are real runs, so their rows carry
  // usage and cost already. Judging is billed separately and is usually
  // rounding error beside it — which is itself worth being able to see.
  const threadIds = [...new Set(results.map((r) => r.threadId).filter(Boolean) as string[])];
  const agent = await evalStore.costOfThreads(threadIds);

  const run = await evalStore.saveRun({
    owner,
    agentName,
    setName: opts.name,
    // An AgentRecord is JSON by construction — it round-trips through the
    // agents table as a JSON column — but it is not provably so to the type
    // checker, because `trigger` is deliberately opaque there.
    agentSnapshot: snapshot as unknown as JsonValue,
    results,
    passCount: results.filter((r) => r.pass).length,
    failCount: results.filter((r) => !r.pass).length,
    judgeModelId: needsJudge ? EXPLAIN_MODEL_ID : null,
    configRef: label,
    metrics: {
      durationMs: Date.now() - startedAt,
      agentCost: agent.cost,
      agentTokensIn: agent.tokensIn,
      agentTokensOut: agent.tokensOut,
      judgeCalls: judgeUsage.calls,
      judgeTokensIn: judgeUsage.inputTokens,
      judgeTokensOut: judgeUsage.outputTokens,
    },
  });
  return { ok: true, run, ref };
}


/**
 * One-shot end-to-end verification of the Langfuse integration (M2–M7):
 * creates a rubric'd agent, runs it for real, posts user feedback, then reads
 * the trace + scores back through the same paths /observability uses.
 *
 *   cd apps/latch-platform && node --env-file=.env --import tsx src/scripts/verify-langfuse.ts
 */
import {
  traceIdForRun,
  postScore,
  listOwnerTraces,
  getLangfuseClient,
  isLangfuseConfigured,
} from "@intentface/latch-langfuse";
import { getLatch, ownerTagOf } from "../lib/latch";
import type { Principal } from "../lib/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!isLangfuseConfigured()) throw new Error("LANGFUSE_* env vars missing");
  const principal: Principal = { orgId: "lf-verify-org", userId: "lf-verify-user" } as Principal;
  const { runtime, agentStore } = await getLatch();

  let ok = false;
  try {
  console.log("[1] upsert agent lf-verify with one binary rubric…");
  await agentStore.upsert(principal, {
    name: "lf-verify",
    title: "LF Verify",
    modelId: "claude-haiku-4-5",
    instructions: "You are a terse math assistant. Answer with just the number.",
    connections: [],
    attachedEvals: [
      {
        name: "answers-directly",
        prompt: "The answer directly and correctly answers the user's math question.",
        scale: "binary",
        enabled: true,
      },
    ],
    scope: "user",
  });

  console.log("[2] run the agent for real (traced + judged)…");
  const { threadId, answer } = await runtime.runAgent({
    principal,
    agent: "lf-verify",
    prompt: "What is 2+2?",
  });
  console.log("    answer:", JSON.stringify(answer).slice(0, 80));

  const runs = await runtime.listRuns({ principal });
  const run = runs.find((r) => r.chatId === threadId);
  if (!run) throw new Error("run not found");
  const traceId = await traceIdForRun(run.id);
  console.log("    runId:", run.id, "→ traceId:", traceId);

  console.log("[3] post user feedback on the run…");
  await postScore({
    runId: run.id,
    name: "user-feedback",
    value: 1,
    comment: "verification 👍",
    dataType: "NUMERIC",
  });

  console.log("[4] wait for ingestion, then read back…");
  const client = getLangfuseClient();
  let trace: Awaited<ReturnType<typeof client.api.trace.get>> | undefined;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    try {
      trace = await client.api.trace.get(traceId);
      if ((trace.scores?.length ?? 0) >= 2) break; // judge + feedback landed
    } catch {
      /* not ingested yet */
    }
    console.log(`    …waiting (${(i + 1) * 5}s)`);
  }
  if (!trace) throw new Error("trace never appeared in Langfuse — seeding failed?");

  console.log("    trace name:", trace.name);
  console.log("    sessionId:", trace.sessionId, "(expect", `${threadId})`);
  console.log("    userId:", trace.userId, "(expect", `${ownerTagOf(principal)})`);
  console.log("    tags:", JSON.stringify(trace.tags));
  console.log("    observations:", trace.observations?.length ?? 0);
  console.log("    htmlPath:", trace.htmlPath);

  const scores = await client.api.scores.getMany({ userId: ownerTagOf(principal), limit: 20 });
  const mine = (scores.data ?? []).filter((s) => (s as { traceId?: string }).traceId === traceId);
  console.log("    scores on trace:", mine.map((s) => `${s.name}=${(s as { value?: unknown }).value} (${s.comment ?? ""})`));

  console.log("[5] observability feed path (listOwnerTraces)…");
  const feed = await listOwnerTraces({ ownerTag: ownerTagOf(principal), limit: 10 });
  const row = feed.find((t) => t.runId === run.id);
  console.log("    feed row:", row && {
    runId: row.runId,
    agent: row.agent,
    latency: row.latency,
    cost: row.totalCost,
    scores: row.scores.map((s) => `${s.name}=${s.value}`),
    htmlPath: row.htmlPath,
  });

  ok = Boolean(
    trace.tags?.includes(`run:${run.id}`) &&
      trace.sessionId === threadId &&
      trace.userId === ownerTagOf(principal) &&
      mine.some((s) => s.name === "answers-directly") &&
      mine.some((s) => s.name === "user-feedback") &&
      !!row,
  );
  console.log(ok ? "\nALL CHECKS PASSED ✓" : "\nSOME CHECKS FAILED ✗");
  } finally {
    // Always remove the seeded verification agent — even if a step above threw
    // — so a failed run leaves no residue (mirrors verify-live-evals).
    await agentStore.remove(principal, "user", "lf-verify").catch(() => {});
  }
  // exitCode (not exit()) so the finally block runs before the process ends.
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

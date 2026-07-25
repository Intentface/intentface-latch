/**
 * Headless end-to-end check of the chat live-evals backend (no browser/auth):
 * run the agent → live judge dual-writes to the local store → re-judge a draft
 * rubric → save. Proves the server-side loop the chat drawer drives.
 *   node --env-file=.env --import tsx src/scripts/verify-live-evals.ts
 */
import { getLatch, ownerTagOf } from "../lib/latch";
import type { Principal } from "../lib/session";
import { rejudgeRun } from "../lib/observability/judge-run";
import { validateRubrics } from "../lib/observability/rubrics";
import type { AttachedEval } from "../lib/agent-store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userId = "verify-live-evals-user";
  const principal: Principal = { orgId: `user:${userId}`, userId };
  const ownerTag = ownerTagOf(principal);
  const { agentStore, runScores, runtime, models } = await getLatch();

  const rubric: AttachedEval = {
    name: "one-sentence",
    prompt: "The answer is a single short sentence.",
    scale: "binary",
    enabled: true,
  };
  console.log("[1] seed agent + rubric…");
  await agentStore.upsert(principal, {
    name: "le-verify",
    title: "LE Verify",
    modelId: "claude-haiku-4-5",
    instructions: "You are terse. Answer in one short sentence.",
    connections: [],
    attachedEvals: [rubric],
    scope: "user",
  });

  console.log("[2] run the agent (live judge fires in afterRun)…");
  const { threadId, answer } = await runtime.runAgent({
    principal,
    agent: "le-verify",
    prompt: "What is the capital of France?",
  });
  console.log("    answer:", JSON.stringify(answer).slice(0, 70));

  const history = await runtime.loadHistory({ chatId: threadId, principal });
  const runId = history
    .map((m) => (m as { metadata?: { runId?: string } }).metadata?.runId)
    .filter(Boolean)
    .pop();
  if (!runId) throw new Error("no runId on assistant message");
  console.log("    threadId:", threadId, "runId:", runId);

  console.log("[3] local store has the live verdict?");
  let live: Awaited<ReturnType<typeof runScores.getForRuns>> = new Map();
  for (let i = 0; i < 10; i++) {
    live = await runScores.getForRuns(ownerTag, [runId]);
    if ((live.get(runId)?.length ?? 0) > 0) break;
    await sleep(1000);
  }
  const liveScores = live.get(runId) ?? [];
  console.log("    live:", liveScores.map((s) => `${s.rubricName}=${s.value} (${s.source})`));

  console.log("[4] re-judge a stricter DRAFT rubric (local only)…");
  const draft: AttachedEval[] = [
    { ...rubric, prompt: "The answer is EXACTLY one sentence and names a specific city." },
  ];
  const verdicts = await rejudgeRun({ principal, chatId: threadId, runId, rubrics: draft });
  console.log("    rejudge verdicts:", verdicts.map((v) => `${v.rubric.name}=${v.value}`));
  const after = (await runScores.getForRuns(ownerTag, [runId])).get(runId) ?? [];
  const rejudged = after.find((s) => s.rubricName === "one-sentence");
  console.log("    local now:", after.map((s) => `${s.rubricName}=${s.value} (${s.source})`));

  console.log("[5] save path (validate + upsert)…");
  const valid = validateRubrics(draft, (id) => models.some((m) => m.id === id));
  if (!valid.ok) throw new Error("validation failed: " + valid.error);
  await agentStore.upsert(principal, {
    ...(await agentStore.getRecord(principal, "le-verify"))!,
    attachedEvals: valid.rubrics,
  });
  const saved = await agentStore.getRecord(principal, "le-verify");
  console.log("    saved rubric prompt:", saved?.attachedEvals?.[0]?.prompt?.slice(0, 50));

  const ok =
    liveScores.some((s) => s.rubricName === "one-sentence" && s.source === "live") &&
    verdicts.length === 1 &&
    rejudged?.source === "rejudge" &&
    saved?.attachedEvals?.[0]?.prompt.startsWith("The answer is EXACTLY");
  console.log(ok ? "\nALL CHECKS PASSED ✓" : "\nSOME CHECKS FAILED ✗");

  // Cleanup the throwaway verify agent.
  await agentStore.remove(principal, "user", "le-verify");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

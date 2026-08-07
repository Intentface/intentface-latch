import type { AppMessage, StorageAdapter } from "@intentface/latch-core";
import type { MemoryJobStore } from "@intentface/latch-memory";

/**
 * Dialect-shared smoke for the MemoryJobStore: candidate gating (idle /
 * watermark / lease), claim races, completion fencing, scope touch/claim/
 * complete, and usage upserts. Called by both `smoke.ts` and `smoke.pg.ts`
 * with their dialect's stores.
 */
export async function memoryJobStoreSmoke<P extends { org: string; user?: string }>(args: {
  jobs: MemoryJobStore;
  store: StorageAdapter<P>;
  principal: P;
  assert: (cond: boolean, msg: string) => void;
}): Promise<void> {
  const { jobs, store, principal: me, assert } = args;
  const HOUR = 3_600_000;

  const chat = await store.createChat(me, { agent: "mem-coach" });
  const msg = (id: string, role: "user" | "assistant", text: string): AppMessage => ({
    id,
    role,
    parts: [{ type: "text", text }],
    metadata: { visibility: "user", createdAt: Date.now() },
  });
  await store.appendMessages(chat.id, [msg("m1", "user", "hello"), msg("m2", "assistant", "hi!")]);
  await store.createRun(me, { chatId: chat.id, agent: "mem-coach" });

  const t0 = Date.now();
  const fresh = await jobs.listExtractionCandidates({
    now: t0,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(fresh.length === 0, "active chat is idle-gated out of extraction");

  const t1 = t0 + 2 * HOUR;
  const cands = await jobs.listExtractionCandidates({
    now: t1,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(cands.length === 1 && cands[0]!.chatId === chat.id, "idle chat becomes a candidate");
  assert(cands[0]!.lastExtractedSeq === -1 && cands[0]!.maxSeq === 1, "candidate carries seq range");
  const otherAgent = await jobs.listExtractionCandidates({
    now: t1,
    idleMs: HOUR,
    agents: ["someone-else"],
    limit: 10,
  });
  assert(otherAgent.length === 0, "agent filter applies");

  const identity = await jobs.latestRunIdentity(chat.id);
  assert(JSON.stringify(identity) === JSON.stringify(me), "latest run identity round-trips");

  const msgs = await jobs.messagesAfter(chat.id, -1, 10_000);
  assert(
    msgs.length === 2 && msgs[0]!.text === "hello" && msgs[1]!.seq === 1,
    "messagesAfter returns ordered plain text",
  );
  const capped = await jobs.messagesAfter(chat.id, -1, 3);
  assert(capped.length === 1 && capped[0]!.text.length <= 4, "messagesAfter respects the char cap");

  const meta = { owner: cands[0]!.owner, agent: "mem-coach", scopeKey: "conn:_memory/mem-coach/u-x" };
  assert(
    (await jobs.claimChatExtraction(chat.id, meta, "node1", 60_000, t1)) === true,
    "first extraction claim wins",
  );
  assert(
    (await jobs.claimChatExtraction(chat.id, meta, "node2", 60_000, t1)) === false,
    "second concurrent claim loses",
  );
  const whileLeased = await jobs.listExtractionCandidates({
    now: t1,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(whileLeased.length === 0, "leased chat is not re-listed");

  await jobs.completeChatExtraction(
    chat.id,
    { lastExtractedSeq: 1, ok: true, nextEligibleAt: t1 + HOUR },
    "node2", // wrong lease owner — must be a fenced no-op
  );
  await jobs.completeChatExtraction(
    chat.id,
    { lastExtractedSeq: 1, extractionKey: "x1:aaaa", ok: true, nextEligibleAt: t1 + HOUR },
    "node1",
  );
  const afterDone = await jobs.listExtractionCandidates({
    now: t1 + 3 * HOUR,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(afterDone.length === 0, "fully extracted chat (watermark = maxSeq) is not a candidate");

  // ---- extraction idempotency key ----
  await store.appendMessages(chat.id, [msg("m3", "user", "one more thing")]);
  const withKey = await jobs.listExtractionCandidates({
    now: t1 + 5 * HOUR,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(
    withKey.length === 1 && withKey[0]!.lastExtractedKey === "x1:aaaa",
    "candidate carries the last completed run's idempotency key",
  );
  assert(
    (await jobs.claimChatExtraction(chat.id, meta, "node1", 60_000, t1 + 5 * HOUR)) === true,
    "chat with new messages is claimable again",
  );
  // A FAILED attempt must not clobber the key (nor advance the watermark) —
  // the window stays retryable under its previous identity.
  await jobs.completeChatExtraction(
    chat.id,
    { extractionKey: "x1:bbbb", ok: false, nextEligibleAt: t1 + 5 * HOUR },
    "node1",
  );
  const afterFail = await jobs.listExtractionCandidates({
    now: t1 + 6 * HOUR,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(
    afterFail.length === 1 &&
      afterFail[0]!.lastExtractedKey === "x1:aaaa" &&
      afterFail[0]!.lastExtractedSeq === 1,
    "failed completion leaves key and watermark untouched (retryable)",
  );
  assert(
    (await jobs.claimChatExtraction(chat.id, meta, "node1", 60_000, t1 + 6 * HOUR)) === true,
    "failed chat is claimable again after backoff",
  );
  await jobs.completeChatExtraction(
    chat.id,
    { lastExtractedSeq: 2, extractionKey: "x1:cccc", ok: true, nextEligibleAt: t1 + 7 * HOUR },
    "node1",
  );
  const afterTombstone = await jobs.listExtractionCandidates({
    now: t1 + 9 * HOUR,
    idleMs: HOUR,
    agents: ["mem-coach"],
    limit: 10,
  });
  assert(
    afterTombstone.length === 0,
    "completed run (even zero-yield) tombstones the window via watermark + key",
  );

  // ---- scope consolidation state ----
  const scopeKey = "conn:_memory/mem-coach/u-x";
  await jobs.touchScope(
    {
      scopeKey,
      owner: meta.owner,
      agent: "mem-coach",
      connection: "conn",
      identity: me,
      episodePath: "_memory/mem-coach/u-x/episodes/2026-07-27-10-00-a.md",
    },
    { cooldownMs: 1_000, now: t1 },
  );
  await jobs.touchScope(
    {
      scopeKey,
      owner: meta.owner,
      agent: "mem-coach",
      connection: "conn",
      identity: me,
      episodePath: "_memory/mem-coach/u-x/episodes/2026-07-27-11-00-b.md",
    },
    { cooldownMs: 1_000, now: t1 },
  );
  const scopes = await jobs.listConsolidationCandidates({ now: t1 + 2_000, limit: 10 });
  assert(
    scopes.length === 1 && scopes[0]!.pendingEpisodes.length === 2,
    "touched scope is due with its pending episodes",
  );
  assert(
    JSON.stringify(scopes[0]!.identity) === JSON.stringify(me),
    "scope carries the touch identity",
  );

  assert(
    (await jobs.claimScopeConsolidation(scopeKey, "node1", 60_000, t1 + 2_000)) === true,
    "first consolidation claim wins",
  );
  assert(
    (await jobs.claimScopeConsolidation(scopeKey, "node2", 60_000, t1 + 2_000)) === false,
    "second consolidation claim loses",
  );
  await jobs.completeScopeConsolidation(
    scopeKey,
    {
      ok: true,
      watermark: "2026-07-27-10-00-a.md",
      nextEligibleAt: t1 + HOUR,
      // Only the first episode was folded in — the second must survive.
      consumedEpisodes: ["_memory/mem-coach/u-x/episodes/2026-07-27-10-00-a.md"],
    },
    "node1",
  );
  const remaining = await jobs.listConsolidationCandidates({ now: t1 + 2 * HOUR, limit: 10 });
  assert(
    remaining.length === 1 && remaining[0]!.pendingEpisodes.length === 1,
    "unconsumed episode keeps the scope dirty",
  );
  assert(
    (await jobs.claimScopeConsolidation(scopeKey, "node1", 60_000, t1 + 2 * HOUR)) === true,
    "scope claimable again after cooldown",
  );
  await jobs.completeScopeConsolidation(
    scopeKey,
    {
      ok: true,
      watermark: "2026-07-27-11-00-b.md",
      nextEligibleAt: t1 + 3 * HOUR,
      consumedEpisodes: ["_memory/mem-coach/u-x/episodes/2026-07-27-11-00-b.md"],
    },
    "node1",
  );
  const clean = await jobs.listConsolidationCandidates({ now: t1 + 100 * HOUR, limit: 10 });
  assert(clean.length === 0, "fully consolidated scope is clean (hasNew cleared)");

  // ---- usage / retention ----
  await jobs.recordUsage(scopeKey, ["m-aaaaaa"], t1);
  await jobs.recordUsage(scopeKey, ["m-aaaaaa", "m-bbbbbb"], t1 + 5);
  const usage = await jobs.usageFor(scopeKey);
  const a = usage.find((u) => u.memoryId === "m-aaaaaa");
  const b = usage.find((u) => u.memoryId === "m-bbbbbb");
  assert(a?.usageCount === 2 && a.lastUsedAt === t1 + 5, "usage upsert increments + stamps");
  assert(b?.usageCount === 1, "new memory id starts at 1");
}

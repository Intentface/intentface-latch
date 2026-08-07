import type { MemoryConfig } from "@intentface/latch-core";
import {
  buildConsolidationPrompt,
  buildExtractionPrompt,
  extractionRunKey,
  parseIndex,
  scopeLabelOf,
  scopeRefOf,
} from "@intentface/latch-memory";
import type { ScopeRef } from "@intentface/latch-memory";
import { memoryEnabledCodeAgents } from "@/agents/memory-enabled";
import type { Principal } from "../session";
import { memoryAgentOf } from "./agent-identity";
import type {
  MemoryConsolidationTurnContext,
  MemoryExtractionTurnContext,
} from "./turn-context";
import {
  MEMORY_CONSOLIDATION_LEASE_MS,
  MEMORY_CONSOLIDATIONS_PER_TICK,
  MEMORY_COOLDOWN_MS,
  MEMORY_EXPIRE_MS,
  MEMORY_EXTRACTION_CANDIDATES,
  MEMORY_EXTRACTION_CONCURRENCY,
  MEMORY_EXTRACTION_LEASE_MS,
  MEMORY_EXTRACTION_MAX_CHARS,
  MEMORY_IDLE_MS,
  MEMORY_PARK_MS,
  memoryFailureBackoffMs,
} from "./constants";

/**
 * The background memory sweep — the platform's Codex-style two-phase pipeline,
 * run from the cron entrypoint (prod: /api/cron every minute; dev: the
 * in-process tick):
 *
 *   1. EXTRACTION (parallel, capped): idle user chats of memory-enabled agents
 *      with unseen messages → an internal `memory-extractor` run under the
 *      chat's own reconstructed principal → one episode file per chat batch.
 *   2. CONSOLIDATION (serialized per scope by row lease, capped): scopes with
 *      pending episodes past their cooldown → an internal `memory-consolidator`
 *      run → MEMORY.md rewritten (snapshot-first, validated).
 *
 * Anti-hot-loop invariant (from runDue): EVERY completion path advances
 * `next_eligible_at` — success, failure, or "not actually memory-enabled" —
 * so no chat or scope can wedge the sweep.
 */

interface SweepResult {
  extractions: number;
  consolidations: number;
  skipped: number;
  errors: number;
}

const leaseId = () => `memsweep_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * Tally of a job run's memory writes, fed by the bound tools via `turnContext`.
 *
 * `runAgent`'s answer says nothing about whether anything was stored: a model
 * whose write tool keeps failing gives up and answers with a confident summary
 * of the version it never saved (observed in the wild — the consolidator fell
 * back to printing the new index and reported "added 4 new facts"). Consuming
 * the input on that answer loses those memories permanently, so the sweep asks
 * the tools instead.
 */
function writeTally() {
  let ok = 0;
  let failed = 0;
  return {
    sink: (success: boolean) => {
      if (success) ok++;
      else failed++;
    },
    /**
     * True when every attempt failed. Zero attempts is NOT a failure — a run
     * with nothing durable to add legitimately writes nothing, and forcing a
     * retry on that would re-run the model forever over the same episodes.
     */
    allFailed: () => ok === 0 && failed > 0,
  };
}

/** The memory config for an agent under a specific caller, or undefined. */
async function memoryConfigFor(
  agent: string,
  principal: Principal,
  agentStore: {
    getRecord: (
      p: Principal,
      name: string,
    ) => Promise<{ exec?: { memory?: MemoryConfig } } | undefined>;
  },
): Promise<MemoryConfig | undefined> {
  const code = memoryEnabledCodeAgents[agent];
  if (code) return code;
  try {
    return (await agentStore.getRecord(principal, agent))?.exec?.memory;
  } catch {
    return undefined;
  }
}

export async function memorySweep(opts?: { now?: number; force?: boolean }): Promise<SweepResult> {
  const { getLatch } = await import("../latch"); // lazy: latch.ts ↔ sweep would cycle statically
  const { runtime, agentStore, memoryJobs, memoryStore } = await getLatch();
  const now = opts?.now ?? Date.now();
  const idleMs = opts?.force ? 0 : MEMORY_IDLE_MS;
  const result: SweepResult = { extractions: 0, consolidations: 0, skipped: 0, errors: 0 };

  // ---- discovery: which agents have memory at all ----
  const uiNames = await agentStore.listMemoryEnabledNames().catch(() => [] as string[]);
  const bareAgents = Array.from(new Set([...Object.keys(memoryEnabledCodeAgents), ...uiNames]));
  // A channel-bound chat stores the binding's pinned ref verbatim
  // (`chats.agent = "org:coach"`), and the candidate query matches that column
  // EXACTLY against this list — so without the pinned forms a Telegram/Slack/
  // WhatsApp chat is never even a candidate and its transcript is never
  // extracted at all. `parseAgentRef` recognizes only these two prefixes, so
  // the variant set is closed; `extractOne` normalizes back to the bare name.
  const agents = [...bareAgents, ...bareAgents.flatMap((n) => [`org:${n}`, `user:${n}`])];

  // ---- phase 1: extraction ----
  if (agents.length > 0) {
    const candidates = await memoryJobs.listExtractionCandidates({
      now,
      idleMs,
      agents,
      limit: MEMORY_EXTRACTION_CANDIDATES,
    });
    // The candidate query's `limit` is the per-tick work cap; this pool only
    // bounds how many extractions run at once.
    const queue = [...candidates];
    const workers = Array.from(
      { length: Math.min(MEMORY_EXTRACTION_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const cand = queue.shift();
          if (!cand) return;
          try {
            const outcome = await extractOne(cand);
            result[outcome]++;
          } catch (error) {
            result.errors++;
            console.warn(`[memory] extraction failed for chat ${cand.chatId}:`, error);
          }
        }
      },
    );
    await Promise.all(workers);
  }

  async function extractOne(cand: {
    chatId: string;
    owner: string;
    agent: string;
    lastExtractedSeq: number;
    lastExtractedKey?: string;
    maxSeq: number;
    failures: number;
  }): Promise<"extractions" | "skipped"> {
    const lease = leaseId();
    // `cand.agent` comes from the chat/run rows, so a channel-bound chat carries
    // the binding's `org:`/`user:` pin. Strip it once here: the pin is not a
    // separate agent, and letting it reach `scopeRefOf` forks the memory store.
    const agent = memoryAgentOf(cand.agent);
    // Identity + config first (read-only), then claim with the derived scope.
    const identity = await memoryJobs.latestRunIdentity(cand.chatId);
    if (!identity) {
      // No run ever recorded a principal — park it (fenced complete needs a
      // claim, so claim with a placeholder scope first).
      if (
        await memoryJobs.claimChatExtraction(
          cand.chatId,
          { owner: cand.owner, agent, scopeKey: "unresolvable" },
          lease,
          MEMORY_EXTRACTION_LEASE_MS,
          now,
        )
      ) {
        await memoryJobs.completeChatExtraction(
          cand.chatId,
          { ok: false, nextEligibleAt: now + MEMORY_PARK_MS },
          lease,
        );
      }
      return "skipped";
    }
    const principal = identity as Principal;
    const memory = await memoryConfigFor(agent, principal, agentStore);
    const scope: ScopeRef | undefined = memory
      ? scopeRefOf({ agent, memory, userId: principal.userId })
      : undefined;
    if (!memory || !scope) {
      // Not actually memory-enabled for THIS owner (LIKE prefilter false
      // positive / scope unresolvable): park WITHOUT advancing the seq
      // watermark, so enabling memory later picks the backlog up.
      if (
        await memoryJobs.claimChatExtraction(
          cand.chatId,
          { owner: cand.owner, agent, scopeKey: "unresolvable" },
          lease,
          MEMORY_EXTRACTION_LEASE_MS,
          now,
        )
      ) {
        await memoryJobs.completeChatExtraction(
          cand.chatId,
          { ok: true, nextEligibleAt: now + MEMORY_PARK_MS },
          lease,
        );
      }
      return "skipped";
    }

    if (
      !(await memoryJobs.claimChatExtraction(
        cand.chatId,
        { owner: cand.owner, agent, scopeKey: scope.key },
        lease,
        MEMORY_EXTRACTION_LEASE_MS,
        now,
      ))
    ) {
      return "skipped"; // lost the race to another node
    }

    try {
      const msgs = await memoryJobs.messagesAfter(
        cand.chatId,
        cand.lastExtractedSeq,
        MEMORY_EXTRACTION_MAX_CHARS,
      );
      if (msgs.length === 0) {
        // Nothing textual to archive — advance past it.
        await memoryJobs.completeChatExtraction(
          cand.chatId,
          { lastExtractedSeq: cand.maxSeq, ok: true, nextEligibleAt: now + MEMORY_IDLE_MS },
          lease,
        );
        return "skipped";
      }
      // The excerpt may be char-capped short of maxSeq — advance the watermark
      // only to what the extractor actually saw; the tail is next tick's work.
      const lastSeenSeq = msgs[msgs.length - 1]!.seq;
      // Idempotency gate: identical content + prompt version to the last
      // COMPLETED run (seq-watermark reset, replayed/re-sequenced rows) must
      // never re-trigger a paid extraction — including windows the last run
      // extracted NOTHING from (the recorded key is that run's tombstone).
      // Advance the watermark for free instead. Failed runs never recorded a
      // key, so they fall through to a retry as intended.
      const extractionKey = extractionRunKey(msgs);
      if (extractionKey === cand.lastExtractedKey) {
        await memoryJobs.completeChatExtraction(
          cand.chatId,
          { lastExtractedSeq: lastSeenSeq, extractionKey, ok: true, nextEligibleAt: now + MEMORY_IDLE_MS },
          lease,
        );
        return "skipped";
      }
      const transcript = msgs.map((m) => `${m.role}: ${m.text}`).join("\n\n");
      const writes = writeTally();
      const turnContext: MemoryExtractionTurnContext = {
        kind: "memory-extraction",
        scope,
        chatId: cand.chatId,
        targetAgent: agent,
        // `!= null` (not `||`): an explicit cooldownHours of 0 is a real choice.
        cooldownMs:
          memory.consolidation?.cooldownHours != null
            ? memory.consolidation.cooldownHours * 3_600_000
            : MEMORY_COOLDOWN_MS,
        onWriteAttempt: writes.sink,
      };
      const { answer } = await runtime.runAgent({
        principal,
        agent: "memory-extractor",
        blockGated: false,
        turnContext,
        prompt: buildExtractionPrompt({
          agent,
          scopeLabel: scopeLabelOf(memory),
          chatId: cand.chatId,
          transcript,
          seqRange: { from: msgs[0]!.seq, to: lastSeenSeq },
        }),
      });
      // `runAgent` swallows in-run failures (an LLM error mid-stream resolves
      // with an EMPTY answer — the run row/telemetry get "errored", but the
      // promise doesn't reject). The extractor's contract is to always reply
      // one short line, so an empty answer means the run FAILED: throw into
      // the failure path rather than tombstoning content that was never
      // actually processed. Conservative on purpose — an ambiguous run costs
      // one backoff'd retry, a wrong tombstone loses memories forever.
      if (!answer.trim()) throw new Error("extractor run finished without an answer");
      // Every episode write failed — the transcript was processed but nothing
      // was stored. Tombstoning the window here would lose it for good, so
      // fail into the retry path instead (same reasoning as the empty answer).
      if (writes.allFailed()) throw new Error("extractor could not write its episode");
      // Completed (with or without an episode written): record the window's
      // key. Zero-yield completions tombstone the content; failures above
      // (throw / empty answer / no write landed) skip this and stay eligible
      // for retry.
      await memoryJobs.completeChatExtraction(
        cand.chatId,
        { lastExtractedSeq: lastSeenSeq, extractionKey, ok: true, nextEligibleAt: now + MEMORY_IDLE_MS },
        lease,
      );
      return "extractions";
    } catch (error) {
      // Escalating backoff, as consolidation does: a write outage now routes
      // here (see `writes.allFailed()` above), and a flat interval would keep
      // paying for an extractor run at a fixed rate for as long as it lasts.
      // This path never tombstones the window — it only retries less often.
      await memoryJobs
        .completeChatExtraction(
          cand.chatId,
          { ok: false, nextEligibleAt: now + memoryFailureBackoffMs(cand.failures + 1) },
          lease,
        )
        .catch(() => {});
      throw error;
    }
  }

  // ---- phase 2: consolidation ----
  const scopes = await memoryJobs.listConsolidationCandidates({
    now,
    limit: MEMORY_CONSOLIDATIONS_PER_TICK,
  });
  for (const row of scopes) {
    const lease = leaseId();
    if (
      !(await memoryJobs.claimScopeConsolidation(
        row.scopeKey,
        lease,
        MEMORY_CONSOLIDATION_LEASE_MS,
        now,
      ))
    ) {
      result.skipped++;
      continue;
    }
    try {
      const principal = row.identity as Principal | undefined;
      // Bare name, as in extraction — a row stamped with a channel pin resolves
      // to the agent's one canonical scope.
      const agent = memoryAgentOf(row.agent);
      const memory = principal ? await memoryConfigFor(agent, principal, agentStore) : undefined;
      const scope: ScopeRef | undefined =
        memory && principal
          ? scopeRefOf({ agent, memory, userId: principal.userId })
          : undefined;
      if (!principal || !memory || !scope || scope.key !== row.scopeKey) {
        // Identity lost, agent no longer memory-enabled, or a row whose stored
        // scopeKey predates a scope-derivation change (a channel-pinned root) —
        // park the scope. Episodes stay pending; a future touch re-stamps a
        // fresh identity, and a stale root simply parks daily rather than
        // erroring, since its content is not reachable from the new key.
        await memoryJobs.completeScopeConsolidation(
          row.scopeKey,
          { ok: false, nextEligibleAt: now + MEMORY_PARK_MS },
          lease,
        );
        result.skipped++;
        continue;
      }

      // Expiry candidates: ACTIVE index entries not recalled (and not updated)
      // within the expiry window. Usage rows only exist for recalled ids, so
      // fall back to the entry's own date.
      const usage = new Map(
        (await memoryJobs.usageFor(row.scopeKey)).map((u) => [u.memoryId, u]),
      );
      const index = await memoryStore.readIndex(principal, scope);
      const expireCandidates = index
        ? parseIndex(index)
            .entries.filter((e) => !e.archived)
            .filter((e) => {
              const entryDate = e.date ? Date.parse(e.date) : undefined;
              const lastTouch = Math.max(
                usage.get(e.id)?.lastUsedAt ?? 0,
                entryDate ?? 0,
              );
              return lastTouch > 0 && now - lastTouch > MEMORY_EXPIRE_MS;
            })
            .map((e) => {
              const lastUsedAt = usage.get(e.id)?.lastUsedAt;
              return {
                memoryId: e.id,
                lastUsedAt: lastUsedAt
                  ? new Date(lastUsedAt).toISOString().slice(0, 10)
                  : undefined,
              };
            })
        : [];

      const episodePaths = [...row.pendingEpisodes].sort();
      const writes = writeTally();
      const turnContext: MemoryConsolidationTurnContext = {
        kind: "memory-consolidation",
        scope,
        onWriteAttempt: writes.sink,
      };
      const { answer } = await runtime.runAgent({
        principal,
        agent: "memory-consolidator",
        blockGated: false,
        turnContext,
        prompt: buildConsolidationPrompt({
          scopeLabel: scopeLabelOf(memory),
          episodePaths,
          expireCandidates,
          today: new Date(now).toISOString().slice(0, 10),
        }),
      });
      // Same in-run-failure blindspot as extraction: `runAgent` resolves with
      // an empty answer when the model errors mid-stream. Marking THAT ok
      // would consume the pending episodes without ever folding them in —
      // throw into the failure path so they survive for the retry.
      if (!answer.trim()) throw new Error("consolidator run finished without an answer");
      // Every index write failed: the episodes were read but never folded in.
      // Consuming them on the strength of the answer alone is how a whole
      // consolidation silently evaporates — keep them pending for the retry.
      if (writes.allFailed()) throw new Error("consolidator could not write the index");
      const cooldownMs =
        memory.consolidation?.cooldownHours != null
          ? memory.consolidation.cooldownHours * 3_600_000
          : MEMORY_COOLDOWN_MS;
      await memoryJobs.completeScopeConsolidation(
        row.scopeKey,
        {
          ok: true,
          watermark: episodePaths.at(-1)?.split("/").pop(),
          nextEligibleAt: now + (opts?.force ? 0 : cooldownMs),
          consumedEpisodes: episodePaths,
        },
        lease,
      );
      result.consolidations++;
    } catch (error) {
      result.errors++;
      console.warn(`[memory] consolidation failed for scope ${row.scopeKey}:`, error);
      // Escalating backoff on `row.failures` (the count BEFORE this attempt).
      // The episodes stay pending either way — a scope whose rewrite is
      // deterministically invalid would otherwise buy a model run every two
      // hours forever, since nothing changes between attempts.
      await memoryJobs
        .completeScopeConsolidation(
          row.scopeKey,
          { ok: false, nextEligibleAt: now + memoryFailureBackoffMs(row.failures + 1) },
          lease,
        )
        .catch(() => {});
    }
  }

  return result;
}

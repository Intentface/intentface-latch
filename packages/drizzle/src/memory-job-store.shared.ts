import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  ExtractionCandidate,
  MemoryJobStore,
  MemoryUsageRow,
  ScopeStateRow,
} from "@intentface/latch-memory";

/**
 * Dialect-shared MemoryJobStore implementation. The sqlite and pg entry points
 * pass their dialect's schema tables; every query below uses the common
 * query-builder surface (insert/onConflict/update/returning), which both
 * dialects support.
 *
 * SECURITY: the list/read ops here are SYSTEM ops — principal-free and
 * cross-tenant (the `claimDueSchedules` precedent). Results must only feed
 * runs executed under the chat's own reconstructed principal.
 */

/** The tables the job store touches, in either dialect's schema. */
interface MemoryJobSchema {
  chats: any;
  messages: any;
  runs: any;
  memoryChatState: any;
  memoryScopeState: any;
  memoryUsage: any;
}

const PENDING_EPISODES_MAX = 100;
/** Safety valve: never load more rows than could plausibly fill the char cap. */
const MESSAGES_AFTER_ROW_CAP = 500;

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) =>
      p && typeof p === "object" && (p as { type?: string }).type === "text"
        ? String((p as { text?: string }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function pendingOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function makeMemoryJobStore(db: any, s: MemoryJobSchema): MemoryJobStore {
  const cs = s.memoryChatState;
  const ss = s.memoryScopeState;
  const mu = s.memoryUsage;

  const rowToScopeState = (r: any): ScopeStateRow => ({
    scopeKey: r.scopeKey,
    owner: r.owner,
    agent: r.agent,
    connection: r.connection,
    identity: r.identity ?? undefined,
    hasNew: r.hasNew === 1,
    pendingEpisodes: pendingOf(r.pendingEpisodes),
    consolidationWatermark: r.consolidationWatermark ?? undefined,
    lastConsolidatedAt: r.lastConsolidatedAt ?? undefined,
    nextEligibleAt: r.nextEligibleAt,
    failures: r.failures,
  });

  return {
    async listExtractionCandidates({ now, idleMs, agents, limit }) {
      if (agents.length === 0) return [];
      const maxSeqExpr = sql<number>`(select max(${s.messages.seq}) from ${s.messages} where ${s.messages.chatId} = ${s.chats.id})`;
      const rows = await db
        .select({
          chatId: s.chats.id,
          owner: s.chats.owner,
          agent: s.chats.agent,
          updatedAt: s.chats.updatedAt,
          lastExtractedSeq: sql<number>`coalesce(${cs.lastExtractedSeq}, -1)`,
          lastExtractedKey: cs.lastExtractedKey,
          maxSeq: maxSeqExpr,
          // Left join: a never-seen chat has no state row, so 0 failures.
          failures: sql<number>`coalesce(${cs.failures}, 0)`,
        })
        .from(s.chats)
        .leftJoin(cs, eq(cs.chatId, s.chats.id))
        .where(
          and(
            eq(s.chats.kind, "user"),
            inArray(s.chats.agent, agents),
            lte(s.chats.updatedAt, now - idleMs),
            // Never seen, or eligible again and not currently leased.
            or(
              isNull(cs.chatId),
              and(
                lte(cs.nextEligibleAt, now),
                or(isNull(cs.leaseOwner), lt(cs.leaseExpiresAt, now)),
              ),
            ),
            sql`${maxSeqExpr} > coalesce(${cs.lastExtractedSeq}, -1)`,
          ),
        )
        .orderBy(desc(s.chats.updatedAt))
        .limit(limit);
      return rows
        .filter((r: any) => r.maxSeq != null)
        .map(
          (r: any): ExtractionCandidate => ({
            ...r,
            lastExtractedKey: r.lastExtractedKey ?? undefined,
          }),
        );
    },

    async latestRunIdentity(chatId) {
      const rows = await db
        .select({ identity: s.runs.identity })
        .from(s.runs)
        .where(eq(s.runs.chatId, chatId))
        .orderBy(desc(s.runs.startedAt))
        .limit(1);
      return rows[0]?.identity ?? undefined;
    },

    async messagesAfter(chatId, afterSeq, maxChars) {
      const rows = await db
        .select({ seq: s.messages.seq, role: s.messages.role, parts: s.messages.parts, metadata: s.messages.metadata })
        .from(s.messages)
        .where(and(eq(s.messages.chatId, chatId), sql`${s.messages.seq} > ${afterSeq}`))
        .orderBy(s.messages.seq)
        .limit(MESSAGES_AFTER_ROW_CAP);
      const out: Array<{ seq: number; role: string; text: string }> = [];
      let used = 0;
      for (const r of rows as Array<{ seq: number; role: string; parts: unknown; metadata: unknown }>) {
        // Hidden from the model (an answer a regenerate replaced, a question's
        // edited-away wording): not something the user said or accepted.
        if ((r.metadata as { sendToModel?: unknown } | null)?.sendToModel === false) continue;
        const text = textOfParts(r.parts);
        if (!text) continue;
        const remaining = maxChars - used;
        if (remaining <= 0) break;
        const clipped = text.length > remaining ? `${text.slice(0, remaining)}…` : text;
        out.push({ seq: r.seq, role: r.role, text: clipped });
        used += clipped.length;
      }
      return out;
    },

    async claimChatExtraction(chatId, meta, leaseOwner, ttlMs, now) {
      await db
        .insert(cs)
        .values({
          chatId,
          owner: meta.owner,
          agent: meta.agent,
          scopeKey: meta.scopeKey,
          lastExtractedSeq: -1,
          nextEligibleAt: 0,
          failures: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const claimed = await db
        .update(cs)
        .set({ leaseOwner, leaseExpiresAt: now + ttlMs, updatedAt: now })
        .where(
          and(
            eq(cs.chatId, chatId),
            lte(cs.nextEligibleAt, now),
            or(isNull(cs.leaseOwner), lt(cs.leaseExpiresAt, now)),
          ),
        )
        .returning({ chatId: cs.chatId });
      return claimed.length > 0;
    },

    async completeChatExtraction(chatId, patch, leaseOwner) {
      const now = Date.now();
      await db
        .update(cs)
        .set({
          ...(patch.ok && patch.lastExtractedSeq !== undefined
            ? { lastExtractedSeq: patch.lastExtractedSeq }
            : {}),
          // The idempotency key advances only with a COMPLETED run — a failed
          // attempt must leave the previous key (and thus retryability) intact.
          ...(patch.ok && patch.extractionKey !== undefined
            ? { lastExtractedKey: patch.extractionKey }
            : {}),
          failures: patch.ok ? 0 : sql`${cs.failures} + 1`,
          nextEligibleAt: patch.nextEligibleAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        // Fenced by the claim lease (the completeSchedule pattern).
        .where(and(eq(cs.chatId, chatId), eq(cs.leaseOwner, leaseOwner)));
    },

    async touchScope(args, opts) {
      const { now, cooldownMs } = opts;
      // Ensure-then-update: the empty insert is race-tolerant, and the update
      // recomputes everything from the row it reads. A lost race between two
      // concurrent touches can drop one pending path — the pending list is an
      // optimization; the consolidator reads the index/episodes it's given.
      await db
        .insert(ss)
        .values({
          scopeKey: args.scopeKey,
          owner: args.owner,
          agent: args.agent,
          connection: args.connection,
          identity: args.identity ?? null,
          hasNew: 0,
          pendingEpisodes: [],
          nextEligibleAt: 0,
          failures: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const row = (
        await db.select().from(ss).where(eq(ss.scopeKey, args.scopeKey)).limit(1)
      )[0] as any;
      if (!row) return;
      const pending = pendingOf(row.pendingEpisodes);
      if (args.episodePath && !pending.includes(args.episodePath)) {
        pending.push(args.episodePath);
        if (pending.length > PENDING_EPISODES_MAX)
          pending.splice(0, pending.length - PENDING_EPISODES_MAX);
      }
      await db
        .update(ss)
        .set({
          hasNew: 1,
          identity: args.identity ?? row.identity,
          pendingEpisodes: pending,
          // Respect a failure backoff and the consolidation cooldown; a fresh
          // scope (both 0) becomes eligible immediately.
          nextEligibleAt: Math.max(
            row.nextEligibleAt ?? 0,
            (row.lastConsolidatedAt ?? 0) + cooldownMs,
          ),
          // Strictly increasing, so completeScopeConsolidation's updatedAt CAS
          // always sees a same-millisecond touch as a conflict.
          updatedAt: Math.max(now, (row.updatedAt ?? 0) + 1),
        })
        .where(eq(ss.scopeKey, args.scopeKey));
    },

    async listConsolidationCandidates({ now, limit }) {
      const rows = await db
        .select()
        .from(ss)
        .where(
          and(
            eq(ss.hasNew, 1),
            lte(ss.nextEligibleAt, now),
            or(isNull(ss.leaseOwner), lt(ss.leaseExpiresAt, now)),
          ),
        )
        .orderBy(ss.nextEligibleAt)
        .limit(limit);
      return (rows as any[]).map(rowToScopeState);
    },

    async scopeState(scopeKey) {
      const row = (await db.select().from(ss).where(eq(ss.scopeKey, scopeKey)).limit(1))[0];
      return row ? rowToScopeState(row) : undefined;
    },

    async claimScopeConsolidation(scopeKey, leaseOwner, ttlMs, now) {
      const claimed = await db
        .update(ss)
        .set({ leaseOwner, leaseExpiresAt: now + ttlMs, updatedAt: now })
        .where(
          and(
            eq(ss.scopeKey, scopeKey),
            eq(ss.hasNew, 1),
            lte(ss.nextEligibleAt, now),
            or(isNull(ss.leaseOwner), lt(ss.leaseExpiresAt, now)),
          ),
        )
        .returning({ scopeKey: ss.scopeKey });
      return claimed.length > 0;
    },

    async completeScopeConsolidation(scopeKey, patch, leaseOwner) {
      if (!patch.ok) {
        // Failure path touches no episode state — a plain fenced update is safe.
        await db
          .update(ss)
          .set({
            failures: sql`${ss.failures} + 1`,
            nextEligibleAt: patch.nextEligibleAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: Date.now(),
          })
          .where(and(eq(ss.scopeKey, scopeKey), eq(ss.leaseOwner, leaseOwner)));
        return;
      }
      // Success rewrites pendingEpisodes/hasNew from a read — a touchScope
      // landing between the read and the write would be clobbered (its new
      // episode dropped AND the dirty flag cleared). CAS on updatedAt and
      // retry so a concurrent touch's episode always survives.
      const consumed = new Set(patch.consumedEpisodes ?? []);
      for (let attempt = 0; attempt < 5; attempt++) {
        const now = Date.now();
        const row = (
          await db
            .select()
            .from(ss)
            .where(and(eq(ss.scopeKey, scopeKey), eq(ss.leaseOwner, leaseOwner)))
            .limit(1)
        )[0] as any;
        if (!row) return; // lease lost — another node owns the row now
        const remaining = pendingOf(row.pendingEpisodes).filter((p) => !consumed.has(p));
        const updated = await db
          .update(ss)
          .set({
            hasNew: remaining.length > 0 ? 1 : 0,
            pendingEpisodes: remaining,
            ...(patch.watermark ? { consolidationWatermark: patch.watermark } : {}),
            lastConsolidatedAt: now,
            nextEligibleAt: patch.nextEligibleAt,
            failures: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: Math.max(now, row.updatedAt + 1), // CAS token must move
          })
          .where(
            and(
              eq(ss.scopeKey, scopeKey),
              eq(ss.leaseOwner, leaseOwner),
              eq(ss.updatedAt, row.updatedAt),
            ),
          )
          .returning({ scopeKey: ss.scopeKey });
        if (updated.length > 0) return;
        // CAS conflict: a touch moved the row — re-read and re-apply.
      }
      // Persistently contended (shouldn't happen): release the lease and
      // advance eligibility WITHOUT touching pendingEpisodes/hasNew — the
      // consumed episodes get re-consolidated next pass, nothing is lost.
      await db
        .update(ss)
        .set({
          lastConsolidatedAt: Date.now(),
          nextEligibleAt: patch.nextEligibleAt,
          failures: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(ss.scopeKey, scopeKey), eq(ss.leaseOwner, leaseOwner)));
    },

    async recordUsage(scopeKey, memoryIds, at) {
      for (const memoryId of memoryIds) {
        await db
          .insert(mu)
          .values({ scopeKey, memoryId, usageCount: 1, lastUsedAt: at, createdAt: at })
          .onConflictDoUpdate({
            target: [mu.scopeKey, mu.memoryId],
            set: { usageCount: sql`${mu.usageCount} + 1`, lastUsedAt: at },
          });
      }
    },

    async usageFor(scopeKey) {
      const rows = await db.select().from(mu).where(eq(mu.scopeKey, scopeKey));
      return (rows as any[]).map(
        (r): MemoryUsageRow => ({
          memoryId: r.memoryId,
          usageCount: r.usageCount,
          lastUsedAt: r.lastUsedAt ?? undefined,
          createdAt: r.createdAt,
        }),
      );
    },
  };
}

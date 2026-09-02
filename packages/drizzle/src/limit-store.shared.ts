import { and, eq, lt, or, sql } from "drizzle-orm";
import type { LimitStore, LimitUsage, LimitWindowRef } from "@intentface/latch-core";
import { usageKey } from "@intentface/latch-core";

/**
 * Dialect-shared `LimitStore`: one row per (key, windowStart, windowMs) — the
 * same key may carry several window lengths whose starts coincide. `add` is a single
 * upsert per entry with `SET n = n + excluded.n`, so concurrent turns settling
 * into the same window never lose an increment. Both dialects support the
 * query-builder surface used here.
 */

interface LimitSchema {
  limitCounters: any;
}

export function makeLimitStore(db: any, s: LimitSchema): LimitStore {
  const t = s.limitCounters;
  return {
    async read(refs: LimitWindowRef[]): Promise<Record<string, LimitUsage>> {
      if (refs.length === 0) return {};
      const rows: any[] = await db
        .select()
        .from(t)
        .where(
          or(...refs.map((r) => and(eq(t.key, r.key), eq(t.windowStart, r.windowStart), eq(t.windowMs, r.windowMs)))),
        );
      const out: Record<string, LimitUsage> = {};
      for (const r of rows) {
        out[usageKey({ key: r.key, windowStart: Number(r.windowStart), windowMs: Number(r.windowMs) })] = {
          turns: Number(r.turns ?? 0),
          tokens: Number(r.tokens ?? 0),
          cost: Number(r.cost ?? 0),
        };
      }
      return out;
    },

    async add(entries: (LimitWindowRef & { usage: Partial<LimitUsage> })[]): Promise<Record<string, LimitUsage>> {
      const now = Date.now();
      const out: Record<string, LimitUsage> = {};
      for (const e of entries) {
        const turns = e.usage.turns ?? 0;
        const tokens = e.usage.tokens ?? 0;
        const cost = e.usage.cost ?? 0;
        // One statement: upsert + RETURNING the post-increment row, so a
        // reservation reads its own count and concurrent reservers get
        // distinct, ordered counts.
        const rows: any[] = await db
          .insert(t)
          .values({ key: e.key, windowStart: e.windowStart, windowMs: e.windowMs, turns, tokens, cost, updatedAt: now })
          .onConflictDoUpdate({
            target: [t.key, t.windowStart, t.windowMs],
            set: {
              turns: sql`${t.turns} + ${turns}`,
              tokens: sql`${t.tokens} + ${tokens}`,
              cost: sql`${t.cost} + ${cost}`,
              updatedAt: now,
            },
          })
          .returning();
        const r = rows[0];
        out[usageKey(e)] = {
          turns: Number(r?.turns ?? turns),
          tokens: Number(r?.tokens ?? tokens),
          cost: Number(r?.cost ?? cost),
        };
      }
      return out;
    },

    async prune(before: number): Promise<void> {
      await db.delete(t).where(lt(sql`${t.windowStart} + ${t.windowMs}`, before));
    },
  };
}

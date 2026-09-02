import type { LimitStore } from "@intentface/latch-core";
import { usageKey } from "@intentface/latch-core";

/** Dialect-shared smoke for the LimitStore: additive upserts, zero reads, prune. */
export async function limitStoreSmoke(args: {
  limits: LimitStore;
  assert: (cond: boolean, msg: string) => void;
}): Promise<void> {
  const { limits, assert } = args;
  const MINUTE = 60_000;
  const now = 10 * MINUTE + 5_000;
  const ref = { key: "user:org_a:u1", windowStart: 10 * MINUTE, windowMs: MINUTE };
  const other = { key: "org:org_a", windowStart: 0, windowMs: 24 * 3_600_000 };

  assert(Object.keys(await limits.read([ref])).length === 0, "limits: absent row reads as nothing");
  await limits.add([{ ...ref, usage: { turns: 1 } }]);
  await limits.add([{ ...ref, usage: { tokens: 120, cost: 0.5 } }, { ...other, usage: { turns: 1, tokens: 120, cost: 0.5 } }]);
  await limits.add([{ ...ref, usage: { tokens: 30, cost: 0.25 } }]);
  const usage = await limits.read([ref, other]);
  const u = usage[usageKey(ref)];
  assert(u?.turns === 1 && u.tokens === 150 && Math.abs(u.cost - 0.75) < 1e-9, `limits: additive upsert (${JSON.stringify(u)})`);
  assert(usage[usageKey(other)]?.tokens === 120, "limits: second key kept apart");

  // A window that ended before `before` is pruned; a live one stays.
  await limits.prune!(now + 2 * MINUTE);
  const after = await limits.read([ref, other]);
  assert(after[usageKey(ref)] === undefined, "limits: ended window pruned");
  assert(after[usageKey(other)] !== undefined, "limits: live window kept");
}

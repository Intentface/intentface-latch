/**
 * Seeded PRNG for the synthetic corpus. mulberry32 — tiny, fast, and
 * byte-deterministic across platforms (only >>> / Math.imul integer ops).
 * NEVER use Date.now() or Math.random() anywhere in the eval fixtures.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Deterministic pick from a non-empty list. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[int(rng, 0, items.length - 1)];
}

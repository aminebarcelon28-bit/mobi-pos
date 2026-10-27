/**
 * Seeded PRNG (mulberry32) for the Phase 3 long-session random walk.
 * Deterministic: the same seed replays the same action sequence, so any
 * failure found by the walk is reproducible from (seed, step index).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** float [0,1) */
  next(): number;
  /** int [min, max] inclusive */
  int(min: number, max: number): number;
  /** uniform pick */
  pick<T>(xs: readonly T[]): T;
  /** weighted pick: entries [item, weight] */
  weighted<T>(entries: readonly [T, number][]): T;
  /** true with probability p */
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    next: r,
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pick: (xs) => xs[Math.floor(r() * xs.length)],
    weighted: (entries) => {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let t = r() * total;
      for (const [item, w] of entries) {
        t -= w;
        if (t <= 0) return item;
      }
      return entries[entries.length - 1][0];
    },
    chance: (p) => r() < p,
  };
}

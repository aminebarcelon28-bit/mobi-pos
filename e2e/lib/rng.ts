/**
 * Seeded PRNG for stress/fuzz generators. All randomness in suites is
 * seeded and printed (`STRESS_SEED=`); suites accept `STRESS_SEED` from
 * the environment so any failure reproduces from a one-line command.
 */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stressSeed(): number {
  const raw = Number(process.env.STRESS_SEED ?? Date.now() % 1e9);
  const seed = Number.isFinite(raw) ? Math.floor(raw) : 0;
  console.log(`STRESS_SEED=${seed}`);
  return seed;
}

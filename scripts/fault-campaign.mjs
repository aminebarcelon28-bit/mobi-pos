// Tier D campaign driver: N kill cycles against ONE continuing container.
// Per cycle: launch the fault worker (fresh session), kill mobi-pos.exe at
// a random offset mid-run, then verify crash-consistency out-of-band
// (integrity + atomicity). A killed run aborts with a session error —
// EXPECTED, counts as "kill landed". Survivors must be fully green.
// No wipes after cycle 1 (continuity is the point); no resets after cycle 1.
//
// Usage: node scripts/fault-campaign.mjs --cycles 12 [--seed N]
// Env honored: STRESS_SEED.
import { spawnSync, spawn, execSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    if (!a.startsWith('--')) return [];
    const eq = a.indexOf('=');
    return eq > 0 ? [[a.slice(2, eq), a.slice(eq + 1)]] : [];
  }),
);
const CYCLES = Number(args.cycles ?? 12);
const SEED = Number(process.env.STRESS_SEED ?? 20260410);
if (!Number.isFinite(CYCLES) || CYCLES < 1 || CYCLES > 100) {
  console.error('usage: fault-campaign.mjs --cycles <1..100>');
  process.exit(2);
}

let rndState = SEED;
const rnd = () => {
  rndState |= 0; rndState = (rndState + 0x6d2b79f5) | 0;
  let t = Math.imul(rndState ^ (rndState >>> 15), 1 | rndState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
console.log(`FAULT_SEED=${SEED} cycles=${CYCLES}`);

const DB = `${process.env.APPDATA ?? ''}\\com.mobi.pos.e2e\\mobi_pos.db`;
let killsLanded = 0;
let survivors = 0;
let cleanCycles = 0;

for (let i = 1; i <= CYCLES; i++) {
  const delayMs = 4000 + Math.floor(rnd() * 16000); // 4–20 s into the run
  console.log(`--- cycle ${i}/${CYCLES} (kill in ${delayMs}ms) ---`);
  spawnSync('node', ['scripts/e2e-clean.mjs'], { stdio: 'ignore', shell: true });
  const killer = spawn('node', ['scripts/fault-kill.mjs', `--delay-ms=${delayMs}`], {
    stdio: 'ignore',
    shell: true,
  });
  killer.unref();
  const run = spawnSync('npx', ['wdio', 'run', 'wdio.conf.ts', '--spec', './test/specs/stress/phase4-fault.e2e.ts', '--bail', '1'], {
    encoding: 'utf8',
    shell: true,
    env: {
      ...process.env,
      FAULT_N: '3',
      FAULT_TAG: `C${i}`,
      FAULT_RESET: i === 1 ? '1' : '0',
      POS_E2E_WIPE: i === 1 ? '1' : '0',
    },
  });
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const passed = /1 passing/.test(out);
  const killed = /invalid session|failed to connect|session deleted|disconnected|ECONNREFUSED/i.test(out);
  if (passed) {
    survivors++;
    console.log(`cycle ${i}: SURVIVED (green)`);
  } else if (killed) {
    killsLanded++;
    console.log(`cycle ${i}: KILL LANDED (session died as designed)`);
  } else {
    console.log(`cycle ${i}: UNEXPECTED outcome (status=${run.status}); tail: ${out.slice(-400)}`);
  }
  try {
    execSync('taskkill /F /IM mobi-pos.exe', { stdio: 'ignore' });
  } catch { /* already dead */ }
  const check = spawnSync('node', ['scripts/check-atomicity.mjs', `--db=${DB}`], { encoding: 'utf8', shell: true });
  console.log(`cycle ${i}: atomicity: ${(check.stdout ?? '').trim()} (exit=${check.status})`);
  if (check.status === 0) cleanCycles++;
}
console.log(`FAULT DONE: cycles=${CYCLES} survivors=${survivors} killsLanded=${killsLanded} atomicityClean=${cleanCycles}`);

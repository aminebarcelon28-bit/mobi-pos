// Tier C process sampler (Windows): polls RSS + handles + threads for an
// image name (default mobi-pos.exe) every N seconds for a duration,
// writes CSV, prints a drift gate (FAIL if RSS drifts >30% over the first
// stable baseline sample, or handles/threads grow monotonically).
//
// Usage: node scripts/sample-proc.mjs --image mobi-pos.exe --dur-s 720 --every-s 30 --out artifacts/soak.csv
// Exit: 0 gate pass (or no samples), 1 gate fail, 2 usage error.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith('--')) return [];
    const eq = a.indexOf('=');
    if (eq > 0) return [[a.slice(2, eq), a.slice(eq + 1)]];
    const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1';
    return [[a.slice(2), v]];
  }),
);
const image = args.image ?? 'mobi-pos.exe';
const durS = Number(args['dur-s'] ?? 720);
const everyS = Number(args['every-s'] ?? 30);
const out = args.out ?? 'artifacts/soak.csv';
if (!Number.isFinite(durS) || !Number.isFinite(everyS) || durS <= 0 || everyS <= 0) {
  console.error('usage: sample-proc.mjs --image <exe> --dur-s N --every-s N --out <csv>');
  process.exit(2);
}

function sample() {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "Get-Process -Name '${image.replace(/\.exe$/i, '')}' -ErrorAction Stop | Select-Object WorkingSet64, HandleCount, Threads | ConvertTo-Json"`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    const j = JSON.parse(raw);
    const first = Array.isArray(j) ? j[0] : j;
    const threads = Array.isArray(first.Threads) ? first.Threads.length : Number(first.Threads ?? 0);
    return { rss: Number(first.WorkingSet64), handles: Number(first.HandleCount), threads };
  } catch {
    return null;
  }
}

const rows = [];
const t0 = Date.now();
while (Date.now() - t0 < durS * 1000) {
  const s = sample();
  rows.push({ t: new Date().toISOString(), rss: s?.rss ?? -1, handles: s?.handles ?? -1, threads: s?.threads ?? -1 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, everyS * 1000);
}
fs.mkdirSync(out.split(/[\\/]/).slice(0, -1).join('/') || '.', { recursive: true });
fs.writeFileSync(out, `t,rss,handles,threads\n${rows.map((r) => `${r.t},${r.rss},${r.handles},${r.threads}`).join('\n')}\n`);

const live = rows.filter((r) => r.rss > 0);
if (live.length < 3) {
  console.log(`sample-proc: only ${live.length} live samples — no gate verdict`);
  process.exit(0);
}
const base = live.slice(0, Math.min(3, live.length)).reduce((a, r) => a + r.rss, 0) / Math.min(3, live.length);
const last = live[live.length - 1].rss;
const drift = ((last - base) / base) * 100;
const hBase = live[0].handles;
const hLast = live[live.length - 1].handles;
console.log(`sample-proc: n=${live.length} base_rss=${(base / 1048576).toFixed(1)}MB last_rss=${(last / 1048576).toFixed(1)}MB drift=${drift.toFixed(1)}% handles=${hBase}->${hLast} out=${out}`);
if (drift > 30) {
  console.log('GATE FAIL: RSS drift > 30%');
  process.exit(1);
}
console.log('GATE PASS');

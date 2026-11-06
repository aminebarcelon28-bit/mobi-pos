/**
 * Shared plumbing for the e2e-testing skill scripts. Zero dependencies.
 * Not a CLI: imported by the other scripts in this folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const IDENTIFIER = 'com.mobi.pos.e2e';
export const APP_IMAGE = process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos';

/** Walk up from cwd until the Tauri config is found. */
export function repoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'src-tauri', 'tauri.conf.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found (no src-tauri/tauri.conf.json above cwd)');
}

export function sandboxDir() {
  const override = process.env.POS_WDIO_SANDBOX?.trim();
  if (override) return path.resolve(override);
  return path.join(process.env.TEMP || os.tmpdir(), 'opencode', 'pos-wdio-sandbox');
}

export function paths(root = repoRoot()) {
  const sandbox = sandboxDir();
  const appData = path.join(sandbox, 'home', 'AppData', 'Roaming', IDENTIFIER);
  const localAppData = path.join(sandbox, 'home', 'AppData', 'Local', IDENTIFIER);
  const binaryOverride = process.env.WDIO_E2E_BINARY?.trim();
  return {
    root,
    sandbox,
    appData,
    localAppData,
    db: path.join(appData, 'mobi_pos.db'),
    webview: localAppData,
    binary: binaryOverride
      ? path.resolve(root, binaryOverride)
      : path.join(root, 'target-e2e', 'debug', APP_IMAGE),
    driver: process.env.WDIO_TAURI_DRIVER?.trim() ||
      path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'),
    results: path.join(root, 'e2e-tests', 'results'),
    runs: path.join(root, 'e2e-tests', 'results', 'runs'),
    logs: path.join(root, 'e2e-tests', 'test-logs'),
    wdioBin: path.join(root, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js'),
    wdioConf: path.join(root, 'e2e-tests', 'wdio.conf.ts'),
  };
}

export function isRunning(image = APP_IMAGE) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      return out.toLowerCase().includes(image.toLowerCase());
    }
    execSync(`pgrep -f ${JSON.stringify(image)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function gitSha(root) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Full 40-hex HEAD, or null when this is not a git checkout. */
export function gitHead(root) {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Why `dir` must NOT be deleted as an e2e data dir, or null when it is safe.
 * Safe means exactly `<sandbox>/home/AppData/{Roaming|Local}/com.mobi.pos.e2e`
 * (exact leaf, path-segment containment, never a string-prefix near-miss).
 */
export function e2eDataDirProblem(dir, sandbox = sandboxDir()) {
  const target = path.resolve(dir);
  const base = path.resolve(sandbox);
  if (path.basename(target) !== IDENTIFIER) {
    return `leaf is "${path.basename(target)}", not "${IDENTIFIER}"`;
  }
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `not inside the sandbox ${base}`;
  }
  const parts = rel.split(path.sep);
  const expected = parts.length === 4 && parts[0] === 'home' && parts[1] === 'AppData' &&
    (parts[2] === 'Roaming' || parts[2] === 'Local');
  if (!expected) return `unexpected sandbox layout: ${rel}`;
  if (base === path.parse(base).root || base === path.resolve(os.homedir())) {
    return `sandbox ${base} is a root/home directory`;
  }
  return null;
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function newestMtime(files) {
  let newest = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.isDirectory()) newest = Math.max(newest, newestMtime(walk(f)));
      else newest = Math.max(newest, st.mtimeMs);
    } catch {
      /* missing is not newer */
    }
  }
  return newest;
}

export function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'target' || e.name === 'target-e2e') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

/**
 * Boolean flags. A flag in this set NEVER consumes the next token, so
 * `--json out.json` leaves `out.json` as a positional instead of silently
 * swallowing it as the value of `--json`. Anything not listed here takes a
 * value (`--spec a.e2e.ts`), and `--key=value` always works.
 */
export const BOOLEAN_FLAGS = new Set([
  'help', 'json', 'quiet', 'verbose',
  'wipe', 'no-wipe', 'build', 'all',
  'provenance', 'mobile',
  'close', 'strict', 'migrate', 'write-index', 'dry-run', 'in-place',
  'allow-unmapped', 'update-baseline', 'report-only',
  'allow-spec-change', 'no-spec-change-check', 'keep-going',
]);

export function parseArgs(argv = process.argv.slice(2), booleans = BOOLEAN_FLAGS) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      if (booleans.has(key)) { out[key] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
      if (out[key] === undefined) out[key] = next;
      else out[key] = [].concat(out[key], next);
      i++;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Verdict vocabulary + case-id grammar - one definition, used by every */
/* script, the lint and the docs.                                      */
/* ------------------------------------------------------------------ */

export const VERDICTS = ['PASS', 'PASS-PARTIAL', 'FAIL', 'N/A', 'REMAIN', 'BLOCKED'];
export const GOOD_VERDICTS = new Set(['PASS', 'PASS-PARTIAL']);

/** Catalog case id: 2-4 char prefix (digits allowed after the first letter), 2-3 digit number. */
export const ID_CATALOG_RE = /^[A-Z][A-Z0-9]{1,3}-\d{2,3}$/;

/**
 * Non-catalog id families that legitimately appear as `it()` titles but are not
 * rows in CASE_INDEX.csv. Each one carries its reason; `lint-specs.mjs` prints
 * them as `non-catalog` rather than failing on them.
 */
export const ID_FAMILIES = [
  { name: 'HARNESS', re: /^HARNESS-\d{2}$/, reason: 'environment / harness proof' },
  { name: 'G-NC', re: /^G-\d{2}-NC$/, reason: 'invariant negative control' },
  { name: 'PROBE', re: /^(?:[A-Z]+-)?PROBE(?:-[A-Za-z0-9]+)*$/, reason: 'diagnostic probe, not a catalog case' },
  { name: 'COMPOSITE', re: /^REP-\d{2}\/G-\d{2}$/, reason: 'composite id (case + invariant)' },
];

/** Strip the `[...]` wrapper a title may carry. */
export function bareId(token) {
  return String(token ?? '').trim().replace(/^\[/, '').replace(/\]$/, '').trim();
}

/** `catalog` | family name | null. */
export function classifyId(token) {
  const id = bareId(token);
  if (ID_CATALOG_RE.test(id)) return 'catalog';
  for (const f of ID_FAMILIES) if (f.re.test(id)) return f.name;
  return null;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values) {
  return values.map(csvCell).join(',');
}

/* ------------------------------------------------------------------ */
/* CASE_INDEX.csv - the single verdict source                          */
/* ------------------------------------------------------------------ */

export function indexPath(root) {
  return path.join(root, 'e2e-tests', 'CASE_INDEX.csv');
}

/**
 * Read the index. `rows` are arrays aligned with `header`; `get(row, col)`
 * trims. Rows that are entirely blank are dropped.
 */
export function readIndex(root, file = indexPath(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const raw = parseCsv(text);
  const header = (raw.shift() || []).map((h) => h.trim());
  const rows = raw.filter((r) => r.length && r.some((f) => String(f).trim()));
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (row, col) => (ix[col] === undefined ? '' : String(row[ix[col]] ?? '').trim());
  const byId = new Map();
  for (const row of rows) {
    const id = get(row, 'id');
    if (id) byId.set(id, row);
  }
  return { file, text, header, rows, ix, get, byId, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function writeIndex(index) {
  const lines = [csvLine(index.header), ...index.rows.map((r) => csvLine(index.header.map((h) => r[index.ix[h]] ?? '')))];
  fs.writeFileSync(index.file, lines.join(index.eol) + index.eol, 'utf8');
}

export function isRetired(index, row) {
  return index.get(row, 'retired') === '1';
}

export function activeRows(index) {
  return index.rows.filter((r) => !isRetired(index, r));
}

/** Verdict counts over active rows, in dashboard vocabulary. */
export function indexCounts(index) {
  const out = { TOTAL: 0, PASS: 0, 'PASS-PARTIAL': 0, FAIL: 0, 'N/A': 0, REMAIN: 0, BLOCKED: 0, 'PASS-NONFLAKY': 0, FLAKY: 0 };
  for (const row of activeRows(index)) {
    out.TOTAL++;
    const v = index.get(row, 'verdict');
    if (out[v] !== undefined) out[v]++;
    // Flaky passes are reported but never counted as green (Q-C). The headline
    // is PASS (full) only — a PASS-PARTIAL is not a full pass, so mixing them
    // inflated the stricter number (owner finding, B3).
    const flaky = /(^|\W)FLAKY(\W|$)/i.test(index.get(row, 'evidence') ?? '');
    if (v === 'PASS' && !flaky) out['PASS-NONFLAKY']++;
    if (['PASS', 'PASS-PARTIAL'].includes(v) && flaky) out.FLAKY++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* COVERAGE.md dashboard                                               */
/* ------------------------------------------------------------------ */

export const DASH_KEYS = [
  ['TOTAL', /^Catalog cases/],
  ['PASS', /^Passed \(full\)/],
  ['PASS-PARTIAL', /^Passed \(partial/],
  ['PASS-NONFLAKY', /^Passed \(full, excluding flaky/],
  ['FLAKY', /^FLAKY/],
  ['FAIL', /^FAILED/],
  ['N/A', /^N\/A/],
  ['REMAIN', /^Remaining/],
  ['BLOCKED', /^BLOCKED/],
];

export function readDashboard(coverageFile) {
  const out = {};
  for (const line of fs.readFileSync(coverageFile, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(.+?)\s*\|\s*([\d/]+)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const label = m[1].replace(/\*/g, '');
    const hit = DASH_KEYS.find(([, re]) => re.test(label));
    if (hit) out[hit[0]] = Number(m[2]);
  }
  return out;
}

/**
 * Rewrite only the counter cells, matching labels exactly the way
 * readDashboard parses them (bold markers stripped). A regex built from the
 * key name alone misses `| **FAILED** |`, which leaves the dashboard
 * half-synced - that bug is why this is line-based.
 */
export function syncDashboard(coverageFile, counts) {
  const text = fs.readFileSync(coverageFile, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\n/);
  const changed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\|\s*)(.+?)(\s*\|\s*)([\d/]+)(\s*\|\s*)$/.exec(lines[i]);
    if (!m) continue;
    const label = m[2].replace(/\*/g, '');
    const hit = DASH_KEYS.find(([, re]) => re.test(label));
    if (!hit || counts[hit[0]] === undefined) continue;
    if (m[4] !== String(counts[hit[0]])) changed.push(`${hit[0]}: ${m[4]} -> ${counts[hit[0]]}`);
    lines[i] = `${m[1]}${m[2]}${m[3]}${counts[hit[0]]}${m[5]}`;
  }
  fs.writeFileSync(coverageFile, lines.join(eol), 'utf8');
  return changed;
}

/* ------------------------------------------------------------------ */
/* run output parsing                                                  */
/* ------------------------------------------------------------------ */

/** Sum every `N passing` / `N failing` / `N skipped` line in a WDIO log. */
export function sumRunCounts(text) {
  const sum = (re) => {
    let total = 0;
    let m;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = g.exec(text)) !== null) total += Number(m[1]);
    return total;
  };
  return {
    passing: sum(/(\d+)\s+passing/),
    failing: sum(/(\d+)\s+failing/),
    skipped: sum(/(\d+)\s+(?:skipped|pending)/),
  };
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Paths that make the e2e binary stale when they change. */
export const APP_PATHS = [
  'src',
  'src-tauri/src',
  'src-tauri/Cargo.toml',
  'Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.e2e.conf.json',
  'index.html',
  'vite.config.ts',
];

/**
 * Newest mtime across the app sources (the freshness half of preflight).
 * `src-tauri/Cargo.lock` is included on purpose: a dependency bump changes the
 * compiled binary without touching a single `.rs` file, and a lockfile-only
 * change is exactly the rebuild preflight used to miss.
 */
export function sourceNewest(root) {
  const sources = APP_PATHS
    .map((rel) => path.join(root, rel))
    .filter((p) => fs.existsSync(p));
  let newest = 0;
  for (const s of sources) {
    try {
      const st = fs.statSync(s);
      newest = Math.max(newest, st.isDirectory() ? newestMtime(walk(s)) : st.mtimeMs);
    } catch { /* missing is not newer */ }
  }
  return newest;
}

export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export function ok(msg) { console.log(`${C.green}[ok]${C.reset}   ${msg}`); }
export function warn(msg) { console.log(`${C.yellow}[warn]${C.reset} ${msg}`); }
export function bad(msg) { console.log(`${C.red}[fail]${C.reset} ${msg}`); }
export function info(msg) { console.log(`${C.dim}${msg}${C.reset}`); }

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function dirSize(dir) {
  let total = 0;
  for (const f of walk(dir)) {
    try { total += fs.statSync(f).size; } catch { /* ignore */ }
  }
  return total;
}

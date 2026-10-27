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

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        if (out[key] === undefined) out[key] = next;
        else out[key] = [].concat(out[key], next);
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
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

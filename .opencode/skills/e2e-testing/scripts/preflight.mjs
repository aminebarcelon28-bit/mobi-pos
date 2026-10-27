#!/usr/bin/env node
/**
 * preflight.mjs - Gate 0 environment check for the MobiPOS E2E harness.
 *
 * Verifies, without launching the app:
 *   - node >= 20 and the WDIO CLI present
 *   - the e2e binary exists, embeds HEAD (build provenance) and the
 *     `com.mobi.pos.e2e` identifier, and is not older than any source file
 *   - tauri-driver is where wdio.conf.ts expects it
 *   - no orphaned mobi-pos.exe / drivers (they hold the DB and the WebView dir)
 *   - the sandbox paths, and whether a DB is already there
 *
 * Usage: node .opencode/skills/e2e-testing/scripts/preflight.mjs [--quiet] [--provenance]
 *        --provenance   only certify the binary (sha + identifier + freshness);
 *                       used by wdio.conf.ts at import time, where driver and
 *                       orphan checks would misfire inside a worker.
 * Exit:  0 all good (warnings allowed), 1 a hard blocker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import {
  paths, repoRoot, isRunning, humanBytes, parseArgs, ok, warn, bad, info, C, IDENTIFIER, gitHead,
} from './_lib.mjs';

const args = parseArgs();
const quiet = Boolean(args.quiet);
// Provenance-only mode: used by wdio.conf.ts at import time, where the driver
// and orphan checks would misfire (workers see tauri-driver already running)
// and where only the binary's identity matters.
const provenanceOnly = Boolean(args.provenance);
let failures = 0;
let warnings = 0;

/**
 * Paths that actually change the compiled app, i.e. what a rebuild is FOR.
 * Deliberately narrow: docs, skills, specs and scripts do not appear here, so
 * a docs-only commit between build and HEAD does not force a rebuild.
 */
const APP_PATHS = [
  'src',
  'src-tauri/src',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.e2e.conf.json',
  'index.html',
  'vite.config.ts',
];

function hard(msg) { bad(msg); failures++; }
function soft(msg) { warn(msg); warnings++; }

const root = repoRoot();
const p = paths(root);
if (!quiet) info(`repo   ${root}`);
if (!quiet) info(`node   ${process.version}  ${process.platform}`);

// 1. Node + WDIO
const major = Number(process.version.replace(/^v/, '').split('.')[0]);
if (major < 20) hard(`node ${process.version} is too old (need >= 20)`);
else if (!quiet) ok(`node ${process.version}`);

if (!provenanceOnly) {
  if (!fs.existsSync(p.wdioBin)) {
    hard(`WDIO CLI missing at ${p.wdioBin} - run npm install`);
  } else {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@wdio', 'cli', 'package.json'), 'utf8')).version;
    if (!quiet) ok(`webdriverio ${v}`);
  }
}

// 2. Binary provenance + freshness
if (!fs.existsSync(p.binary)) {
  hard(`e2e binary missing: ${p.binary}\n       build it: npm run build:e2e`);
} else {
  const st = fs.statSync(p.binary);
  // Provenance: build-e2e stamps HEAD into the binary (E2E_GIT_SHA) and the
  // e2e identifier is a compiled literal. A stale or wrong-flavor binary is
  // the quietest way for the suite to lie, so both are hard blockers.
  const head = gitHead(root);
  const bytes = fs.readFileSync(p.binary);
  if (!head) {
    hard('cannot read git HEAD - refusing to certify the e2e binary (run inside the repo)');
  } else if (!bytes.includes(Buffer.from(head))) {
    const embedded = findEmbeddedCommit(bytes, root);
    const changed = embedded ? changedAppPaths(embedded, head, root) : null;
    if (embedded && changed && changed.length === 0) {
      // A commit that touched only docs/skills/tests does not make the app
      // binary stale. Prove it with the diff instead of demanding a rebuild.
      soft(
        `binary built at ${embedded.slice(0, 12)}, HEAD ${head.slice(0, 12)} - ` +
          'no app source changed in between (provenance accepted)',
      );
    } else {
      hard(
        `e2e binary does not embed HEAD ${head.slice(0, 12)}` +
          (embedded ? ` (it embeds ${embedded.slice(0, 12)})` : ' (no commit sha found)') +
          (changed && changed.length
            ? `\n       app source changed since the build: ${changed.slice(0, 5).join(', ')}`
            : '') +
          `\n       rebuild: npm run build:e2e`,
      );
    }
  } else if (!quiet) {
    ok(`binary embeds HEAD ${head.slice(0, 12)}`);
  }
  if (!bytes.includes(Buffer.from(IDENTIFIER))) {
    hard(`e2e binary does not embed "${IDENTIFIER}" - wrong flavor, refusing to test against it`);
  }
  // Freshness: uncommitted source edits after the build are not covered by the
  // sha stamp. package.json is excluded on purpose: script edits (and this
  // skill's own npm scripts) do not change the compiled app, and flagging them
  // would push people to rebuild for nothing.
  const sources = [
    path.join(root, 'src'),
    path.join(root, 'src-tauri', 'src'),
    path.join(root, 'src-tauri', 'Cargo.toml'),
    path.join(root, 'src-tauri', 'build.rs'),
    path.join(root, 'src-tauri', 'tauri.conf.json'),
    path.join(root, 'src-tauri', 'tauri.e2e.conf.json'),
    path.join(root, 'index.html'),
    path.join(root, 'vite.config.ts'),
  ].filter((x) => fs.existsSync(x));
  const newest = Math.max(...sources.map((s) => {
    try {
      const st2 = fs.statSync(s);
      if (!st2.isDirectory()) return st2.mtimeMs;
      let m = 0;
      for (const f of walkShallow(s)) m = Math.max(m, f);
      return m;
    } catch { return 0; }
  }));
  const lagMs = newest - st.mtimeMs;
  if (lagMs > 1000) {
    hard(
      `source changed ${(lagMs / 60000).toFixed(1)} min AFTER the binary was built ` +
        `(newest source ${new Date(newest).toISOString()}, binary ${new Date(st.mtimeMs).toISOString()})` +
        `\n       rebuild: npm run build:e2e`,
    );
  } else if (!quiet) {
    ok(`binary ${humanBytes(st.size)}, built ${new Date(st.mtimeMs).toISOString()}, newer than all sources`);
  }
}

// 3. Driver
if (!provenanceOnly) {
  if (!fs.existsSync(p.driver)) {
    hard(`tauri-driver not found at ${p.driver}\n       install: cargo install tauri-driver  (or set WDIO_TAURI_DRIVER)`);
  } else if (!quiet) {
    ok(`tauri-driver ${p.driver}`);
  }

  // 4. Orphans
  for (const image of ['mobi-pos.exe', 'msedgedriver.exe', 'tauri-driver.exe']) {
    if (isRunning(image)) hard(`${image} is running - run: npm run e2e:clean`);
  }
  if (failures === 0 && !quiet) ok('no orphaned app/driver processes');

  // 5. Sandbox
  const dbExists = fs.existsSync(p.db);
  if (!quiet) {
    info(`sandbox ${p.sandbox}`);
    info(`db      ${p.db}${dbExists ? ` (${humanBytes(fs.statSync(p.db).size)})` : ' (absent - first run creates it)'}`);
    info(`webview ${p.webview}`);
  }
  if (process.env.POS_WDIO_SANDBOX) {
    warn(`POS_WDIO_SANDBOX is set - runs are isolated from the default sandbox`);
  }
}

// 6. Summary
console.log('');
if (failures > 0) {
  console.log(`${C.red}${failures} blocker(s), ${warnings} warning(s).${C.reset} Fix blockers before running the harness.`);
  process.exit(1);
}
console.log(`${C.green}preflight clear${C.reset}${warnings ? ` (${warnings} warning(s))` : ''}. Next: run the smoke spec.`);

/**
 * App-source paths changed between two commits.
 * Returns [] when the range provably touches no app source, an array of paths
 * when it does, and null when the range cannot be proven (unknown sha, not an
 * ancestor of `to`, git failure) - callers must treat null as a hard failure.
 */
function changedAppPaths(from, to, root) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: root, stdio: 'ignore' });
  } catch {
    return null; // build commit is not an ancestor of HEAD: cannot reason about it
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${from}..${to}`, '--', ...APP_PATHS], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** First 40-hex string in the binary that is a real commit in this repo. */
function findEmbeddedCommit(bytes, root) {
  const seen = new Set((bytes.toString('latin1').match(/[0-9a-f]{40}/g) || []));
  for (const sha of seen) {
    try {
      // execFileSync, not execSync: cmd.exe treats `^` as an escape character
      // and would hand git a mangled `{commit}` revision.
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
      return sha;
    } catch { /* not a commit in this repo */ }
  }
  return null;
}

function walkShallow(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'target') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { out.push(fs.statSync(full).mtimeMs); } catch { /* ignore */ } }
    }
  }
  return out;
}

#!/usr/bin/env node
/**
 * reset-sandbox.mjs - inspect or wipe the disposable E2E sandbox.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/reset-sandbox.mjs            # status
 *   node ... --wipe                                                        # delete e2e data dirs
 *
 * Safety:
 *   - refuses while mobi-pos.exe is running (the app holds the DB and WebView dir)
 *   - only deletes paths that contain the `com.mobi.pos.e2e` identifier
 *   - never touches the prod identifier (`com.mobi.pos`) or anything outside the sandbox
 *
 * Prefer `--wipe` on wdio (`POS_E2E_WIPE=1`) for a normal clean room; this script exists for
 * the case where the app cannot start at all and the sandbox must be inspected or reset.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, repoRoot, isRunning, humanBytes, dirSize, parseArgs, ok, bad, warn, info, e2eDataDirProblem } from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const p = paths(root);

if (isRunning('mobi-pos.exe')) {
  bad('mobi-pos.exe is running - run `npm run e2e:clean` first');
  process.exit(1);
}

function show() {
  info(`sandbox ${p.sandbox}`);
  for (const [label, dir] of [['data', p.appData], ['webview', p.webview]]) {
    const exists = fs.existsSync(dir);
    console.log(`  ${label.padEnd(8)} ${exists ? humanBytes(dirSize(dir)) : '(absent)'}  ${dir}`);
  }
  if (fs.existsSync(p.db)) {
    const st = fs.statSync(p.db);
    console.log(`  db       ${humanBytes(st.size)}  modified ${new Date(st.mtimeMs).toISOString()}`);
  } else {
    console.log('  db       (absent)');
  }
  const orphans = ['msedgedriver.exe', 'tauri-driver.exe'].filter((x) => isRunning(x));
  if (orphans.length) warn(`driver processes still running: ${orphans.join(', ')} (npm run e2e:clean)`);
}

if (!args.wipe) {
  show();
  info('nothing deleted; pass --wipe to reset');
  process.exit(0);
}

for (const dir of [p.appData, p.webview]) {
  const problem = e2eDataDirProblem(dir, p.sandbox);
  if (problem) {
    bad(`refusing to delete ${dir} (${problem})`);
    process.exit(1);
  }
}

for (const dir of [p.appData, p.webview]) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    ok(`wiped ${dir}`);
  } else {
    info(`already absent ${dir}`);
  }
}

show();
ok('sandbox reset');

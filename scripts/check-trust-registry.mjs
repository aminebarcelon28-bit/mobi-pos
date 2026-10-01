#!/usr/bin/env node
/**
 * Trust-registry enforcement (Phase 1, G-07).
 *
 * Fails the build when:
 *  1. a `#[tauri::command]` function in src-tauri/src is missing from both
 *     COMMAND_REGISTRY and PUBLIC_COMMANDS in
 *     src-tauri/src/trust_core/ipc_authorizer.rs, or
 *  2. a registry entry / public entry has no corresponding `#[tauri::command]`
 *     (stale entry), or
 *  3. a non-public handler body does not reference `authorize_and_execute`,
 *     `require_capability`, or a documented delegate (po_* canonicals).
 *
 * This is the CI counterpart of the Rust `registry_covers_every_tauri_command`
 * and `every_handler_references_authorization` unit tests: it runs in plain
 * Node without a Rust toolchain.
 *
 * Usage: node scripts/check-trust-registry.mjs
 * Exit:  0 = clean, 1 = violation(s) found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src-tauri', 'src');
const AUTHORIZER = join(SRC, 'trust_core', 'ipc_authorizer.rs');

// Commands allowed to delegate to a canonical instead of wrapping directly.
const DELEGATES = {
  process_raw_scan: 'po_process_raw_scan',
  commit_stock_batch: 'po_commit_stock_batch',
};

function collectRs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'gen' || name === 'target-test') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (dir === SRC) collectRs(p, out); // one level (trust_core/) is enough
    } else if (name.endsWith('.rs')) {
      out.push(p);
    }
  }
  return out;
}

/** All `[async] fn NAME` following a `#[tauri::command]` line (pub or private). */
function parseTauriCommands(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '#[tauri::command]') {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;
        let m = t.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
        if (m) out.push(m[1]);
        break;
      }
    }
  }
  return out;
}

/** window of text after each command fn signature (authorization must be near the top). */
function commandBody(text, name, window = 4000) {
  const i = text.search(new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\b`));
  return i < 0 ? '' : text.slice(i, i + window);
}

function parseStringList(text, constName) {
  const m = text.match(new RegExp(`static\\s+${constName}[^=]*=\\s*&\\[([\\s\\S]*?)\\];`));
  if (!m) return null;
  return [...m[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]);
}

function parseRegistry(text) {
  const m = text.match(/static\s+COMMAND_REGISTRY[^=]*=\s*&\[([\s\S]*?)\];/);
  if (!m) return null;
  return [...m[1].matchAll(/"([A-Za-z0-9_]+)"\s*,\s*Capability::([A-Za-z0-9_]+)/g)].map(
    ([, cmd, cap]) => ({ cmd, cap })
  );
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log('========================================================================');
console.log('MOBIPOS — TRUST REGISTRY ENFORCEMENT (Phase 1)');
console.log('========================================================================\n');

const violations = [];

if (!existsSync(AUTHORIZER)) {
  console.error('  [FAIL] trust_core/ipc_authorizer.rs missing');
  process.exit(1);
}
const authText = readFileSync(AUTHORIZER, 'utf8');
const registry = parseRegistry(authText);
const publicCmds = parseStringList(authText, 'PUBLIC_COMMANDS');
if (!registry || !publicCmds) {
  console.error('  [FAIL] could not parse COMMAND_REGISTRY / PUBLIC_COMMANDS');
  process.exit(1);
}
const registered = new Set(registry.map((r) => r.cmd));
const pubSet = new Set(publicCmds);

// 1+2. Coverage both directions.
const found = new Map(); // name -> file
for (const file of collectRs(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const name of parseTauriCommands(text)) {
    if (file.endsWith(join('trust_core', 'ipc_authorizer.rs'))) {
      // The mechanism itself (get_gate_state, trust_*): still must be listed.
    }
    found.set(name, file);
  }
}
for (const [name, file] of found) {
  if (!registered.has(name) && !pubSet.has(name)) {
    violations.push(`[MISSING] ${name} (${file}) — no registry/public entry (deny-by-default would block it)`);
  } else {
    console.log(`  [PASS] ${name} — ${registered.has(name) ? `registry (${registry.find((r) => r.cmd === name).cap})` : 'public'}`);
  }
}
for (const { cmd } of registry) {
  if (!found.has(cmd)) violations.push(`[STALE] registry entry ${cmd} has no #[tauri::command]`);
}
for (const name of pubSet) {
  if (!found.has(name)) violations.push(`[STALE] public entry ${name} has no #[tauri::command]`);
}

// 3. Wrapper presence (skip trust_core itself + public probes).
for (const [name, file] of found) {
  if (file.endsWith(join('trust_core', 'ipc_authorizer.rs'))) continue;
  if (pubSet.has(name)) continue;
  const text = readFileSync(file, 'utf8');
  const body = commandBody(text, name);
  const wrapped =
    body.includes('authorize_and_execute') || body.includes('require_capability');
  const delegated = DELEGATES[name] ? body.includes(DELEGATES[name]) : false;
  if (!wrapped && !delegated) {
    violations.push(`[BYPASS] ${name} (${file}) — handler does not call authorize_and_execute/require_capability`);
  }
}

console.log('');
if (violations.length === 0) {
  console.log(`RESULT: ${found.size} command(s), registry intact.`);
  process.exit(0);
} else {
  for (const v of violations) console.error(`  [FAIL] ${v}`);
  console.error(`\nRESULT: ${violations.length} VIOLATION(S).`);
  process.exit(1);
}

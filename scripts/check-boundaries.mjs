#!/usr/bin/env node
/**
 * Module Boundary Enforcement
 *
 * ── WHY A SCRIPT AND NOT A LINT RULE ────────────────────────────────────────
 * The project uses oxlint, which has no import-boundary rule (its `restriction`
 * category covers language features, not module graphs). dependency-cruiser is
 * not installed. Rather than leave the licensing boundary as a comment, this
 * script makes it a build failure: it parses the import graph of the files that
 * form the locked-terminal surface and rejects any edge into the operating app.
 *
 * ── THE BOUNDARY ───────────────────────────────────────────────────────────
 * A terminal whose licence is not ACTIVE renders exactly one screen:
 * ActivationGateScreen. That screen and the licensing modules it depends on must
 * never be able to reach:
 *
 *   • the POS store            → would re-hydrate products, cart, ledgers
 *   • db/adapters, repositories→ pooled WRITABLE handle to the live database
 *   • db/sqlPluginAdapter      → loads the plugin pool (the app's whole DB layer)
 *   • sync/*                   → network egress from a locked terminal
 *   • domain action creators   → operational capability without a licence
 *
 * The one permitted data path is `licensing/emergencyExporter`, which talks to a
 * dedicated `SQLITE_OPEN_READ_ONLY` native handle. This is the regression guard
 * for the expired-licence bypass that shipped once already.
 *
 * Usage:  node scripts/check-boundaries.mjs
 * Exit:   0 = clean, 1 = violation(s) found
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Files subject to the locked-surface boundary, with the extra private
 * prefixes each may not reach beyond the global list.
 */
const GUARDED_FILES = [
  'components/licensing/ActivationGateScreen.tsx',
  'licensing/emergencyExporter.ts',
];

/**
 * Forbidden import targets, matched as path prefixes relative to `src/`.
 * Listed most-specific first; a match on any entry is a violation.
 */
const FORBIDDEN_PREFIXES = [
  'store/',
  'db/adapters/',
  'db/repositories/',
  'db/sqlPluginAdapter',
  'db/sqliteAdapter',
  'db/sqlPluginAdapter.ts',
  'db/database',
  'sync/',
  'services/',
  'hooks/usePos',
  'features/',
];

/**
 * Explicitly allowed escapes. The emergency exporter needs exactly one data
 * dependency; listing it here means a NEW dependency is a deliberate edit to
 * this file, not an accident.
 */
const ALLOWED_EXCEPTIONS = {
  'components/licensing/ActivationGateScreen.tsx': [
    'platform/invoke', // via emergencyExporter
    'api/license', // HWID type only
    'utils/platform',
    'utils/security',
  ],
  'licensing/emergencyExporter.ts': [
    'platform/invoke', // thin typed IPC, no app state
  ],
};

/**
 * Modules that are safe to import from the gate because they are pure
 * licensing logic with no data-layer or store dependency of their own.
 */
const GUARDED_SAFE_DEPS = new Set([
  'licensing/',
  'platform/',
  'utils/platform',
  'utils/security',
  'api/license',
  'types/',
  'constants/',
]);

// ── Import extraction ───────────────────────────────────────────────────────

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(source) {
  const specs = new Set();
  // Strip block/line comments so a commented-out import is not counted, but
  // keep the naive scan: over-reporting a violation is the safe direction.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(stripped)) !== null) {
    const spec = m[1] || m[2];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

/** Resolve a relative import specifier to a `src/`-relative path, or null. */
function resolveToSrcRelative(fromFile, spec) {
  if (!spec.startsWith('.')) {
    // Bare specifier: an npm package, not an intra-src edge.
    return null;
  }
  const abs = resolve(dirname(fromFile), spec);
  const rel = relative(SRC, abs);
  if (rel.startsWith('..')) return null; // escapes src/
  return rel.split(sep).join('/');
}

/** True when `rel` (src-relative) is inside `prefix` (also src-relative). */
function isUnder(rel, prefix) {
  return rel === prefix || rel.startsWith(prefix);
}

// ── Checker ─────────────────────────────────────────────────────────────────

function checkFile(relFile) {
  const abs = join(SRC, relFile);
  const source = readFileSync(abs, 'utf8');
  const exceptions = new Set(ALLOWED_EXCEPTIONS[relFile] || []);
  const violations = [];

  for (const spec of extractImports(source)) {
    const rel = resolveToSrcRelative(abs, spec);
    if (!rel) continue;

    // Resolve a directory import to its index file for reporting clarity.
    const reported = existsSync(join(SRC, rel))
      ? rel
      : existsSync(join(SRC, `${rel}.ts`))
        ? `${rel}.ts`
        : existsSync(join(SRC, rel, 'index.ts'))
          ? `${rel}/index.ts`
          : rel;

    if (exceptions.has(reported) || exceptions.has(rel)) continue;

    const forbidden = FORBIDDEN_PREFIXES.find((p) => isUnder(reported, p));
    if (forbidden) {
      violations.push({
        file: relFile,
        spec,
        resolved: reported,
        reason: `imports into the operating app (${forbidden}*)`,
      });
      continue;
    }

    // Transitive guard: a guarded file may only reach other licensing-safe
    // modules. Anything else is an unexplained edge into app code.
    const safe = [...GUARDED_SAFE_DEPS].some((p) => isUnder(reported, p));
    if (!safe) {
      violations.push({
        file: relFile,
        spec,
        resolved: reported,
        reason: 'imports a module outside the licensing-safe allowlist',
      });
    }
  }

  return violations;
}

/** Files under `src/features/` if that tree exists (directive refers to it). */
function featureTreeExists() {
  return existsSync(join(SRC, 'features'));
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log('========================================================================');
console.log('MOBIPOS — MODULE BOUNDARY ENFORCEMENT');
console.log('========================================================================\n');

let allViolations = [];
let checked = 0;

for (const relFile of GUARDED_FILES) {
  const abs = join(SRC, relFile);
  if (!existsSync(abs)) {
    console.error(`  [FAIL] Guarded file missing: ${relFile}`);
    allViolations.push({ file: relFile, spec: '-', resolved: '-', reason: 'file missing' });
    continue;
  }
  checked += 1;
  const violations = checkFile(relFile);
  if (violations.length === 0) {
    console.log(`  [PASS] ${relFile} — no forbidden imports`);
  } else {
    for (const v of violations) {
      console.error(`  [FAIL] ${v.file}: '${v.spec}' → ${v.resolved} — ${v.reason}`);
    }
  }
  allViolations = allViolations.concat(violations);
}

console.log('');
if (featureTreeExists()) {
  console.log('  [INFO] src/features/ detected and covered by the forbidden list.');
} else {
  console.log('  [INFO] src/features/ not present; the prefix is still blocked for when it lands.');
}

// Report the enforced surface so a reviewer can see what was inspected.
console.log('\n  Inspected import graph:');
for (const relFile of GUARDED_FILES) {
  const abs = join(SRC, relFile);
  if (!existsSync(abs)) continue;
  const specs = extractImports(readFileSync(abs, 'utf8')).filter((s) => s.startsWith('.'));
  console.log(`    ${relFile}`);
  for (const s of specs) console.log(`      → ${s}`);
}

console.log('');
if (allViolations.length === 0) {
  console.log(`RESULT: ${checked} guarded file(s), 0 violations — boundary intact.`);
  process.exit(0);
} else {
  console.error(`RESULT: ${allViolations.length} VIOLATION(S) — the locked-terminal surface can reach the operating app.`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Phase 4.5 WP2c verification:
 *  1. benchHook math (p50/p95 pairing) + default-off behavior (real unit).
 *  2. Source gates: no STATIC import of benchHook anywhere in src (the module
 *     must not be reachable from the production entry except through a
 *     DEV-guarded dynamic import), call sites use devBenchMark only, and no
 *     unconditional performance.now was added to the production adapter path.
 *  3. Bundle inspection (not a flag check): the built release bundle
 *     (dist/assets/*.js) must contain no benchHook-only marker — if the
 *     module were bundled, its span strings and 'MOBI_BENCH' would be in the
 *     output. Requires a prior `npm run build`; fails loudly otherwise.
 *
 * Usage: node --experimental-strip-types scripts/test_bench_hook.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

console.log('== benchHook unit behavior ==');
const hook = await import('../src/db/benchHook.ts');

// Default: off, zero marks recorded.
check('default off', hook.isBenchEnabled() === false);
hook.benchMark('checkout:start');
check(
  'no-op while off',
  hook.getBenchReport().every((s) => s.count === 0)
);

// Enabled via Node bench env (browser release has neither DEV nor this var).
process.env.MOBI_BENCH = '1';
const { setBenchEnabled, benchMark, getBenchReport, __clearBenchMarksForTests } = hook;
setBenchEnabled(true);
check('arms under MOBI_BENCH=1', hook.isBenchEnabled() === true);
__clearBenchMarksForTests();
// NOTE: performance.now is real time; use busy-loop-free synthetic spacing
// via two marked sections with a tiny sleep between.
benchMark('checkout:start');
await new Promise((r) => setTimeout(r, 15));
benchMark('checkout:pre-commit');
await new Promise((r) => setTimeout(r, 5));
benchMark('checkout:post-commit');
benchMark('checkout:start');
benchMark('checkout:pre-commit');
benchMark('checkout:post-commit');
const rep = getBenchReport();
const total = rep.find((s) => s.span === 'checkout:total');
check('two totals paired', total && total.count === 2);
check('p50/p95 ordered', total && total.p50 <= total.p95 && total.mean >= 0);
check('total >= db-work', (() => {
  const work = rep.find((s) => s.span === 'checkout:db-work');
  return work && total && total.p50 >= work.p50;
})());
setBenchEnabled(false);
delete process.env.MOBI_BENCH;

console.log('== source gates ==');
const hookSrc = readFileSync(join(ROOT, 'src/db/benchHook.ts'), 'utf8');
check('DEV gate present', hookSrc.includes('import.meta') && hookSrc.includes('.env.DEV'));
check('release refusal path', hookSrc.includes('isDevBuild'));
check('hook imports nothing (no cycles, no side effects)', !/^\s*import\s/m.test(hookSrc.replace(/^\s*import\s+type/m, '')));
const adapterSrc = readFileSync(join(ROOT, 'src/db/sqlPluginAdapter.ts'), 'utf8');
check(
  'no static benchHook import in adapter (bundle-absence)',
  !/from\s+['"]\.\/benchHook['"]/.test(adapterSrc)
);
check(
  'marks go through DEV-guarded lazy import',
  adapterSrc.includes('import.meta.env.DEV') && adapterSrc.includes("import('./benchHook')")
);
check(
  'no raw performance.now in adapter (all timing via hook)',
  !adapterSrc.includes('performance.now')
);
check(
  'adapter never enables the hook',
  !adapterSrc.includes('setBenchEnabled(true')
);

// Static reachability: walk relative imports from the production entry and
// prove benchHook.ts is NOT statically reachable. Dynamic import() edges are
// followed only through files containing `import.meta.env.DEV` (the one
// sanctioned lazy edge); any other dynamic edge to benchHook fails.
console.log('== static reachability from src/main.tsx ==');
const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
function resolveSrc(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec);
  for (const cand of [base + '.ts', base + '.tsx', join(base, 'index.ts'), base]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}
function* walkStatic(entryAbs) {
  const seen = new Set();
  const stack = [entryAbs];
  while (stack.length > 0) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src = '';
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    yield { file: f, src };
    STATIC_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = STATIC_IMPORT_RE.exec(src)) !== null) {
      const r = resolveSrc(f, m[1]);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
}
{
  const entry = join(SRC, 'main.tsx');
  let staticHit = null;
  let dynamicEdges = [];
  for (const { file, src } of walkStatic(entry)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'db/benchHook.ts') staticHit = rel;
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = DYNAMIC_IMPORT_RE.exec(src)) !== null) {
      const r = resolveSrc(file, m[1]);
      if (r && relative(SRC, r).split(sep).join('/') === 'db/benchHook.ts') {
        dynamicEdges.push({ from: rel, devGuarded: src.includes('import.meta.env.DEV') });
      }
    }
  }
  check('benchHook not statically reachable from main.tsx', staticHit === null, staticHit ? `(via ${staticHit})` : '');
  check(
    'exactly one dynamic edge, DEV-guarded (adapter)',
    dynamicEdges.length === 1 && dynamicEdges[0].devGuarded === true,
    JSON.stringify(dynamicEdges)
  );
}

// Bundle inspection: the release build must not contain the module. The
// span labels and MOBI_BENCH exist nowhere else in src (asserted below), so
// their absence from dist proves absence of the module — not of a flag.
// Bundle inspection: the release build must not contain the module. The
// span labels and MOBI_BENCH exist nowhere else in src (asserted below), so
// their absence from dist proves absence of the module — not of a flag.
// Pure-Node recursive search: no rg/node_modules dependency.
function filesWithMarker(dir, marker, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st = null;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      filesWithMarker(p, marker, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) {
      try {
        if (readFileSync(p, 'utf8').includes(marker)) out.push(p);
      } catch {
        // unreadable — ignore (bundled .min.js may be binary-ish; read as
        // latin1 fallback below in the dist scan)
      }
    }
  }
  return out;
}
console.log('== release bundle inspection (dist/) ==');
{
  const distAssets = join(ROOT, 'dist', 'assets');
  const srcHitsPre = filesWithMarker(SRC, 'checkout:pre-commit').filter(
    (p) => relative(SRC, p).split(sep).join('/') !== 'db/benchHook.ts'
  );
  check('checkout:pre-commit unique to benchHook in src', srcHitsPre.length === 0, srcHitsPre.join(','));
  const srcHitsBench = filesWithMarker(SRC, 'MOBI_BENCH').filter(
    (p) => relative(SRC, p).split(sep).join('/') !== 'db/benchHook.ts'
  );
  check('MOBI_BENCH unique to benchHook in src', srcHitsBench.length === 0, srcHitsBench.join(','));
  if (!existsSync(distAssets)) {
    failures += 1;
    console.error('  [FAIL] dist/assets missing — run `npm run build` first, then re-run this gate.');
  } else {
    const hits = [];
    for (const marker of ['checkout:pre-commit', 'MOBI_BENCH', 'benchHook']) {
      for (const f of filesWithMarker(distAssets, marker)) hits.push(`${marker} in ${relative(ROOT, f)}`);
    }
    check('benchHook absent from release bundle', hits.length === 0, hits.join('; '));
  }
}

console.log('');
if (failures === 0) {
  console.log('RESULT: bench hook checks passed.');
} else {
  console.error(`RESULT: ${failures} FAILURE(S).`);
  process.exit(1);
}

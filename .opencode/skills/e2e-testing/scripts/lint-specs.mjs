#!/usr/bin/env node
/**
 * lint-specs.mjs - the spec/index contract, checked mechanically.
 *
 * Checks:
 *   1. every literal `it('...')` title carries a case id (catalog or a declared
 *      non-catalog family). Titles built from a variable (`it(id, ...)`, the
 *      `harness('LBL-11', ...)` pattern) are counted separately - their ids are
 *      proven by check 2 instead of by the title.
 *   2. every catalog-shaped id that appears in spec code exists in
 *      CASE_INDEX.csv (comments are stripped first: a doc comment listing an id
 *      must never be mistaken for coverage).
 *   3. every active CASE_INDEX row is anchored: it names an existing spec file
 *      that mentions the id, or it is BLOCKED / N/A with a reason in `evidence`.
 *   4. every spec file the index names exists.
 *
 * Ratchet: `references/lint-exemptions.json` (or
 * `e2e-tests/fixtures/lint-exemptions.json` in fixtures) may baseline known
 * violations, each with a `reason`. Baselines are printed as debt, never
 * silently. `--strict` ignores the baseline and fails on any violation.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/lint-specs.mjs [--strict] [--json]
 *   node ... --exemptions <file>
 *
 * Exit: 0 contract holds (baseline aside), 1 violations, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  repoRoot, parseArgs, readIndex, activeRows, classifyId, bareId, ID_CATALOG_RE, C, bad, warn,
} from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const E2E = path.join(root, 'e2e-tests');
const SPECS = path.join(E2E, 'specs');
const STRICT = Boolean(args.strict);

if (!fs.existsSync(SPECS)) {
  bad(`no specs directory at ${path.relative(root, SPECS)}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* exemptions (the ratchet)                                            */
/* ------------------------------------------------------------------ */

function exemptionsFile() {
  if (args.exemptions) return path.resolve(root, String(args.exemptions));
  const candidates = [
    path.join(E2E, 'fixtures', 'lint-exemptions.json'),
    path.join(root, '.opencode', 'skills', 'e2e-testing', 'references', 'lint-exemptions.json'),
  ];
  return candidates.find((f) => fs.existsSync(f)) || candidates[1];
}

const exemptFile = exemptionsFile();
let exemptions = { files: [], cases: [], tokens: [] };
if (fs.existsSync(exemptFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(exemptFile, 'utf8'));
    exemptions = {
      files: Array.isArray(parsed.files) ? parsed.files : [],
      cases: Array.isArray(parsed.cases) ? parsed.cases : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    };
  } catch (err) {
    bad(`cannot parse ${path.relative(root, exemptFile)}: ${err.message}`);
    process.exit(2);
  }
}
const exemptFiles = new Map(exemptions.files.map((e) => [String(e.file || e.id || ''), String(e.reason || '')]));
const exemptCases = new Map(exemptions.cases.map((e) => [String(e.id || ''), String(e.reason || '')]));
const exemptTokens = new Map(exemptions.tokens.map((e) => [`${e.file}|${e.id}`, String(e.reason || '')]));

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Remove `//` and block comments, respecting string literals. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `src` mention `id` as a standalone token? */
function mentions(src, id) {
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(id)}(?![0-9])`).test(src);
}

const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]{0,7}(?:-[A-Z0-9]+){1,3}(?:\/[A-Z0-9-]+)?(?![0-9])/g;

/** Case ids (catalog or family) carried by a title. */
function idsInTitle(title) {
  const found = new Set();
  for (const m of title.matchAll(/\[([^\]]+)\]/g)) {
    if (classifyId(m[1])) found.add(bareId(m[1]));
  }
  for (const m of title.matchAll(TOKEN_RE)) {
    if (classifyId(m[0])) found.add(m[0]);
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/* read the index                                                      */
/* ------------------------------------------------------------------ */

const index = readIndex(root);
for (const need of ['id', 'verdict', 'spec', 'evidence']) {
  if (index.ix[need] === undefined) {
    bad(`CASE_INDEX.csv has no "${need}" column`);
    process.exit(2);
  }
}
const active = activeRows(index);
const csvIds = new Set(active.map((r) => index.get(r, 'id')));
const retiredIds = new Set(index.rows.filter((r) => !active.includes(r)).map((r) => index.get(r, 'id')));
/**
 * Tokens that look like case ids but are not: encodings, digests and the
 * owner's priority-bug references (`P0-18` = "P0 bug #18"). Kept as a short,
 * explicit list so a genuinely unknown case id still fails the lint.
 */
const NOT_A_CASE = [
  /^UTF-(?:8|16|32)$/,
  /^ISO-\d+$/,
  /^SHA-\d+$/,
  /^AES-\d+$/,
  /^P[0-2]-\d+$/,
];
const ignoredTokens = new Map();

/* ------------------------------------------------------------------ */
/* scan the specs                                                      */
/* ------------------------------------------------------------------ */

const specFiles = fs.readdirSync(SPECS).filter((f) => f.endsWith('.e2e.ts')).sort();
const sources = new Map();
for (const f of specFiles) {
  sources.set(f, stripComments(fs.readFileSync(path.join(SPECS, f), 'utf8')));
}

const violations = [];       // { key, where, what }
const debt = [];             // { key, where, what, reason }
const nonCatalog = new Map(); // family -> count
let literalTitles = 0;
let variableTitles = 0;
const titleIds = new Set();

for (const f of specFiles) {
  const src = sources.get(f);
  const fileExempt = exemptFiles.has(f);

  // 1. it() titles
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const where = `${f}:${i + 1}`;
    const lit = /\bit\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(line);
    const vari = /\bit\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(line);
    if (lit) {
      literalTitles++;
      const ids = idsInTitle(lit[2]);
      if (!ids.length) {
        const what = `it() title carries no case id: "${lit[2].slice(0, 70)}"`;
        if (fileExempt) debt.push({ key: f, where, what, reason: exemptFiles.get(f) });
        else violations.push({ key: f, where, what });
      }
      for (const id of ids) titleIds.add(id);
    } else if (vari) {
      variableTitles++;
    }
  });

  // 2. ids present in code (comments already stripped)
  for (const m of src.matchAll(TOKEN_RE)) {
    const cls = classifyId(m[0]);
    if (!cls) continue;
    if (cls !== 'catalog') {
      nonCatalog.set(cls, (nonCatalog.get(cls) || 0) + 1);
      continue;
    }
    if (csvIds.has(m[0]) || retiredIds.has(m[0])) continue;
    if (NOT_A_CASE.some((re) => re.test(m[0]))) {
      ignoredTokens.set(m[0], (ignoredTokens.get(m[0]) || 0) + 1);
      continue;
    }
    const tokenExempt = exemptTokens.get(`${f}|${m[0]}`);
    if (tokenExempt !== undefined) {
      debt.push({ key: m[0], where: f, what: `${m[0]} in spec code is not a case id`, reason: tokenExempt });
      continue;
    }
    violations.push({ key: m[0], where: f, what: `${m[0]} appears in spec code but is not in CASE_INDEX.csv` });
  }
}

/* ------------------------------------------------------------------ */
/* resolve the file the index names (spec, or a tool that proves it)    */
/* ------------------------------------------------------------------ */

const SOURCE_ROOTS = ['', 'specs', 'tools', 'mobile'];
const sourceCache = new Map();
function resolveSource(name) {
  if (sourceCache.has(name)) return sourceCache.get(name);
  let hit = null;
  for (const root of SOURCE_ROOTS) {
    const full = path.join(E2E, root, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) { hit = full; break; }
  }
  // A mocha spec is judged on its CODE (a doc comment listing ids must never
  // fake coverage). A tool/mobile script is judged on its whole text: its
  // header comment is where it documents the case it produces evidence for.
  const isSpec = hit ? path.dirname(hit) === SPECS : false;
  const entry = hit
    ? { file: hit, text: isSpec ? stripComments(fs.readFileSync(hit, 'utf8')) : fs.readFileSync(hit, 'utf8') }
    : null;
  sourceCache.set(name, entry);
  return entry;
}

// 3. every active row is anchored
let anchoredBySpec = 0;
let anchoredByReason = 0;
for (const row of active) {
  const id = index.get(row, 'id');
  const verdict = index.get(row, 'verdict');
  const spec = index.get(row, 'spec');
  const evidence = index.get(row, 'evidence');
  const specName = spec && !['—', '-', '–'].includes(spec) ? spec : '';
  const exempt = exemptCases.get(id);

  if (specName) {
    const resolved = resolveSource(specName);
    if (!resolved) {
      const what = `names "${specName}" which does not exist under e2e-tests/{,specs,tools,mobile}`;
      if (exempt !== undefined) debt.push({ key: id, where: id, what, reason: exempt });
      else violations.push({ key: id, where: id, what });
      continue;
    }
    if (mentions(resolved.text, id)) { anchoredBySpec++; continue; }
    const what = `${path.relative(E2E, resolved.file).replace(/\\/g, '/')} never mentions ${id}`;
    if (exempt !== undefined) debt.push({ key: id, where: id, what, reason: exempt });
    else violations.push({ key: id, where: id, what });
    continue;
  }

  if (verdict === 'BLOCKED' || verdict === 'N/A') {
    if (evidence.length >= 8) { anchoredByReason++; continue; }
    const what = `${verdict} with no reason in evidence (needs to name the dependency / the absence)`;
    if (exempt !== undefined) debt.push({ key: id, where: id, what, reason: exempt });
    else violations.push({ key: id, where: id, what });
    continue;
  }

  const what = `active ${verdict} with no spec and no BLOCKED/N/A reason`;
  if (exempt !== undefined) debt.push({ key: id, where: id, what, reason: exempt });
  else violations.push({ key: id, where: id, what });
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const counted = STRICT ? [...violations, ...debt.map((d) => ({ ...d, baselined: true }))] : violations;
const familySummary = [...nonCatalog.entries()].map(([k, n]) => `${k}:${n}`).join(' ');

/* --json is machine output only: no human lines before or after it. */
if (args.json) {
  console.log(JSON.stringify({
    specs: specFiles.length,
    literalTitles,
    variableTitles,
    anchoredBySpec,
    anchoredByReason,
    nonCatalog: Object.fromEntries(nonCatalog),
    violations: counted,
    debt,
    strict: STRICT,
    exit: counted.length ? 1 : 0,
  }, null, 1));
  process.exit(counted.length ? 1 : 0);
}

console.log(`${C.cyan}lint-specs${C.reset} ${specFiles.length} spec file(s), ${active.length} active case(s)`);
console.log('');
console.log(`${C.green}ok  ${C.reset} it() titles with a case id      ${literalTitles - violations.filter((v) => v.what.startsWith('it() title')).length}/${literalTitles} literal (${variableTitles} built from a variable)`);
console.log(`${C.green}ok  ${C.reset} active rows anchored           ${anchoredBySpec} by spec + ${anchoredByReason} by BLOCKED/N/A reason`);
if (familySummary) console.log(`${C.dim}     non-catalog ids (declared families, not failures): ${familySummary}${C.reset}`);
if (ignoredTokens.size) console.log(`${C.dim}     ignored tokens (not case ids): ${[...ignoredTokens.entries()].map(([k, n]) => `${k}:${n}`).join(' ')}${C.reset}`);

if (counted.length) {
  bad(`${counted.length} violation(s)${STRICT && debt.length ? ' (--strict: baselined debt counts)' : ''}`);
  for (const v of counted.slice(0, 25)) {
    console.log(`       - ${v.where}: ${v.what}${v.baselined ? '  [baselined]' : ''}`);
  }
  if (counted.length > 25) console.log(`       … ${counted.length - 25} more`);
} else {
  console.log(`${C.green}ok  ${C.reset} no violations`);
}

if (debt.length && !STRICT) {
  console.log('');
  console.log(`${C.yellow}debt${C.reset} ${debt.length} baselined violation(s) in ${path.relative(root, exemptFile)} - fix them, do not grow the list`);
  for (const d of debt.slice(0, 25)) console.log(`       - ${d.key}: ${d.what}  (${d.reason})`);
  if (debt.length > 25) console.log(`       … ${debt.length - 25} more`);
}

console.log('');
if (counted.length) {
  console.log(`${C.red}LINT FAILED${C.reset} ${counted.length} violation(s).`);
  process.exit(1);
}
console.log(`${C.green}LINT OK${C.reset} every spec id is in the index, every active case is anchored.`);

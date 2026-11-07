/**
 * Results parsing - one definition of "what counts as per-case verdicts".
 *
 * Every script that consumes a run (delta, verdicts, repeat-run, prove-fix)
 * goes through here, so a run sidecar cannot be mistaken for results and a
 * malformed NDJSON line cannot be skipped silently.
 *
 * Accepted inputs for `parseVerdicts`:
 *   - JSON object map         { "REF-03": "FAIL", ... }
 *   - JSON array of case rows [ { "id": "REF-03", "verdict": "FAIL" }, ... ]
 *   - JSON array of suite rows[ { "spec": "...", "cases": { "REF-03": "FAIL" } } ]
 *   - NDJSON                  one { "id": ..., "verdict": ... } per line
 *   - VERDICT lines           VERDICT=REF-03 FAIL   (mixed with NDJSON is fine)
 *
 * Rejected (throws InputError, callers exit 2):
 *   - a run sidecar (tag/gitSha/exitCode/passing...)
 *   - raw WDIO events.ndjson (kind + fullTitle): run verdicts.mjs first
 *   - unknown ids, unknown verdicts, an empty result set, malformed NDJSON
 */
import fs from 'node:fs';
import { VERDICTS, ID_CATALOG_RE } from './_lib.mjs';

export class InputError extends Error {}

const SIDECAR_KEYS = ['tag', 'gitSha', 'exitCode', 'passing', 'failing', 'durationMs', 'startedAt'];

function normVerdict(v) {
  return String(v ?? '').trim().toUpperCase();
}

function isVerdict(v) {
  return VERDICTS.includes(v);
}

function looksLikeSidecar(obj) {
  return obj && typeof obj === 'object' && SIDECAR_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function looksLikeEvent(obj) {
  return obj && typeof obj === 'object' && typeof obj.fullTitle === 'string' &&
    (Object.prototype.hasOwnProperty.call(obj, 'kind') || Object.prototype.hasOwnProperty.call(obj, 'state'));
}

/** `VERDICT=<ID> <VERDICT>` - the author's explicit statement, parsed strictly.
 *
 *  Three real shapes must match, or the protocol silently degrades to the
 *  mocha outcome (a spec-recorded FAIL becomes PASS):
 *    VERDICT=REF-03 FAIL
 *    [0-0] VERDICT=REF-03 FAIL            <- WDIO prefixes every log line
 *    [0-0] VERDICT=REF-03 FAIL | evidence <- the note is allowed after `|`
 *  Anything else (prose, a bare id) is ignored, and an unknown verdict word
 *  after a matched id still throws.
 */
export function parseVerdictLines(text) {
  const out = new Map();
  const re = /^\s*(?:\[[^\]]*\]\s*)?VERDICT\s*=\s*([A-Za-z][A-Za-z0-9]{1,3}-\d{1,3})\s+([A-Za-z/-]+)(?:\s*\|.*)?\s*$/;
  // Second in-repo convention, observed in the DAT/RCP/TIM/LBL specs:
  //   [DAT-51] BLOCKED - no previous-version installer ...
  //   [RCP-19] N/A - the product has no report printer routing ...
  // These specs assert the case's own verdict in prose and then PASS the mocha
  // test; reading only `VERDICT=` promoted five BLOCKED/N/A cases to PASS on
  // 2026-10-30. The bracket form is accepted, still line-anchored, and only
  // when a verdict word follows the id.
  const bracket = /^\s*(?:\[[^\]]*\]\s*)?\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]\s+(PASS-PARTIAL|BLOCKED|N\/A|FAIL|PASS)\b/;
  // Third form, used by 26-rcp-tim / 21-dat style specs:
  //   [RCP-19] VERDICT=BLOCKED BLOCKED: needs a healthy Android install ...
  const idFirst = /^\s*(?:\[[^\]]*\]\s*)?\[?([A-Z][A-Z0-9]{1,3}-\d{2,3})\]?\s+VERDICT\s*=\s*(PASS-PARTIAL|BLOCKED|N\/A|FAIL|PASS)\b/;
  for (const line of String(text).split(/\r?\n/)) {
    const m = re.exec(line) ?? idFirst.exec(line) ?? bracket.exec(line);
    if (!m) continue;
    const id = m[1];
    const verdict = normVerdict(m[2]);
    if (!isVerdict(verdict)) throw new InputError(`VERDICT line for ${id} has an unknown verdict "${m[2]}"`);
    out.set(id, verdict);
  }
  return out;
}

function addCase(map, id, verdict, where) {
  const key = String(id ?? '').trim();
  const v = normVerdict(verdict);
  if (!key) throw new InputError(`${where}: a case row has no id`);
  if (!ID_CATALOG_RE.test(key)) {
    throw new InputError(`${where}: "${key}" is not a case id (expected DOMAIN-NN, e.g. REF-03)`);
  }
  if (!isVerdict(v)) {
    throw new InputError(`${where}: ${key} has an unknown verdict "${verdict}" (one of ${VERDICTS.join(', ')})`);
  }
  map.set(key, v);
}

/**
 * Parse a results file into a Map<id, verdict>.
 * Throws InputError with a message that says what to do instead.
 */
export function parseVerdicts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new InputError(`cannot read ${file}: ${err.message}`);
  }
  const trimmed = text.trim();
  if (!trimmed) throw new InputError(`${file} is empty - no per-case verdicts`);

  const cases = new Map();
  const kind = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'ndjson';

  if (kind === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new InputError(`${file} is not valid JSON: ${err.message}`);
    }
    if (looksLikeSidecar(parsed)) {
      throw new InputError(
        `${file} is a run sidecar, not per-case verdicts. Extract them first:\n` +
          `  node .opencode/skills/e2e-testing/scripts/verdicts.mjs --run ${file} --out verdicts.json`,
      );
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) throw new InputError(`${file} is an empty array - no per-case verdicts`);
      for (const row of parsed) {
        if (looksLikeEvent(row)) {
          throw new InputError(`${file} holds raw WDIO events, not verdicts. Run verdicts.mjs --events ${file}`);
        }
        if (row && typeof row === 'object' && row.cases && typeof row.cases === 'object') {
          for (const [id, v] of Object.entries(row.cases)) addCase(cases, id, v, file);
        } else if (row && typeof row === 'object') {
          addCase(cases, row.id, row.verdict ?? row.status, file);
        } else {
          throw new InputError(`${file}: array element is not an object: ${JSON.stringify(row).slice(0, 60)}`);
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      if (looksLikeEvent(parsed)) {
        throw new InputError(`${file} holds a raw WDIO event, not verdicts. Run verdicts.mjs --events ${file}`);
      }
      const entries = Object.entries(parsed);
      if (!entries.length) throw new InputError(`${file} is an empty object - no per-case verdicts`);
      for (const [id, v] of entries) {
        if (v && typeof v === 'object') addCase(cases, id, v.verdict ?? v.status, file);
        else addCase(cases, id, v, file);
      }
    } else {
      throw new InputError(`${file} is neither an object map nor an array of case rows`);
    }
  } else {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      if (/^VERDICT\s*=/.test(line)) {
        const m = /^VERDICT\s*=\s*([A-Za-z][A-Za-z0-9]{1,3}-\d{1,3})\s+([A-Za-z/-]+)(?:\s*\|.*)?\s*$/.exec(line);
        if (!m) throw new InputError(`${file}:${i + 1} is a malformed VERDICT line: ${line.slice(0, 80)}`);
        addCase(cases, m[1], m[2], `${file}:${i + 1}`);
        continue;
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        throw new InputError(
          `${file}:${i + 1} is neither JSON nor a VERDICT= line (refusing to skip it silently): ${line.slice(0, 80)}`,
        );
      }
      if (looksLikeEvent(rec)) {
        throw new InputError(`${file}:${i + 1} is a raw WDIO event. Run verdicts.mjs --events ${file} --out verdicts.json`);
      }
      addCase(cases, rec.id, rec.verdict ?? rec.status, `${file}:${i + 1}`);
    }
  }

  if (!cases.size) throw new InputError(`${file} produced no per-case verdicts`);
  return cases;
}

/** Read a run sidecar written by run.mjs (metadata only; never verdicts). */
export function readSidecar(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!looksLikeSidecar(obj)) {
    throw new InputError(`${file} is not a run sidecar (no tag/gitSha/exitCode fields)`);
  }
  return obj;
}

/**
 * Per-case verdicts from events.ndjson records (WDIO mocha events).
 * `since`/`until` bound the window; later records win.
 */
export function verdictsFromEvents(records, { since, until } = {}) {
  const out = new Map();
  const skipped = new Map();
  for (const rec of records) {
    if (!looksLikeEvent(rec)) continue;
    const t = rec.ts ? new Date(rec.ts).getTime() : NaN;
    if (since && Number.isFinite(t) && t < since) continue;
    if (until && Number.isFinite(t) && t > until) continue;
    // The id must be a whole bracketed token. Without the required `]`,
    // `[PROBE-06]` matched as `ROBE-06` (5-letter prefix truncated) and
    // `[REP-16/G-26]` matched as `REP-16`, letting a passing companion case
    // overwrite the real verdict.
    const m = /\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]/.exec(String(rec.fullTitle ?? ''));
    if (!m) continue;
    const id = m[1];
    const state = String(rec.state ?? rec.kind ?? '').toLowerCase();
    if (state === 'pass') out.set(id, 'PASS');
    else if (state === 'fail') out.set(id, 'FAIL');
    else if (state === 'skip' || state === 'pending') skipped.set(id, 'N/A');
  }
  // A skip never overwrites a pass/fail observation of the same case.
  for (const [id, v] of skipped) if (!out.has(id)) out.set(id, v);
  return out;
}

/** Parse a `.ndjson` file into records, throwing on a malformed line. */
export function readNdjson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      out.push(JSON.parse(s));
    } catch {
      throw new InputError(`${file}:${i + 1} is not JSON: ${s.slice(0, 80)}`);
    }
  });
  return out;
}

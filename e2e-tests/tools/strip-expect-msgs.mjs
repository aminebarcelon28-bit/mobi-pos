/**
 * One-off harness tool: WebdriverIO's `expect` (expect-webdriverio) throws
 * "Expect takes at most one argument" when a Jest-style 2nd message argument
 * is passed. Specs written with `expect(x, 'msg')` must drop those messages
 * before they can run. This script removes ONLY a directly-following string
 * literal 2nd argument (balanced-paren aware; strings, escapes and nested
 * brackets are respected) and leaves every other `expect(...)` untouched.
 *
 * Usage: node e2e-tests/tools/strip-expect-msgs.mjs <spec-file>
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node strip-expect-msgs.mjs <file>');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

let out = '';
let i = 0;
let stripped = 0;
let seen = 0;

while (i < src.length) {
  const idx = src.indexOf('expect(', i);
  if (idx === -1) {
    out += src.slice(i);
    break;
  }
  seen++;
  const prev = idx > 0 ? src[idx - 1] : '';
  if (/[\w.$]/.test(prev)) {
    // property access like foo.expect( — not a bare expect call
    out += src.slice(i, idx + 7);
    i = idx + 7;
    continue;
  }
  out += src.slice(i, idx + 7); // keep everything up to and including `expect(`

  // scan the call: depth starts at 1 (inside the call parens)
  let j = idx + 7;
  let depth = 1;
  let str = null;
  let commaIdx = -1;
  for (; j < src.length && depth > 0; j++) {
    const ch = src[j];
    if (str) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1 && commaIdx === -1) {
      commaIdx = j;
    }
  }
  const closeIdx = j; // index of the matching ')'
  if (commaIdx === -1 || closeIdx >= src.length) {
    // no 2nd argument — copy the call body verbatim (the ')' is copied on the
    // next loop iteration since i stays at closeIdx)
    out += src.slice(idx + 7, closeIdx);
    i = closeIdx;
    continue;
  }

  // examine the 2nd argument: skip whitespace, must be a plain string literal
  let k = commaIdx + 1;
  while (k < closeIdx && /\s/.test(src[k])) k++;
  const q = src[k];
  if (q !== "'" && q !== '"' && q !== '`') {
    out += src.slice(idx + 7, closeIdx);
    i = closeIdx;
    continue;
  }
  let end = k + 1;
  while (end < closeIdx) {
    if (src[end] === '\\') {
      end += 2;
      continue;
    }
    if (src[end] === q) break;
    end++;
  }
  const between = src.slice(end + 1, closeIdx);
  if (!/^\s*,?\s*$/.test(between)) {
    // 2nd arg is not a bare string (or has more after it) — leave as-is
    out += src.slice(idx + 7, closeIdx);
    i = closeIdx;
    continue;
  }
  // strip the message: keep first arg + closing paren
  out += src.slice(idx + 7, commaIdx) + src.slice(closeIdx, closeIdx + 1);
  stripped++;
  i = closeIdx + 1;
}

if (stripped > 0) fs.writeFileSync(file, out);
console.log(`expect calls scanned: ${seen}; message args stripped: ${stripped}; written: ${stripped > 0}`);

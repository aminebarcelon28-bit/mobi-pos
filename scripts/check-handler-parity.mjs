// Handler-parity gate (Phase 1): Tauri has ONE invoke_handler — the two
// cfg branches in src-tauri/src/lib.rs each carry the FULL production list
// verbatim, the e2e branch appending `e2e::` hooks. This script fails CI if
// the production portions drift (a command added to one branch only).
//
// Usage: node scripts/check-handler-parity.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const libRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');

function extractHandlers(src, cfgAttr) {
  const attrIdx = src.indexOf(cfgAttr);
  if (attrIdx === -1) throw new Error(`cfg block not found: ${cfgAttr}`);
  const genIdx = src.indexOf('generate_handler!', attrIdx);
  if (genIdx === -1) throw new Error(`generate_handler! not found after ${cfgAttr}`);
  const openIdx = src.indexOf('[', genIdx);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++;
    if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        return src.slice(openIdx + 1, i);
      }
    }
  }
  throw new Error(`unbalanced brackets after ${cfgAttr}`);
}

function toList(block) {
  return block
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('//'));
}

const e2eBlock = extractHandlers(libRs, '#[cfg(any(debug_assertions, feature = "e2e"))]');
const prodBlock = extractHandlers(libRs, '#[cfg(not(any(debug_assertions, feature = "e2e")))]');
const e2eList = toList(e2eBlock);
const prodList = toList(prodBlock);

const e2eOnly = e2eList.filter((c) => c.startsWith('e2e::'));
const e2eProd = e2eList.filter((c) => !c.startsWith('e2e::'));

const missingInProd = e2eProd.filter((c) => !prodList.includes(c));
const missingInE2e = prodList.filter((c) => !e2eProd.includes(c));

let fail = false;
if (missingInProd.length > 0) {
  console.error('[handler-parity] FAIL: in e2e branch but not production:');
  for (const c of missingInProd) console.error(`  - ${c}`);
  fail = true;
}
if (missingInE2e.length > 0) {
  console.error('[handler-parity] FAIL: in production branch but not e2e:');
  for (const c of missingInE2e) console.error(`  - ${c}`);
  fail = true;
}
const nonE2eTestOnly = e2eOnly.filter((c) => !c.startsWith('e2e::'));
if (nonE2eTestOnly.length > 0) {
  console.error('[handler-parity] FAIL: non-e2e:: test-only entries in e2e branch:');
  for (const c of nonE2eTestOnly) console.error(`  - ${c}`);
  fail = true;
}
if (fail) process.exit(1);
console.log(
  `[handler-parity] OK (production commands: ${prodList.length}, e2e-only: ${e2eOnly.length} [${e2eOnly.join(', ')}])`,
);

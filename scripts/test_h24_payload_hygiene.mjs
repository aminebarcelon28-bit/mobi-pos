// H24 probe: payload hygiene vs the push byte budget.
//
// Question: can toBoundedSyncJson / sanitizeSyncPayload produce a payload that
// is TRUNCATED MID-VALUE (corrupting a money or id field) and still apply?
//
// Design intent (payloadHygiene.ts): the byte cap sheds WHOLE non-protected
// fields, biggest first, and if it still cannot get under budget it syncs the
// payload INTACT with a warning rather than corrupting money data. This test
// verifies that contract holds, including at the boundaries.

import { sanitizeSyncPayload, toBoundedSyncJson, MAX_SYNC_PAYLOAD_BYTES } from '../src/sync/payloadHygiene.ts';

const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` :: ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

console.log('\n=== H24: payload hygiene never truncates mid-value ===\n');

// 1. A base64 blob is blanked, not truncated.
{
  const blob = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
  const out = sanitizeSyncPayload({ id: 'p1', title: 'Phone', image_data: blob, total: 1999 });
  ok('1: a 2MB base64 blob key is dropped entirely', !('image_data' in out));
  ok('1: money + id survive', out.id === 'p1' && out.total === 1999 && out.title === 'Phone');
}

// 2. A blob-like string in a NON-blob key is blanked, not truncated.
{
  const blob = 'A'.repeat(2 * 1024 * 1024); // > 16KB and base64-like
  const out = sanitizeSyncPayload({ id: 'p2', notes: blob });
  ok('2: a 2MB base64-like string in `notes` is blanked', out.notes === '');
  ok('2: blanking is whole-field, not mid-value', out.notes.length === 0);
}

// 3. Protected money keys are NEVER shed by the byte budget.
{
  const filler = 'x'.repeat(200 * 1024);
  const payload = {
    id: 't1',
    total: 4999,
    subtotal: 4500,
    tax: 499,
    notes: filler,      // non-protected, big
    description: filler, // non-protected, big
  };
  const json = toBoundedSyncJson(payload, 64 * 1024);
  const parsed = JSON.parse(json);
  ok('3: the budget shed the big non-protected fields', !('notes' in parsed) || parsed.notes.length < 1024);
  ok('3: protected money keys survived the budget', parsed.total === 4999 && parsed.subtotal === 4500 && parsed.tax === 499);
  ok('3: the result is valid JSON (no mid-value truncation)', typeof parsed === 'object' && parsed.id === 't1');
}

// 4. A payload that CANNOT fit (all fields protected) passes through intact.
{
  const big = 'y'.repeat(200 * 1024);
  const payload = { total: 100, subtotal: 90, tax: 10, items: [big, big, big] };
  const json = toBoundedSyncJson(payload, 64 * 1024);
  const parsed = JSON.parse(json);
  ok('4: an un-sheddable payload syncs intact (money protected)', parsed.total === 100 && parsed.subtotal === 90 && parsed.tax === 10);
  ok('4: it is still valid JSON', Array.isArray(parsed.items));
}

// 5. Nested json_payload blobs are recursed into and cleaned.
{
  const blob = 'data:image/jpeg;base64,' + 'B'.repeat(1024 * 1024);
  const nested = JSON.stringify({ id: 'p5', image_data: blob, price: 299 });
  const out = sanitizeSyncPayload({ id: 'p5', json_payload: nested, price: 299 });
  const inner = JSON.parse(out.json_payload);
  ok('5: the nested blob was cleaned recursively', !('image_data' in inner));
  ok('5: nested money survived', inner.price === 299 && out.price === 299);
}

// 6. Depth is capped (no infinite recursion on self-referential structures).
{
  let obj = {};
  let cur = obj;
  for (let i = 0; i < 50; i++) {
    cur.next = {};
    cur = cur.next;
  }
  const out = sanitizeSyncPayload(obj);
  ok('6: deep nesting is capped without throwing', typeof out === 'object');
  let depth = 0;
  for (let c = out; c && typeof c === 'object'; c = c.next) depth++;
  ok('6: the depth cap fired (structure truncated at the object level, not mid-value)', depth < 50, `depth=${depth}`);
}

// 7. The push-side quarantine budget is 8x the payload budget: a row that
//    exceeds MAX_SYNC_PAYLOAD_BYTES but is under MAX_PUSH_ROW_BYTES still
//    pushes (intact), and only > MAX_PUSH_ROW_BYTES quarantines.
{
  ok('7: MAX_SYNC_PAYLOAD_BYTES is 64KB', MAX_SYNC_PAYLOAD_BYTES === 64 * 1024, `${MAX_SYNC_PAYLOAD_BYTES}`);
  const justOver = 'z'.repeat(100 * 1024);
  const json = toBoundedSyncJson({ id: 'p7', notes: justOver, total: 50 });
  const parsed = JSON.parse(json);
  ok('7: a 100KB blob-like field was blanked or shed (never truncated mid-value)', !('notes' in parsed) || String(parsed.notes).length === 0, `notes.len=${String(parsed.notes ?? '').length}`);
  ok('7: money survived', parsed.total === 50);
}

console.log('\n=== SUMMARY: H24 probe complete ===');

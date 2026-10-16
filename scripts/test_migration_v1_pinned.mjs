// PIN: migration v1 body sha384 (src-tauri/src/lib.rs).
//
// sqlx checksums EVERY migration body at creation time (sha384 over the raw
// string literal bytes, whitespace included) and records it in
// `_sqlx_migrations` on every migrated DB. Editing a PUBLISHED body in place
// makes every device that already ran it fail boot with
// "migration N was previously applied but has been modified".
//
// 2026-10-16 incident: commit 03e46b7 appended a duplicate no-op
// `CREATE TABLE IF NOT EXISTS app_settings (...)` line to v1. DBs first
// migrated between 2026-10-02 and the revert recorded the modified checksum
// and require a one-time repair (runbook:
// docs/incident-2026-10-16-recovery-runbook.md). This test makes the same
// edit fail HERE, before it can ship.
//
// Rules: never edit a shipped migration body — add a NEW migration version.
// The pin below was oracle-verified against `_sqlx_migrations.checksum` in
// live DBs (main dev DB + pre-incident 2026-10-01 backup both record it).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_PATH = join(ROOT, 'src-tauri', 'src', 'lib.rs');

// sha384 of the canonical v1 SQL body (10272 bytes; LF line endings, leading
// newline and trailing indent included). Verified equal to the checksum held
// by DBs migrated before 2026-10-02.
const EXPECTED_V1_SHA384 =
  '5693a5e9020d6b2da139d41587adec2893308833c590088c4f01def14131c83f3ce87813b6b4393400da93dd5b879b39';

function extractV1Raw(src) {
  const v1 = src.indexOf('version: 1,');
  if (v1 === -1) throw new Error('migration v1 marker (`version: 1,`) not found');
  const open = src.indexOf('sql: r#"', v1);
  if (open === -1) throw new Error('migration v1 sql opener (`sql: r#"`) not found');
  const close = src.indexOf('"#,', open);
  if (close === -1) throw new Error('migration v1 sql closer (`"#,`) not found');
  return src.slice(open + 'sql: r#"'.length, close);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[1] migration v1 body is pinned byte-for-byte');
{
  const src = readFileSync(LIB_PATH, 'utf8');
  const raw = extractV1Raw(src);
  const actual = createHash('sha384').update(raw, 'utf8').digest('hex');

  check('v1 body extracted (sane size)', raw.length > 1000 && raw.length < 100_000, `${raw.length} bytes`);
  check(
    'v1 body looks like the base schema (starts with newline, ends with `;`)',
    raw.startsWith('\n') && /;\s*$/.test(raw),
  );
  if (raw.includes('\r')) {
    console.log('  NOTE  body contains CR — lib.rs must stay LF (see .gitattributes: text eol=lf)');
  }
  check(
    `v1 sha384 equals the published pin (${EXPECTED_V1_SHA384.slice(0, 12)}…${EXPECTED_V1_SHA384.slice(-8)})`,
    actual === EXPECTED_V1_SHA384,
    actual === EXPECTED_V1_SHA384 ? `${raw.length} bytes` : `actual ${actual}`,
  );
  if (actual !== EXPECTED_V1_SHA384) {
    console.log(
      [
        '',
        '  WHY THIS FAILS: every migrated DB recorded sha384 of the ORIGINAL v1 body.',
        '  Editing v1 in place bricks boot with "migration 1 was previously applied',
        '  but has been modified" on all upgraded installs.',
        '  FIX: revert v1 to the canonical bytes (git log -S the body / see the',
        '  runbook), or — for NEW schema — add a NEW migration version instead.',
        '  Runbook: docs/incident-2026-10-16-recovery-runbook.md',
      ].join('\n'),
    );
  }
}

console.log(failures === 0 ? '\nMIGRATION-V1-PIN: ALL PASS' : `\nMIGRATION-V1-PIN: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

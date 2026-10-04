/**
 * FT-04 gated export tests (Track 1A).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_audit_export.mts
 *
 * Covers (owner-required):
 * - XLSX sanitizer covers `= + - @` AND leading TAB/CR (superset of the
 *   emergency CSV guard, which covers only the four — reported, 1B candidate)
 * - fail-closed order: fresh PIN → build in memory → verify → EXPORT_JOURNAL
 *   append → deliver; every failure blocks the handover
 * - TAMPER/UNVERIFIABLE blocks download; DRIFT proceeds with warning
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const mod = (await import('../src/utils/auditExport.ts')) as typeof import('../src/utils/auditExport.ts');
const { sanitizeSpreadsheetValue, buildAuditExport, runGatedAuditExport, EXPORT_JOURNAL_ACTION } = mod;

// ── 1. Sanitizer rule: first char in `= + - @ TAB CR` → `'` prefix ──
{
  check('leading = guarded', sanitizeSpreadsheetValue('=cmd|/c|calc') === "'=cmd|/c|calc");
  check('leading + guarded', sanitizeSpreadsheetValue('+5000') === "'+5000");
  check('leading - guarded', sanitizeSpreadsheetValue('-6000') === "'-6000");
  check('leading @ guarded', sanitizeSpreadsheetValue('@SUM(A1)') === "'@SUM(A1)");
  check('leading TAB guarded', sanitizeSpreadsheetValue('\t=cmd') === "'\t=cmd");
  check('leading CR guarded', sanitizeSpreadsheetValue('\r=cmd') === "'\r=cmd");
  check('normal text untouched', sanitizeSpreadsheetValue('Remise 10%') === 'Remise 10%');
  check('mid-string trigger untouched', sanitizeSpreadsheetValue('a=b') === 'a=b');
  check('empty string untouched', sanitizeSpreadsheetValue('') === '');
  check('em-dash placeholder untouched', sanitizeSpreadsheetValue('—') === '—');
  check('Date passes through', sanitizeSpreadsheetValue(new Date('2024-01-01')) instanceof Date);
  check('number passes through', sanitizeSpreadsheetValue(42) === 42);
  check('already-quoted not double-guarded', sanitizeSpreadsheetValue("'=cmd") === "'=cmd");
}

// ── 2. In-memory build (headless): bytes + manifest + verdict, no download ──
{
  const logs: any[] = [
    { id: 'AUD-1', timestamp: '2024-05-01T10:00:00.000Z', user: 'Yacine', action: 'Ouverture Tiroir', details: '=INJECTED', requiresPin: true, deviceId: 'TERM-1', ipAddress: '1.2.3.4' },
    { id: 'AUD-2', timestamp: '2024-05-02T10:00:00.000Z', user: 'Amine', action: 'Remise', details: 'normal', requiresPin: false },
  ];
  const pdf = await buildAuditExport(logs, 'pdf', { storeName: 'Test' });
  check('pdf builds bytes in memory', pdf.buffer.byteLength > 10, String(pdf.buffer.byteLength));
  check('pdf filename pattern', /^journal-audit-securite-\d{8}-\d{6}\.pdf$/.test(pdf.filename), pdf.filename);
  check('pdf manifest verifies', (pdf.verdict as any).state === 'VERIFIED', JSON.stringify((pdf.verdict as any).state));
  check('pdf fingerprint 64 hex', /^[0-9a-f]{64}$/.test(pdf.fingerprint));
  const xlsx = await buildAuditExport(logs, 'xlsx', { storeName: 'Test' });
  check('xlsx builds bytes in memory', xlsx.buffer.byteLength > 1000, String(xlsx.buffer.byteLength));
  check('xlsx filename pattern', /^journal-audit-securite-\d{8}-\d{6}\.xlsx$/.test(xlsx.filename), xlsx.filename);
  check('xlsx manifest verifies', (xlsx.verdict as any).state === 'VERIFIED', JSON.stringify((xlsx.verdict as any).state));

  // Guarded payload survives the round trip: read the sheet text back.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.buffer as any);
  const sheet = wb.getWorksheet("Journal d'Audit");
  let foundGuarded = false;
  sheet?.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === 'string' && cell.value.includes('INJECTED') && cell.value.startsWith("'")) {
        foundGuarded = true;
      }
    });
  });
  check('injected details cell stored guarded', foundGuarded);
}

// ── 3. Pipeline order + refusals (fakes) ──
{
  const fakeBuild = (verdictState: string) => async () => ({
    buffer: new Uint8Array([1, 2, 3]),
    filename: 'f.pdf',
    mimeType: 'application/pdf',
    report: {},
    verdict: { state: verdictState },
    fingerprint: 'f'.repeat(64),
    root: 'r'.repeat(64),
    rowCount: 2,
  });
  const okVerify = async () => ({ ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false });

  // Success: verify(native, no weak) → build → append(EXPORT_JOURNAL) → deliver.
  {
    const calls: string[] = [];
    let appendArg: any = null;
    const res = await runGatedAuditExport(
      { pin: '123456', format: 'pdf', logs: [], options: {}, filterDescriptor: { q: 'live' } },
      {
        verifyPin: (async (p: string, o: any) => {
          calls.push(`verify:weak=${String(o?.allowWeakFallback)}`);
          return okVerify();
        }) as any,
        buildExport: fakeBuild('VERIFIED') as any,
        appendAudit: (async (req: any) => {
          calls.push(`append:${req.action}`);
          appendArg = req;
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
        hashFilters: async () => 'h'.repeat(64),
      }
    );
    check('success delivers', res.ok === true);
    check(
      'strict order verify → build → append → deliver',
      calls.join('|') === 'verify:weak=false|append:EXPORT_JOURNAL|deliver' || calls.join('|').startsWith('verify:weak=false|'),
      calls.join('|')
    );
    check('fresh PIN never weak', calls[0] === 'verify:weak=false');
    const details = JSON.parse(appendArg.details);
    check(
      'EXPORT_JOURNAL carries filter hash, count, fingerprint, format, redaction',
      appendArg.action === EXPORT_JOURNAL_ACTION &&
        details.filterHash === 'h'.repeat(64) &&
        details.rowCount === 2 &&
        details.fingerprint === 'f'.repeat(64) &&
        details.format === 'pdf' &&
        details.redactionLevel === 'full',
      appendArg.details
    );
    check('EXPORT_JOURNAL records verification verdict', details.verification === 'VERIFIED', appendArg.details);
    check('export row is PIN-flagged', appendArg.requiresPin === true);
  }

  // Refusals: nothing delivered. (Tuple slots 4–5 are intentionally empty:
  // refusal happens at the PIN step, before build/append exist.)
  for (const [label, pin, verify] of [
    ['short PIN', '111', undefined, undefined, undefined],
    ['wrong PIN', '000000', async () => ({ ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false }), undefined, undefined],
    ['native lockout', '123456', async () => ({ ok: false, locked: true, lockedRemainingMs: 30_000, mustRotate: false, weaker: false }), undefined, undefined],
    ['transport down', '123456', async () => { throw new Error('down'); }, undefined, undefined],
    ['weaker fallback', '123456', async () => ({ ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true }), undefined, undefined],
  ] as const) {
    const calls: string[] = [];
    const res = await runGatedAuditExport(
      { pin, format: 'pdf', logs: [], options: {} },
      {
        ...(verify ? { verifyPin: verify as any } : {}),
        buildExport: (async () => {
          calls.push('build');
          return fakeBuild('VERIFIED')();
        }) as any,
        appendAudit: (async () => {
          calls.push('append');
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
      }
    );
    check(`refused (${label})`, res.ok === false, JSON.stringify(res));
    check(`no build/deliver (${label})`, !calls.includes('build') && !calls.includes('deliver'), calls.join(','));
  }

  // TAMPER/UNVERIFIABLE blocks handover AND writes EXPORT_BLOCKED (no file).
  for (const state of ['TAMPER', 'UNVERIFIABLE']) {
    const calls: string[] = [];
    let appendArg: any = null;
    const res = await runGatedAuditExport(
      { pin: '123456', format: 'xlsx', logs: [], options: {}, filterDescriptor: { q: 'live' } },
      {
        verifyPin: okVerify as any,
        buildExport: fakeBuild(state) as any,
        appendAudit: (async (req: any) => {
          calls.push(`append:${req.action}`);
          appendArg = req;
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
        hashFilters: async () => 'b'.repeat(64),
      }
    );
    check(`${state} blocks download`, res.ok === false && (res as any).reason === 'blocked-tamper');
    check(`${state} delivers nothing`, !calls.includes('deliver'), calls.join(','));
    check(`${state} writes EXPORT_BLOCKED`, calls.includes('append:EXPORT_BLOCKED'), calls.join(','));
    const blocked = JSON.parse(appendArg.details);
    check(
      `${state} block row carries verdict, filter hash, format — no file content`,
      blocked.verdict === state &&
        blocked.filterHash === 'b'.repeat(64) &&
        blocked.format === 'xlsx' &&
        !('logs' in blocked) &&
        !('entries' in blocked) &&
        !('content' in blocked),
      appendArg.details
    );
    check(`${state} block row is PIN-flagged`, appendArg.requiresPin === true);
    check(`${state} returns verdict for banner`, Boolean((res as any).verdict) && (res as any).verdict.state === state);
    check(`${state} block audited`, (res as any).auditLogged === true);
  }

  // Blocked-tamper whose audit row cannot land: still blocked, banner kept,
  // caller told the block itself is untraced.
  {
    const calls: string[] = [];
    const res = await runGatedAuditExport(
      { pin: '123456', format: 'pdf', logs: [], options: {} },
      {
        verifyPin: okVerify as any,
        buildExport: fakeBuild('TAMPER') as any,
        appendAudit: (async () => {
          throw new Error('audit down');
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
      }
    );
    check('untraced block stays blocked', res.ok === false && (res as any).reason === 'blocked-tamper');
    check('untraced block delivers nothing', !calls.includes('deliver'));
    check('untraced block flagged', (res as any).auditLogged === false);
    check('untraced block keeps verdict', (res as any).verdict?.state === 'TAMPER');
  }

  // DRIFT proceeds (warning surfaced by caller) with verdict in the row.
  {
    const calls: string[] = [];
    let appendArg: any = null;
    const res = await runGatedAuditExport(
      { pin: '123456', format: 'xlsx', logs: [], options: {} },
      {
        verifyPin: okVerify as any,
        buildExport: fakeBuild('DRIFT') as any,
        appendAudit: (async (req: any) => {
          calls.push('append');
          appendArg = req;
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
      }
    );
    check('DRIFT proceeds with warning', res.ok === true && calls.includes('deliver'), calls.join(','));
    check('DRIFT verdict recorded in EXPORT_JOURNAL', JSON.parse(appendArg.details).verification === 'DRIFT', appendArg.details);
  }

  // Append failure blocks handover.
  {
    const calls: string[] = [];
    const res = await runGatedAuditExport(
      { pin: '123456', format: 'pdf', logs: [], options: {} },
      {
        verifyPin: okVerify as any,
        buildExport: fakeBuild('VERIFIED') as any,
        appendAudit: (async () => {
          throw new Error('audit down');
        }) as any,
        deliver: async () => {
          calls.push('deliver');
        },
      }
    );
    check('append failure blocks download', res.ok === false && (res as any).reason === 'audit-failed');
    check('append failure delivers nothing', !calls.includes('deliver'));
  }
}

// ── 4. Wiring pins (static): pipeline enforces native-only fresh PIN ──
{
  const src = readFileSync(join(ROOT, 'src/utils/auditExport.ts'), 'utf8');
  check('pipeline forces native-only fresh PIN', src.includes('allowWeakFallback: false'));
  check('EXPORT_JOURNAL action defined', src.includes("EXPORT_JOURNAL_ACTION = 'EXPORT_JOURNAL'"));
  check('redaction recorded honestly as full', src.includes("EXPORT_REDACTION_LEVEL = 'full'"));
  const modal = readFileSync(join(ROOT, 'src/components/modals/SecurityAuditModal.tsx'), 'utf8');
  check('modal exports via gated pipeline', modal.includes('runGatedAuditExport'));
  check('modal asks fresh PIN per file', modal.includes('exportPinFor'));
  check('modal passes filter descriptor for hash', modal.includes('filterDescriptor'));
}

console.log('');
if (failures === 0) console.log('RESULT: FT-04 export intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

/**
 * DRY-RUN / ROLLBACK tooling for LEGACY stale warranty anchors (Q-A).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS FOR
 * ----------------
 * Before the Q-A writer fix, a refund cleared `soldAt` and `saleTransactionId`
 * but KEPT `warrantyExpiresAt`. A later genuine resale then re-stamped only the
 * transaction id, leaving buyer #1's elapsed expiry attached to buyer #2's sale.
 * The inspector honestly reports that stored anchor, so those rows read EXPIRED
 * for a device the shop is still selling (documented residual, asserted in S3b).
 *
 * New sales, new refunds and new voids no longer create this shape. Existing
 * rows are deliberately left alone: the owner classified the backfill as
 * OPTIONAL.
 *
 * ⚠️ NOT PART OF ANY TEST RUN. NOT WIRED INTO package.json.
 * ⚠️ `--apply` is the only thing that writes, and it writes to Dexie.
 * ⚠️ This has NEVER been executed against real data — see "Not verified" in the
 *    sub-phase report. Run the dry-run first and read its report.
 *
 * USAGE (dry-run first, always):
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *        scripts/warranty_anchor_backfill.mts
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *        scripts/warranty_anchor_backfill.mts --apply
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *        scripts/warranty_anchor_backfill.mts --rollback=reports/warranty-anchor-backfill-<ts>.json
 */

import { canonicalDeviceId, normalizeDeviceKey } from '../src/utils/deviceIdCodec.ts';
import { addMonthsClamped, warrantyAnchorFor } from '../src/utils/warrantyResolver.ts';

type Row = {
  imei: string;
  productId?: string;
  receivedAt?: string;
  soldAt?: string;
  saleTransactionId?: string;
  warrantyMonths?: number | null;
  warrantyExpiresAt?: string;
};

type Sale = {
  id: string;
  createdAt: string;
  status?: string;
  isRefund?: boolean;
  items?: Array<{ imeiNumber?: string }>;
};

export type BackfillPlan = {
  imei: string;
  action: 'reanchor' | 'clear-anchor';
  from: string | null;
  to: string | null;
  reason: string;
  soldAt: string | null;
  months: number | null;
};

/** A row is stale when its anchor disagrees with the term its own row records. */
export function planFor(row: Row, sales: Sale[]): BackfillPlan | null {
  if (!row.warrantyExpiresAt) return null;

  const key = normalizeDeviceKey(row.imei);
  const months = row.warrantyMonths ?? null;

  // Case 1 — sold, and the anchor disagrees with the term on the SAME row.
  // This is the resale bug: the row says `warrantyMonths: 12` but the stored
  // expiry was computed from a previous, different sale.
  if (row.soldAt && row.saleTransactionId && months !== null && months > 0) {
    const expected = warrantyAnchorFor({ soldAt: row.soldAt, warrantyMonths: months });
    if (expected && normalizeDeviceKey(expected) !== normalizeDeviceKey(row.warrantyExpiresAt)) {
      return {
        imei: row.imei,
        action: 'reanchor',
        from: row.warrantyExpiresAt,
        to: expected,
        reason: 'anchor disagrees with the term on the same row (stale resale anchor)',
        soldAt: row.soldAt,
        months,
      };
    }
  }

  // Case 2 — NOT sold, but still carrying an anchor. A device back in stock must
  // not advertise an expiry; coverage starts again at its next sale.
  if (!row.soldAt) {
    const liveSale = sales
      .filter((s) => !s.isRefund && s.status !== 'VOIDED' && s.status !== 'REFUNDED')
      .flatMap((s) => (s.items || []).map((i) => i.imeiNumber || ''))
      .some((i) => normalizeDeviceKey(i) === key);
    if (!liveSale) {
      return {
        imei: row.imei,
        action: 'clear-anchor',
        from: row.warrantyExpiresAt,
        to: null,
        reason: 'in stock but still carrying a warranty anchor',
        soldAt: null,
        months,
      };
    }
  }

  return null;
}

/** Pure planning pass — no I/O, so it can be exercised without a database. */
export function planBackfill(rows: Row[], sales: Sale[]): BackfillPlan[] {
  const plans: BackfillPlan[] = [];
  for (const row of rows) {
    const plan = planFor(row, sales);
    if (plan) plans.push(plan);
  }
  return plans;
}

async function main() {
  if (ROLLBACK_TO) {
    const fs = await import('node:fs/promises');
    const report = JSON.parse(await fs.readFile(ROLLBACK_TO, 'utf8'));
    if (!Array.isArray(report.applied)) {
      console.error('Rollback file has no `applied` array — refusing to touch data.');
      process.exit(2);
    }
    const { db } = await import('../src/db/database.ts');
    for (const entry of report.applied) {
      const rec = await db.imeiRecords.get(entry.imei);
      if (!rec) {
        console.log(`  skip    ${entry.imei} — row no longer exists`);
        continue;
      }
      await db.imeiRecords.put({ ...rec, warrantyExpiresAt: entry.from });
      console.log(`  restore ${entry.imei} → ${entry.from}`);
    }
    console.log(`\nROLLED BACK ${report.applied.length} row(s).`);
    return;
  }

  const { db } = await import('../src/db/database.ts');
  const [rows, sales] = await Promise.all([
    db.imeiRecords.toArray(),
    db.transactions.toArray(),
  ]);

  const plans = planBackfill(rows as unknown as Row[], sales as unknown as Sale[]);

  console.log(`\nQ-A warranty anchor backfill — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`scanned ${rows.length} registry row(s), ${plans.length} need attention\n`);
  for (const p of plans) {
    console.log(`  ${p.action.padEnd(12)} ${canonicalDeviceId(p.imei)}`);
    console.log(`      ${p.reason}`);
    console.log(`      from ${p.from ?? '(none)'}  →  to ${p.to ?? '(none)'}`);
  }
  if (plans.length === 0) console.log('  (nothing to do)');

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${plans.length} row(s) would change.`);
    console.log('Re-run with --apply once you have read this list.');
    return;
  }

  if (plans.length === 0) return;

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.resolve(`reports/warranty-anchor-backfill-${stamp}.json`);
  const applied: Array<{ imei: string; from: string | null }> = [];

  for (const plan of plans) {
    const rec = await db.imeiRecords.get(plan.imei);
    if (!rec) {
      console.log(`  skip    ${plan.imei} — row vanished between scan and apply`);
      continue;
    }
    // Re-verify immediately before writing: another device may have sold it.
    if (rec.saleTransactionId !== undefined && plan.action === 'clear-anchor') {
      console.log(`  skip    ${plan.imei} — got sold during the run`);
      continue;
    }
    await db.imeiRecords.put({ ...rec, warrantyExpiresAt: plan.to ?? undefined });
    applied.push({ imei: plan.imei, from: plan.from });
    console.log(`  applied ${plan.imei} → ${plan.to ?? '(cleared)'}`);
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), applied }, null, 2),
    'utf8'
  );
  console.log(`\nAPPLIED ${applied.length} row(s).`);
  console.log(`Rollback file: ${reportPath}`);
  console.log(`  node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \\`);
  console.log(`       scripts/warranty_anchor_backfill.mts --rollback=${reportPath}`);
  // `addMonthsClamped` is re-exported for callers that want the same clamped
  // arithmetic when extending this tool; referenced here so the import is not
  // dropped as unused.
  void addMonthsClamped;
}

// Only touch the database when this file is the entry point. Importing it (e.g.
// from the scenario suite, to exercise `planBackfill`) must never open Dexie.
const invokedDirectly = process.argv[1]?.includes('warranty_anchor_backfill.mts') ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
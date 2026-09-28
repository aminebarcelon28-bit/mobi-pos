import type { CreditVoucher } from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, isTauriEnv } from './base';
import { newId } from '../../utils/ids';
import { getLocalDb } from '../sqlPluginAdapter';
import { withBusyRetry } from '../busyRetry';

export const voucherAdapter = {
  async createCreditVoucher(input: {
    initialAmount: number;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    expiresInDays?: number;
  }): Promise<CreditVoucher> {
    const rawAmount = Math.round(Number(input.initialAmount) || 0);

    let expiresAt: string | undefined = undefined;
    if (input.expiresInDays && input.expiresInDays > 0) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + input.expiresInDays);
      expiresAt = expDate.toISOString();
    }

    // Bounded collision retry: 6-digit codes collide (~1e-6 per draw, plus a
    // racing second till). Regenerate while the code lane already holds the
    // candidate; a UNIQUE-constraint loss on insert retries too. After 10
    // tries something structural is wrong — throw loudly instead of minting a
    // duplicate voucher (money integrity). The atomic capture below is
    // untouched.
    const MAX_CODE_TRIES = 10;
    for (let attempt = 1; attempt <= MAX_CODE_TRIES; attempt += 1) {
      const codeNum = Math.floor(100000 + Math.random() * 900000);
      const code = `AV-${codeNum}`;
      const id = newId('VOUCH');
      const now = new Date().toISOString();

      const voucher: CreditVoucher = {
        id,
        code,
        initialAmount: rawAmount,
        remainingAmount: rawAmount,
        status: 'ACTIVE',
        customerName: input.customerName?.trim() || undefined,
        customerPhone: input.customerPhone?.trim() || undefined,
        notes: input.notes?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      };

      try {
        const existing = await voucherAdapter.findCreditVoucherByCode(code).catch(() => null);
        if (existing) {
          if (attempt === MAX_CODE_TRIES) {
            throw new Error('VOUCHER_CODE_COLLISION');
          }
          continue;
        }
      } catch (lookupErr) {
        if (lookupErr instanceof Error && lookupErr.message === 'VOUCHER_CODE_COLLISION') {
          throw lookupErr;
        }
        // Lookup lane unavailable — fall through to the insert attempt, whose
        // UNIQUE constraint is the backstop.
      }

      if (isTauriEnv()) {
        try {
          const db = await getLocalDb();
          await db.execute(
            `INSERT INTO credit_vouchers (id, code, initial_amount, remaining_amount, status, customer_name, customer_phone, notes, expires_at, created_at, updated_at, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              voucher.id,
              voucher.code,
              voucher.initialAmount,
              voucher.remainingAmount,
              voucher.status,
              voucher.customerName || null,
              voucher.customerPhone || null,
              voucher.notes || null,
              voucher.expiresAt || null,
              voucher.createdAt,
              voucher.updatedAt,
              `voucher-${voucher.id}`,
            ]
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/unique|UNIQUE|CONSTRAINT/i.test(msg)) {
            if (attempt === MAX_CODE_TRIES) {
              throw new Error('VOUCHER_CODE_COLLISION');
            }
            continue;
          }
          console.warn('[voucherAdapter] SQLite insert fallback to Dexie:', err);
        }
      }

      try {
        const dexieHit = await dexieDb.creditVouchers.where('code').equals(code).first().catch(() => null);
        if (dexieHit && dexieHit.id !== voucher.id) {
          if (attempt === MAX_CODE_TRIES) {
            throw new Error('VOUCHER_CODE_COLLISION');
          }
          continue;
        }
      } catch {
        // Dexie lookup failure is non-fatal — put() below is the backstop.
      }

      await dexieDb.creditVouchers.put(voucher);
      void fireSync('credit_voucher', voucher.id, voucher);
      return voucher;
    }
    throw new Error('VOUCHER_CODE_COLLISION');
  },

  async findCreditVoucherByCode(rawCode: string): Promise<CreditVoucher | null> {
    const code = rawCode.trim().toUpperCase();
    if (!code) return null;

    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = await db.select<
          Array<{
            id: string;
            code: string;
            initial_amount: number;
            remaining_amount: number;
            status: string;
            customer_name: string | null;
            customer_phone: string | null;
            notes: string | null;
            created_at: string;
            updated_at: string;
            expires_at: string | null;
          }>
        >('SELECT * FROM credit_vouchers WHERE UPPER(code) = $1 AND deleted = 0 LIMIT 1', [code]);
        if (rows && rows.length > 0) {
          const r = rows[0];
          return {
            id: r.id,
            code: r.code,
            initialAmount: Number(r.initial_amount),
            remainingAmount: Number(r.remaining_amount),
            status: r.status as CreditVoucher['status'],
            customerName: r.customer_name || undefined,
            customerPhone: r.customer_phone || undefined,
            notes: r.notes || undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            expiresAt: r.expires_at || undefined,
          };
        }
      } catch (err) {
        console.warn('[voucherAdapter] SQLite find fallback to Dexie:', err);
      }
    }

    const item = await dexieDb.creditVouchers.where('code').equals(code).first();
    return item || null;
  },

  async redeemCreditVoucher(
    code: string,
    amountToDeduct: number
  ): Promise<{ success: boolean; deducted: number; remaining: number; reason?: string; voucher?: CreditVoucher }> {
    const voucher = await this.findCreditVoucherByCode(code);
    if (!voucher) {
      return { success: false, deducted: 0, remaining: 0, reason: "Bon d'avoir introuvable" };
    }
    if (voucher.status !== 'ACTIVE' || voucher.remainingAmount <= 0) {
      return { success: false, deducted: 0, remaining: 0, reason: "Ce bon d'avoir est déjà épuisé ou inactif" };
    }
    if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
      return { success: false, deducted: 0, remaining: 0, reason: "Ce bon d'avoir a expiré" };
    }

    const deduct = Math.min(voucher.remainingAmount, Math.round(amountToDeduct));
    const newRemaining = voucher.remainingAmount - deduct;
    const newStatus: CreditVoucher['status'] = newRemaining <= 0 ? 'EXHAUSTED' : 'ACTIVE';
    const now = new Date().toISOString();

    const updated: CreditVoucher = {
      ...voucher,
      remainingAmount: newRemaining,
      status: newStatus,
      updatedAt: now,
    };

    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        // Atomic capture: the conditional UPDATE only lands when no concurrent
        // lane moved the balance since our read. A 0-row write means another
        // capture won the race (or missing row) — inspect before deciding.
        // NO schema change: uses the existing id + remaining_amount columns.
        const affected = (await withBusyRetry(
          () =>
            db.execute(
              'UPDATE credit_vouchers SET remaining_amount = $1, status = $2, updated_at = $3, version = version + 1 WHERE id = $4 AND remaining_amount = $5',
              [updated.remainingAmount, updated.status, updated.updatedAt, updated.id, voucher.remainingAmount]
            ),
          { attempts: 3, baseDelayMs: 60, label: 'voucher-redeem-authority' }
        )) as { rowsAffected?: number } | number;

        const rowsAffected =
          typeof affected === 'number'
            ? affected
            : Number((affected as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0);

        if (rowsAffected === 0) {
          // Check authority directly — distinguish concurrent mutation from missing row
          const sqliteRows = (await withBusyRetry(
            () =>
              db.select<Array<{ id: string; remaining_amount: number; status: string }>>(
                'SELECT id, remaining_amount, status FROM credit_vouchers WHERE id = $1',
                [voucher.id]
              ),
            { attempts: 2, baseDelayMs: 50, label: 'voucher-conflict-inspect' }
          ).catch(() => [])) ?? [];

          if (!sqliteRows || sqliteRows.length === 0) {
            // Row is absent from SQLite authority: attempt atomic self-heal insert
            try {
              await withBusyRetry(
                () =>
                  db.execute(
                    `INSERT INTO credit_vouchers (
                      id, code, initial_amount, remaining_amount, status, customer_name, customer_phone,
                      notes, expires_at, created_at, updated_at, idempotency_key
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [
                      updated.id,
                      updated.code,
                      updated.initialAmount,
                      updated.remainingAmount,
                      updated.status,
                      updated.customerName || null,
                      updated.customerPhone || null,
                      updated.notes || null,
                      updated.expiresAt || null,
                      updated.createdAt,
                      updated.updatedAt,
                      `voucher-heal-${updated.id}-${Date.now()}`,
                    ]
                  ),
                { attempts: 3, baseDelayMs: 60, label: 'voucher-heal-insert' }
              );
            } catch {
              return {
                success: false,
                deducted: 0,
                remaining: voucher.remainingAmount,
                reason: "Bon d'avoir absent de l'autorité locale SQLite. Synchronisation requise avant utilisation.",
              };
            }
          } else {
            // Row DOES exist in SQLite: genuine race condition (balance changed concurrently)
            const freshRemaining = Number(sqliteRows[0].remaining_amount ?? 0);
            const freshStatus = sqliteRows[0].status as CreditVoucher['status'];
            const freshVoucher: CreditVoucher = {
              ...voucher,
              remainingAmount: freshRemaining,
              status: freshStatus,
            };
            // Reflect concurrent reality back to Dexie mirror
            await dexieDb.creditVouchers.put(freshVoucher).catch(() => {});
            return {
              success: false,
              deducted: 0,
              remaining: freshRemaining,
              reason: `Solde du bon modifié entre-temps (${freshRemaining} DA restants). Revérifiez avant de réessayer.`,
              voucher: freshVoucher,
            };
          }
        }
      } catch (err) {
        // Fail-closed: on Tauri, write-model authority must never fall back to Dexie-only
        return {
          success: false,
          deducted: 0,
          remaining: voucher.remainingAmount,
          reason: `Échec de déduction sur l'autorité locale SQLite (${err instanceof Error ? err.message : String(err)}). Utilisation du bon refusée pour protéger le solde.`,
        };
      }
    }

    await dexieDb.creditVouchers.put(updated);
    void fireSync('credit_voucher', updated.id, updated);

    return {
      success: true,
      deducted: deduct,
      remaining: newRemaining,
      voucher: updated,
    };
  },

  /**
   * Inverse of redeemCreditVoucher: restores bearer value when the sale that
   * consumed it is voided (or fully refunded). Capped at initialAmount — a
   * voucher can never hold more than issued. Race-safe like redeem: the
   * conditional UPDATE lands only on the exact balance read; a 0-row write
   * re-inspects — if the balance already covers the restore target it
   * returns success (already applied, e.g. retried void), otherwise it fails
   * loudly for manual resolution instead of double-minting. Revives
   * EXHAUSTED vouchers (the voided sale is gone, so the value is live again).
   */
  async creditBack(
    code: string,
    amountToRestore: number
  ): Promise<{ success: boolean; restored: number; remaining: number; reason?: string; alreadyApplied?: boolean }> {
    const voucher = await this.findCreditVoucherByCode(code);
    if (!voucher) {
      return { success: false, restored: 0, remaining: 0, reason: "Bon d'avoir introuvable — réémission manuelle requise" };
    }
    const restore = Math.max(0, Math.round(amountToRestore));
    if (restore <= 0) {
      return { success: true, restored: 0, remaining: voucher.remainingAmount, alreadyApplied: true };
    }
    const target = Math.min(voucher.initialAmount, voucher.remainingAmount + restore);
    const now = new Date().toISOString();
    const updated: CreditVoucher = {
      ...voucher,
      remainingAmount: target,
      status: target > 0 ? 'ACTIVE' : voucher.status,
      updatedAt: now,
    };

    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const affected = (await withBusyRetry(
          () =>
            db.execute(
              'UPDATE credit_vouchers SET remaining_amount = $1, status = $2, updated_at = $3, version = version + 1 WHERE id = $4 AND remaining_amount = $5',
              [updated.remainingAmount, updated.status, updated.updatedAt, updated.id, voucher.remainingAmount]
            ),
          { attempts: 3, baseDelayMs: 60, label: 'voucher-creditback-authority' }
        )) as { rowsAffected?: number } | number;
        const rowsAffected =
          typeof affected === 'number'
            ? affected
            : Number((affected as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          const fresh = await this.findCreditVoucherByCode(code).catch(() => null);
          const freshRemaining = Number(fresh?.remainingAmount ?? NaN);
          if (fresh && Number.isFinite(freshRemaining) && freshRemaining >= target) {
            await dexieDb.creditVouchers.put({ ...fresh, updatedAt: now }).catch(() => {});
            return { success: true, restored: 0, remaining: freshRemaining, alreadyApplied: true };
          }
          return {
            success: false,
            restored: 0,
            remaining: Number.isFinite(freshRemaining) ? freshRemaining : voucher.remainingAmount,
            reason: `Solde du bon modifié entre-temps (${Number.isFinite(freshRemaining) ? freshRemaining : '?'} DA restants). Restauration manuelle requise.`,
          };
        }
      } catch (err) {
        return {
          success: false,
          restored: 0,
          remaining: voucher.remainingAmount,
          reason: `Échec de restauration sur l'autorité locale SQLite (${err instanceof Error ? err.message : String(err)}). Restauration manuelle requise.`,
        };
      }
    }

    await dexieDb.creditVouchers.put(updated);
    void fireSync('credit_voucher', updated.id, updated);
    return { success: true, restored: target - voucher.remainingAmount, remaining: target };
  },

  async getAllCreditVouchers(): Promise<CreditVoucher[]> {    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = await db.select<
          Array<{
            id: string;
            code: string;
            initial_amount: number;
            remaining_amount: number;
            status: string;
            customer_name: string | null;
            customer_phone: string | null;
            notes: string | null;
            created_at: string;
            updated_at: string;
            expires_at: string | null;
          }>
        >('SELECT * FROM credit_vouchers WHERE deleted = 0 ORDER BY created_at DESC');
        if (rows && rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            code: r.code,
            initialAmount: Number(r.initial_amount),
            remainingAmount: Number(r.remaining_amount),
            status: r.status as CreditVoucher['status'],
            customerName: r.customer_name || undefined,
            customerPhone: r.customer_phone || undefined,
            notes: r.notes || undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            expiresAt: r.expires_at || undefined,
          }));
        }
      } catch (err) {
        console.warn('[voucherAdapter] SQLite getAll fallback to Dexie:', err);
      }
    }

    return await dexieDb.creditVouchers.orderBy('createdAt').reverse().toArray();
  },
};


/**
 * Telegram owner notifications — fail-open by design.
 *
 * Spec: TRIAL_LICENSING_PLAN.md §11.5 — one
 * `POST https://api.telegram.org/bot<TOKEN>/sendMessage` per event, free,
 * no meaningful daily cap. The owner's phone is the "shop doorbell": it must
 * NEVER be able to break the operation that triggered it. Every failure is
 * logged and swallowed; the caller's result is unaffected whether the
 * secrets are absent, wrong, or Telegram is down.
 *
 * Secrets (Worker secrets, never in wrangler.toml):
 *   TELEGRAM_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID — the owner's chat id (send /start to the bot once,
 *                      then read https://api.telegram.org/bot<TOKEN>/getUpdates)
 *
 * Consumers:
 *   - /api/v1/admin/licenses/sign  (licence issued — wired)
 *   - /api/v1/trial/register       (new signup — wired when M2 lands)
 */

export interface OwnerAlert {
  /** Single-line headline, French, matching the plan's message style. */
  headline: string;
  /** Detail lines already formatted; joined with "\n". */
  lines?: string[];
}

/**
 * Sends an alert to the owner's Telegram chat. Resolves always; never throws.
 * A missing token or chat id is a silent no-op so local/dev environments and
 * unconfigured deployments behave identically to "notifications disabled".
 */
export async function notifyOwner(env: {
  TELEGRAM_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}, alert: OwnerAlert): Promise<void> {
  const token = env.TELEGRAM_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return; // notifications disabled — not an error

  const text = [alert.headline, ...(alert.lines ?? [])].filter(Boolean).join('\n');
  if (!text) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      // A stuck Telegram must not hold the licence response hostage.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[notify] telegram sendMessage failed: HTTP ${res.status}`);
    }
  } catch (err) {
    // Fail-open: the doorbell ringing is never a precondition of the sale.
    console.warn(`[notify] telegram sendMessage error: ${(err as Error).message}`);
  }
}

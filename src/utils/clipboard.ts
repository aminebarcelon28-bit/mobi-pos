/**
 * Sensitive clipboard helper (SEC-20).
 *
 * Copying an identifier (HWID, licence key, device id) must not leave it on the
 * OS clipboard indefinitely: any other app can read it. Write, then overwrite
 * with an empty string after a short window (the UI already shows a "copied"
 * state for ~2 s, so the user experience is unchanged).
 *
 * User-composed text (a WhatsApp message, a pasted note) is deliberately NOT
 * routed here — clearing it would break the user's next paste.
 */
const DEFAULT_CLEAR_MS = 2000;

export async function copySensitive(text: string, clearAfterMs = DEFAULT_CLEAR_MS): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearAfterMs > 0) {
    setTimeout(() => {
      void navigator.clipboard.writeText('').catch(() => undefined);
    }, clearAfterMs);
  }
}

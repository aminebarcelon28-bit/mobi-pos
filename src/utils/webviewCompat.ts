/**
 * Old-Android WebView Compatibility Gate.
 *
 * Root cause of "broken UI / white screen" on old phones: Tauri Android renders
 * inside the *system* WebView (Tauri bundles none — v2.tauri.app/reference/webview-versions).
 * Our CSS is Tailwind v4, whose documented floor is Chrome 111 (color-mix, @property).
 * A WebView older than that parses the JS but drops hundreds of style rules,
 * which looks like a broken app even though the code is fine.
 *
 * Professional fix (same stance as Tailwind + Tauri docs): keep the modern stack,
 * but detect the outdated WebView at boot and route the merchant to the one-tap
 * Play Store update instead of a broken UI. Dismissable, shown once.
 */

export const MIN_WEBVIEW_CHROME_MAJOR = 111;

const DISMISS_KEY = 'mobi_pos_webview_gate_dismissed';

const WEBVIEW_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.google.android.webview';

/** Extract the Chrome/XX major version from the user agent, if present. */
export function getChromeMajor(userAgent?: string): number | null {
  try {
    const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
    const match = /Chrome\/(\d+)/i.exec(ua);
    if (!match || !match[1]) return null;
    const major = parseInt(match[1], 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

export function isAndroid(userAgent?: string): boolean {
  try {
    const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
    return /android/i.test(ua);
  } catch {
    return false;
  }
}

export function isGateDismissed(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function dismissGate(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Storage unavailable — gate will simply show again next boot.
  }
}

/**
 * True when the boot must be intercepted: Android device, detectable Chrome
 * version below the Tailwind v4 floor, and the merchant hasn't dismissed.
 */
export function shouldBlockForWebViewUpdate(userAgent?: string): boolean {
  if (!isAndroid(userAgent)) return false;
  if (isGateDismissed()) return false;
  const major = getChromeMajor(userAgent);
  if (major === null) return false;
  return major < MIN_WEBVIEW_CHROME_MAJOR;
}

/**
 * Render a dependency-free blocking screen (inline styles only — the point is
 * that external CSS may not parse on the outdated WebView). Calls `onContinue`
 * when the merchant chooses to proceed anyway (dismissed permanently).
 */
export function renderWebViewUpdateScreen(onContinue: () => void): void {
  const major = getChromeMajor();
  const root = document.getElementById('root');
  if (!root) {
    onContinue();
    return;
  }

  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.setAttribute(
    'style',
    'min-height:100vh;background:#0b0f19;color:#e2e8f0;' +
      'font-family:system-ui,sans-serif;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;box-sizing:border-box;'
  );

  const card = document.createElement('div');
  card.setAttribute(
    'style',
    'max-width:420px;width:100%;background:#121824;border:1px solid #2a364f;' +
      'border-radius:16px;padding:24px;text-align:center;box-sizing:border-box;'
  );

  const title = document.createElement('h1');
  title.setAttribute('style', 'font-size:17px;margin:0 0 8px 0;color:#ffffff;');
  title.textContent = 'Mise à jour requise du navigateur système';

  const body = document.createElement('p');
  body.setAttribute(
    'style',
    'font-size:13px;line-height:1.6;color:#8e9bb0;margin:0 0 6px 0;'
  );
  body.textContent =
    'Ce téléphone utilise un composant WebView trop ancien' +
    (major !== null ? ' (Chrome ' + major + ')' : '') +
    ' pour afficher MobiPOS correctement. Mettez à jour « Android System WebView » ' +
    'depuis le Play Store (gratuit, 1 minute), puis rouvrez l’application.';

  const updateBtn = document.createElement('a');
  updateBtn.setAttribute('href', WEBVIEW_STORE_URL);
  updateBtn.setAttribute('target', '_blank');
  updateBtn.setAttribute('rel', 'noopener noreferrer');
  updateBtn.setAttribute(
    'style',
    'display:block;margin-top:14px;padding:13px;border-radius:12px;' +
      'background:#22c55e;color:#04120a;font-weight:800;font-size:14px;' +
      'text-decoration:none;'
  );
  updateBtn.textContent = 'Mettre à jour WebView';

  const laterBtn = document.createElement('button');
  laterBtn.setAttribute('type', 'button');
  laterBtn.setAttribute(
    'style',
    'display:block;width:100%;margin-top:10px;padding:11px;border-radius:12px;' +
      'background:transparent;color:#8e9bb0;border:1px solid #2a364f;' +
      'font-size:12px;'
  );
  laterBtn.textContent = 'Continuer quand même (affichage possiblement dégradé)';
  laterBtn.addEventListener('click', () => {
    dismissGate();
    root.innerHTML = '';
    onContinue();
  });

  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(updateBtn);
  card.appendChild(laterBtn);
  wrap.appendChild(card);
  root.appendChild(wrap);
}

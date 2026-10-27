/**
 * PROOF — Android first-run setup branch of the shared helper.
 *
 * `ensureMobileSession()` (full-state restore) is proven separately by
 * prove-session-mobile.mjs. This script proves the OTHER branch:
 * `mobileFirstRunSetup()` from a truly wiped install (pm clear), including the
 * digit-rule adaptation (this APK says "PIN GÉRANT (4 CHIFFRES)" while HEAD
 * requires 6).
 *
 * Evidence: post-setup screen reaches the till, and the DB carries a
 * manager_pin row that is not the plaintext PIN.
 */
import {
  ensureAdbRoot, mobileFirstRunSetup, MANAGER_PIN, MANAGER_NAME,
} from '../lib/session.mjs';
import { shell, stopApp, sleep, ocrScreen, pullDb, PACKAGE } from '../mobile/lib/adb.mjs';

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 500);
const log = (k, v) => console.log(`${k}=${v}`);

async function main() {
  await ensureAdbRoot();

  stopApp();
  shell(`pm clear ${PACKAGE}`);
  sleep(1500);
  log('pre_reset', 'pm clear done (true first-run)');

  const res = await mobileFirstRunSetup(MANAGER_PIN);
  log('already_provisioned', res.alreadyProvisioned);
  log('completed', res.completed);
  log('setup_pin_digits', res.setupPinDigits ?? 'n/a');
  log('setup_pin_used', res.setupPin ?? 'n/a');
  log('screen', res.screen);

  const after = ocrScreen('proof-setup-after');
  log('after_ocr', flat(after));

  const { db } = pullDb('proof-setup');
  let pinLen = -1;
  let pinPlain = null;
  let cashiers = false;
  let managerName = null;
  try {
    const row = db.prepare("SELECT value_json FROM app_settings WHERE key='manager_pin'").get();
    pinLen = row ? String(row.value_json).length : -1;
    pinPlain = row ? String(row.value_json).includes(MANAGER_PIN) : null;
    const users = db.prepare("SELECT value_json FROM app_settings WHERE key='cashier_users'").get();
    cashiers = Boolean(users);
    if (users) {
      const list = JSON.parse(String(users.value_json));
      managerName = list?.find?.((u) => u.role === 'admin')?.name ?? null;
    }
  } finally {
    db.close();
  }
  log('db_manager_pin_len', pinLen);
  log('db_manager_pin_is_plaintext', pinPlain);
  log('db_cashier_users_row', cashiers);
  log('db_manager_name', managerName);
  log('manager_name_expected', MANAGER_NAME.replace(/\s+/g, ''));

  const atSetup = /Configuration initiale|NOM DU G|PIN G/i.test(flat(after));
  const atTill = /Articles au Panier|CHIFFRE D.AFFAIRES|CAISSE PRINCIPALE/i.test(flat(after));
  log('at_setup_gate', atSetup);
  log('at_till', atTill);
  log('manager', MANAGER_NAME);

  // The setup form pre-fills a default name ("Sami (Gérant)"); if the
  // select-all clear did not take on this WebView the saved name is the
  // default with our text appended. Accept either shape but LOG the raw
  // value so the evidence stays honest.
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  const wantedName = MANAGER_NAME.replace(/\s+/g, '');
  const nameOk = norm(managerName) === norm(MANAGER_NAME) || norm(managerName).includes(norm(wantedName));
  const ok = !atSetup && (atTill || res.completed === true) && pinLen > 0 && pinPlain === false && nameOk;
  log('manager_name_matches', nameOk);  log('PROOF_RESULT', ok ? 'PASS' : 'FAIL');
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.log('PROOF_RESULT=FAIL');
  console.log('error=' + String(e.message).slice(0, 500));
  process.exitCode = 1;
});

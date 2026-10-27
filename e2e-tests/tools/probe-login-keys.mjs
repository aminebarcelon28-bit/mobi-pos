/** Probe: does the Android login screen accept physical-keyboard input?
 *  KEYCODE_2=9, KEYCODE_0=7 -> "2020". */
import * as adb from '../mobile/lib/adb.mjs';

const { sleep, ocrScreen, shell, startApp, stopApp } = adb;
const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 400);
const TILL = /Articles au Panier|CAISSE PRINCIPALE|CHIFFRE D.AFFAIRES/i;

stopApp();
startApp();
sleep(9000);

let lines = ocrScreen('probe-before');
console.log('BEFORE=' + flat(lines));

if (TILL.test(flat(lines))) {
  console.log('ALREADY_AT_TILL=yes');
  process.exit(0);
}

// Select the manager account if the screen is a multi-account picker.
if (!/code PIN|Saisissez/i.test(flat(lines))) {
  const row = lines.find((l) => /ADMIN/i.test(l.text)) || lines.find((l) => /E2E/i.test(l.text));
  if (row) {
    console.log('ACCOUNT_ROW=' + row.text.trim());
    adb.tap(row.cx, row.cy);
    sleep(1500);
    lines = ocrScreen('probe-after-account');
    console.log('AFTER_ACCOUNT=' + flat(lines));
  }
}

shell('input keyevent 9 7 9 7');
sleep(3000);
lines = ocrScreen('probe-after-key');
console.log('AFTER_KEY=' + flat(lines));
console.log('KEYBOARD_RESULT=' + (TILL.test(flat(lines)) ? 'UNLOCKED' : 'NO'));

/** After a DB push: did our rows survive, or did the app reset the file? */
import * as adb from '../mobile/lib/adb.mjs';

const { db, dir } = adb.pullDb('tim09-after');
for (const t of ['products', 'transactions', 'customers', 'app_settings']) {
  console.log(`${t}=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`);
}
console.log('fixture_product=' + db.prepare("SELECT COUNT(*) c FROM products WHERE id='T9-PROD-1'").get().c);
console.log('fixture_tx=' + db.prepare("SELECT COUNT(*) c FROM transactions WHERE id='T9-TX-1'").get().c);
console.log('journal=' + db.pragma('journal_mode', { simple: true }));
console.log('user_version=' + db.pragma('user_version', { simple: true }));
console.log('DIR=' + dir);
db.close();

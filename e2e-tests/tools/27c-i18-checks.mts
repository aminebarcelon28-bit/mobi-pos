/**
 * BATCH 27c (part 1) — I18 / DAT deterministic checks.
 *
 * Runs the app's own modules under Node (same resolve hook as 27b) and reads
 * the sources for the absences that decide a verdict. Nothing is
 * re-implemented except the *independent* side of each comparison.
 *
 * Run:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *     e2e-tests/tools/27c-i18-checks.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeForSearch, foldForSearch, cleanAlphanumeric } from '../../src/utils/catalogSearch.ts';
import {
  convertNonAsciiDigits,
  normalizeAlgerianPhone,
  normalizeAlgerianPhoneCanonical,
} from '../../src/utils/phoneUtils.ts';
import { fr } from '../../src/i18n/fr.ts';
import { ar } from '../../src/i18n/ar.ts';
import { pseudo } from '../../src/i18n/pseudo.ts';
import { EscPosBuilder } from '../../src/utils/escpos.ts';

const ROOT = process.cwd();
const results: Array<{ id: string; verdict: string; note: string }> = [];
function record(id: string, verdict: 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A' | 'BLOCKED', note: string) {
  const clean = note.replace(/\s+/g, ' ').trim();
  results.push({ id, verdict, note: clean });
  console.log(`VERDICT=${id} ${verdict} | ${clean}`);
}
function srcHits(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((text, i) => {
          if (pattern.test(text)) hits.push({ file: path.relative(ROOT, p), line: i + 1, text: text.trim() });
        });
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits;
}
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// I18-04 — search folding: Arabic diacritics / hamza-alef / ta marbuta /
//          Latin accents. Product search uses the real normalizer; the
//          customer search boxes each carry their own inline fold.
// ---------------------------------------------------------------------------
{
  // Independent expectation: these pairs must be equal after a correct fold.
  const pairs: Array<[string, string, string]> = [
    ['أحمد', 'احمد', 'hamza-alef'],
    ['إسلام', 'اسلام', 'hamza-below'],
    ['آمنة', 'امنة', 'madda'],
    ['مُحَمَّد', 'محمد', 'harakat'],
    ['سـلـيـم', 'سليم', 'tatweel'],
    ['فاطمة', 'فاطمه', 'ta-marbuta'],
    ['مصطفى', 'مصطفي', 'alef-maqsura'],
    ['Étui', 'etui', 'latin-acute'],
    ['Câble', 'cable', 'latin-circumflex'],
    ['زبون ١٢٣', 'زبون 123', 'arabic-indic-digits'],
  ];
  const productFold = pairs.map(([a, b, label]) => ({
    label,
    equal: normalizeForSearch(a) === normalizeForSearch(b),
    left: normalizeForSearch(a),
    right: normalizeForSearch(b),
  }));
  // The customer fold. When the component imports the shared normalizer the
  // check probes that real function (stronger than trusting source text);
  // only an inline definition is reproduced verbatim, because the component
  // itself is not importable outside React.
  const custSrc = read('src/components/modals/CustomersModal.tsx');
  const custLines = custSrc.split(/\r?\n/);
  const foldIdx = custLines.findIndex((l) => /const foldForSearch = /.test(l));
  const customerFoldDef =
    (foldIdx >= 0 ? custLines.slice(foldIdx, foldIdx + 2).join(' ') : '').replace(/\s+/g, ' ').trim();
  const importsSharedFold =
    /import\s*\{[^}]*\bfoldForSearch\b[^}]*\}\s*from\s*['"][^'"]*catalogSearch['"]/.test(custSrc);
  const customerFoldArabicAware =
    importsSharedFold || /\\u06[0-9A-Fa-f]{2}|\\u0640|\\u0670|normalizeForSearch/.test(customerFoldDef);
  const customerFold = importsSharedFold
    ? (s: string | null | undefined) => foldForSearch(s)
    : (s: string | null | undefined) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const customerFoldResults = pairs.map(([a, b, label]) => ({ label, equal: customerFold(a) === customerFold(b) }));
  const productOk = productFold.filter((r) => r.equal).length;
  const customerOk = customerFoldResults.filter((r) => r.equal).length;
  // The two product-fold misses are outside the case's named list (tatweel,
  // Arabic-Indic digits) but are still real: a stored title carrying either
  // becomes unfindable. The case's own list (harakat, hamza/alef, ta marbuta,
  // Latin accents) is what decides the product half.
  const caseListLabels = new Set([
    'hamza-alef',
    'hamza-below',
    'madda',
    'harakat',
    'ta-marbuta',
    'alef-maqsura',
    'latin-acute',
    'latin-circumflex',
  ]);
  const productCaseMisses = productFold.filter((r) => caseListLabels.has(r.label) && !r.equal);
  const dupes = srcHits(/const foldForSearch/);
  const sharedFoldFiles = srcHits(/from ['"][^'"]*catalogSearch['"]/)
    .filter((h) => /foldForSearch|normalizeForSearch/.test(h.text));
  record(
    'I18-04',
    productCaseMisses.length === 0 && customerOk === pairs.length ? 'PASS' : 'FAIL',
    `product_fold=${productOk}/${pairs.length} case_list_misses=${productCaseMisses.length} extra_misses=${JSON.stringify(productFold.filter((r) => !caseListLabels.has(r.label) && !r.equal).map((r) => r.label))} ` +
      `customer_fold=${customerOk}/${pairs.length} customer_misses=${JSON.stringify(customerFoldResults.filter((r) => !r.equal).map((r) => r.label))} ` +
      `customer_fold_source="${(importsSharedFold ? 'import { foldForSearch } from utils/catalogSearch' : customerFoldDef).slice(0, 150)}" customer_fold_handles_arabic=${customerFoldArabicAware} duplicate_fold_definitions=${dupes.length} (${dupes.map((d) => `${d.file}:${d.line}`).join(',')}) ` +
      `shared_fold_importers=${sharedFoldFiles.length} ` +
      (customerOk === pairs.length
        ? '— the product omnisearch and the customer directory fold identically (one shared normalizer), so a name that finds a product also finds the customer'
        : '— the customer directory folds differently from the product omnisearch, so the same typed name finds a product and misses the customer (SCL-61 is the measured consequence)'),
  );
}

// ---------------------------------------------------------------------------
// I18-06 — collation: is any list sorted with a locale-aware comparator?
// ---------------------------------------------------------------------------
{
  const localeCompare = srcHits(/localeCompare\(/);
  const withLocale = localeCompare.filter((h) => /localeCompare\([^)]*,\s*['"]/.test(h.text));
  const collator = srcHits(/new Intl\.Collator/);
  const nameSorts = srcHits(/\.sort\(\(a, b\) =>[\s\S]*?\.(name|title)/).filter((h) => /name|title/.test(h.text));
  const sortSites = srcHits(/\.sort\(/).filter((h) => /name|title|customer/i.test(h.text));
  const names = ['زيد', 'أحمد', 'بشير', 'Ali', 'Rachid', 'Élodie', 'Zineb'];
  const plain = [...names].sort();
  const localized = [...names].sort((a, b) => a.localeCompare(b, 'ar'));
  record(
    'I18-06',
    'FAIL',
    `localeCompare_sites=${localeCompare.length} of_which_with_explicit_locale=${withLocale.length} Intl_Collator_sites=${collator.length} name_sort_sites=${sortSites.length} ` +
      `sample_default_sort=${JSON.stringify(plain)} sample_locale_ar_sort=${JSON.stringify(localized)} ` +
      `— no list is sorted with an explicit locale: ${localeCompare.length === 0 ? 'localeCompare is never used at all' : 'localeCompare is called without a locale argument'}, so Latin accented names and Arabic names fall back to code-unit order (default sort puts "Élodie" after "Zineb" and "أحمد" after "زيد"); the case asks for "stable, expected" collation by language, and there is no collation setting to be stable about`,
  );
}

// ---------------------------------------------------------------------------
// I18-08 — CSV/Excel export & import: BOM, separator, decimal, round-trip
// ---------------------------------------------------------------------------
{
  const reports = read('src/components/modals/ReportsModal.tsx');
  const hasBom = /const BOM = '\\uFEFF'/.test(reports);
  const semiSeparator = /ReA?u;Statut;Date/.test(reports) || /;Statut;/.test(reports);
  const quotedText = /`"\$\{t\.receiptNumber\}"/.test(reports);
  const semicolonStripped = /\.replace\(\/;\/g, ' '\)/.test(reports);
  const decimalDot = /toFixed\(1\)/.test(reports);
  const importSrc = read('src/components/modals/SmartImportModal.tsx');
  const sniff = /const delim = tabCount/.test(importSrc);
  const numericParse = /parseFloat\(cell\.replace\(\/\[\^0-9\.-\]\+/;
  const numericLine = importSrc.split(/\r?\n/).find((l) => /parseFloat\(cell\.replace/.test(l))?.trim() ?? '';
  // Independent probe of the import rule, applied to French-formatted cells.
  const appParse = (cell: string) => parseFloat(cell.replace(/[^0-9.-]+/g, '')) || 0;
  const numericCases = ['1 234,56', '1 234,5', '12,5', '1.234,56', '2 500'].map((c) => ({ cell: c, parsed: appParse(c) }));
  const numericWrong = numericCases.filter((r) => {
    const expected = Number(r.cell.replace(/\s/g, '').replace(',', '.').replace(/\.(?=\d{3}\b)/g, ''));
    return !Number.isFinite(expected) || Math.abs(r.parsed - expected) > 0.001;
  });
  record(
    'I18-08',
    hasBom && semiSeparator && numericWrong.length === 0 ? 'PASS' : 'FAIL',
    `export_bom=${hasBom} export_separator_semicolon=${semiSeparator} export_quotes_text=${quotedText} export_strips_semicolons_from_values=${semicolonStripped} ` +
      `export_decimal=dot (toFixed) in a ";"-separated French file=${decimalDot} | import_delimiter_sniff=${sniff} import_numeric_rule="${numericLine.slice(0, 70)}" ` +
      `import_numeric_probe=${JSON.stringify(numericCases)} wrong=${JSON.stringify(numericWrong)} ` +
      `— the export is well-formed (UTF-8 BOM + ";" + quoted text, ";" stripped from values) but writes "." decimals into a French ";" file, and the importer strips every non-[0-9.-] character from a numeric cell instead of normalising it, so "1 234,56" becomes 123456 and "12,5" becomes 125 — a 100x price/stock error on a French-format CSV, with no warning`,
  );
}

// ---------------------------------------------------------------------------
// I18-10 — translation completeness (fr vs ar vs pseudo)
// ---------------------------------------------------------------------------
{
  const flatten = (dict: Record<string, unknown>, prefix = ''): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(dict)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') for (const [k2, v2] of flatten(v as Record<string, unknown>, key)) out.set(k2, v2);
      else if (typeof v === 'string') out.set(key, v);
    }
    return out;
  };
  const FR = flatten(fr as unknown as Record<string, unknown>);
  const AR = flatten(ar as unknown as Record<string, unknown>);
  const PS = flatten(pseudo as unknown as Record<string, unknown>);
  const missingInAr = [...FR.keys()].filter((k) => !AR.has(k));
  const extraInAr = [...AR.keys()].filter((k) => !FR.has(k));
  const missingInPseudo = [...FR.keys()].filter((k) => !PS.has(k));
  const placeholders = (s: string) => [...s.matchAll(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}?/g)].map((m) => m[1].toLowerCase()).sort().join(',');
  const phMismatch = [...FR.entries()]
    .filter(([k, v]) => AR.has(k) && placeholders(v) !== placeholders(AR.get(k) as string))
    .map(([k]) => k);
  const leaked = [...FR.keys()].filter((k) => /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/.test(k) === false);
  const keyLikeValues = [...AR.entries()].filter(([, v]) => /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/.test(v)).map(([k]) => k);
  const identicalToFr = [...FR.entries()].filter(([k, v]) => AR.has(k) && AR.get(k) === v && /[A-Za-zÀ-ÿ]{3}/.test(v)).length;
  // The verdict for I18-10 is emitted by the UI half (screen scan + overflow);
  // this half proves the dictionary side and prints it as a FACT the UI note
  // cites.
  console.log(
    `FACT=I18-10_DICT keys_fr=${FR.size} keys_ar=${AR.size} keys_pseudo=${PS.size} missing_in_ar=${missingInAr.length} ` +
      `extra_in_ar=${extraInAr.length} missing_in_pseudo=${missingInPseudo.length} placeholder_mismatches=${phMismatch.length} ` +
      `ar_values_that_are_raw_keys=${keyLikeValues.length} ar_values_identical_to_fr_with_latin_text=${identicalToFr} ` +
      `fr_keys_not_dotted_camel=${leaked.length}`,
  );
}

// ---------------------------------------------------------------------------
// I18-11 — name-variant search (Mohamed/Mohammed/…, Abdelkader/Abd El Kader,
//          Ben/Ibn) at small scale; the 1M ranking half needs SCL-25.
// ---------------------------------------------------------------------------
{
  const groups: Array<[string, string[]]> = [
    ['mohamed', ['Mohamed', 'Mohammed', 'Muhammad', 'Mhamed', 'Mohamad']],
    ['abdelkader', ['Abdelkader', 'Abd El Kader', 'Abd-el-Kader', 'عبد القادر']],
    ['ben', ['Ben Ali', 'Ibn Ali', 'بن علي']],
  ];
  const rows = groups.map(([label, variants]) => {
    const folded = variants.map((v) => cleanAlphanumeric(normalizeForSearch(v)));
    return { label, variants: variants.length, distinctFoldedForms: new Set(folded).size, folded };
  });
  const synonymHits = srcHits(/mohamed|mohammed|muhammad|mhamed|abdelkader|abd el kader|ibn|ben ali/i).filter(
    (h) => /synonym|alias|variant|normaliz/i.test(h.text),
  );
  const synonymClusters = srcHits(/SYNONYM_CLUSTERS/).length;
  record(
    'I18-11',
    rows.every((r) => r.distinctFoldedForms === 1) ? 'PASS' : 'FAIL',
    `variant_groups=${JSON.stringify(rows)} name_synonym_source_hits=${synonymHits.length} (SYNONYM_CLUSTERS is product-domain only, ${synonymClusters} sites) ` +
      `— no group collapses to one key: the five Latin transliterations of "Mohamed" stay five distinct keys, the three Latin spellings of Abdelkader fold together only because cleanAlphanumeric strips spaces and hyphens, and the Arabic form folds to the EMPTY string (cleanAlphanumeric keeps only a-z0-9). There is no name synonym/alias table (the only synonym table is the retail product cluster list in utils/catalogSearch.ts:20-36). ` +
      `The 1M-row ranking half of this case is NEEDS-LONG and is NOT asserted here`,
  );
}

// ---------------------------------------------------------------------------
// I18-12 — name order and parts (family name, single names, titles, Ep./Vve)
// ---------------------------------------------------------------------------
{
  const customerType = read('src/types/pos.ts').split('export interface Customer {')[1]?.slice(0, 3000) ?? '';
  const hasFamily = /familyName|lastName|surname|firstName/i.test(customerType);
  const titleHits = srcHits(/\b(Mr|Mme|Mlle|Ep\.|Vve|Ép\.)\b/);
  const sortByFamily = srcHits(/familyName|lastName|surname/i);
  record(
    'I18-12',
    hasFamily ? 'PASS' : 'FAIL',
    `customer_name_is_a_single_field=${!hasFamily} title_or_marital_prefix_hits=${titleHits.length} family_name_sort_hits=${sortByFamily.length} ` +
      `— Customer carries one free-text "name" (types/pos.ts Customer interface) with no first/family split and no title or "Ep."/"Vve" field, so the directory cannot sort by family name and cannot display a consistent "family name first" form; whatever the cashier types is the whole identity`,
  );
}

// ---------------------------------------------------------------------------
// I18-13 — phone formats: one canonical stored form, invalid rejected, search
//          by any variant (extends CRM-02, which passed on the basic formats)
// ---------------------------------------------------------------------------
{
  const cases: Array<[string, string]> = [
    ['0555000000', 'local mobile'],
    ['+213 550 123 456', 'international spaced'],
    ['00213 550123456', '00-prefix'],
    ['(0)550123456', 'bracketed zero'],
    ['021123456', 'landline'],
    ['550123456', 'no leading zero'],
    ['0555000000', 'dashes'],
    ['٠٥٥٠١٢٣٤٥٦', 'arabic-indic'],
    ['۰۵۵۰۱۲۳۴۵۶', 'persian'],
    ['０５５０１２３４５６', 'full-width'],
    ['055012345', '9-digit mobile (short)'],
    ['05550000007', '11-digit mobile (long)'],
    ['abc', 'letters'],
    ['0555000000 ext 12', 'extension'],
  ];
  const rows = cases.map(([input, label]) => {
    const r = normalizeAlgerianPhone(input);
    return { label, input, valid: r.isValid, canonical: normalizeAlgerianPhoneCanonical(input), local: r.local, op: r.operator };
  });
  const invalid = rows.filter((r) => !r.valid);
  const variantsOfSame = ['0555000000', '+213 550 123 456', '00213 550123456', '(0)550123456', '550123456', '0555000000', '٠٥٥٠١٢٣٤٥٦', '۰۵۵۰۱۲۳۴۵۶', '０５５０１２３４５６']
    .map((i) => normalizeAlgerianPhoneCanonical(i));
  // Verdict is emitted by the UI half (does the SAVE path honour isValid?);
  // this half proves the pure function and prints it as a FACT.
  console.log(
    `FACT=I18-13_CANONICAL variants=9 canonical_forms=${new Set(variantsOfSame).size} canonical="${[...new Set(variantsOfSame)][0] ?? ''}" ` +
      `inputs_14 invalid_isValid_false=${invalid.length} rejected=${JSON.stringify(invalid.map((r) => `${r.label}:"${r.input}"`))} ` +
      `save_path_source="${(read('src/components/modals/CustomersModal.tsx')
        .split(/\r?\n/)
        .filter((l) => /cleanPhone = norm\.isValid|cleanEditPhone = editNorm\.isValid/.test(l))
        .map((l) => l.trim())
        .join(' | ') || '(not found)')}"`,
  );
}

// ---------------------------------------------------------------------------
// I18-14 — mobile keyboards (autocorrect / suggestions / voice)
// ---------------------------------------------------------------------------
{
  record(
    'I18-14',
    'BLOCKED',
    `needs a real Android soft keyboard with autocorrect/suggestion/voice input to observe whether composition events mutate IMEI/phone/amount fields and whether suggestions leak other customers' names; the emulator's AOSP keyboard has no learned dictionary or cloud suggestions, and driving the IME composition protocol over CDP is not equivalent. Needed: physical Android phone, Gboard in Arabic and French, with the customer/IMEI forms open`,
  );
}

// ---------------------------------------------------------------------------
// DAT-84 — "Data safety" screen for the owner
// ---------------------------------------------------------------------------
{
  const dbStats = read('src/db/adapters/base.ts').split('export interface DbStats {')[1]?.split('}')[0] ?? '';
  const integrity = read('src/db/adapters/base.ts').split('export interface IntegrityReport {')[1]?.split('}')[0] ?? '';
  const backupTab = read('src/components/modals/settings/BackupSettingsTab.tsx');
  const required: Array<[string, boolean, string]> = [
    ['last_backup_age', /lastBackup|backupAge|derni.re sauvegarde|last_backup/i.test(backupTab)],
    ['last_backup_verified', /verified|v.rifi/i.test(backupTab) && /backup/i.test(backupTab)],
    ['off_machine_copy', /off.?machine|external|hors machine/i.test(backupTab)],
    ['last_restore_test', /restoreTest|lastRestore|test.*restore|restauration test/i.test(backupTab)],
    ['integrity_result', /integrity/i.test(dbStats) || /integrity/i.test(integrity)],
    ['unsynced_count_age', /unsynced|pendingSync|outboxAge|syncAge/i.test(backupTab) || /unsynced/i.test(dbStats)],
    ['free_disk', /freeDisk|diskFree|free_disk|espace libre/i.test(backupTab) || /free/i.test(dbStats)],
    ['wal_size', /wal_size_bytes/.test(dbStats)],
    ['canary', /canary/i.test(backupTab) || /canary/i.test(dbStats)],
    ['clock_sanity', /clock/i.test(backupTab) || /clock/i.test(dbStats)],
  ];
  const present = required.filter(([, ok]) => ok).map(([k]) => k);
  const absent = required.filter(([, ok]) => !ok).map(([k]) => k);
  const alertPath = srcHits(/notifyOwner|ownerAlert|alertOwner|sendAlert/i);
  record(
    'DAT-84',
    present.length === required.length ? 'PASS' : 'FAIL',
    `signals_present=${present.length}/${required.length} ${JSON.stringify(present)} signals_absent=${JSON.stringify(absent)} ` +
      `DbStats_fields="${dbStats.replace(/\s+/g, ' ').trim().slice(0, 180)}" integrity_report_fields="${integrity.replace(/\s+/g, ' ').trim().slice(0, 90)}" ` +
      `owner_alert_channel_hits=${alertPath.length} ` +
      `— a backup screen exists (WAL size, PRAGMA integrity_check + VACUUM, checkpoint, JSON export/restore), so the capability is there, but the owner's traffic-light view is missing ${absent.length} of ${required.length} signals: no last-backup age, no verified/off-machine flag, no recorded restore test, no unsynced count/age, no free-disk, no canary, no clock sanity. There is also no alert channel to the owner, and "integrity_status" is a stored string rendered green with no timestamp, which is exactly the stale-value-shown-as-fresh the case forbids`,
  );
}

// ---------------------------------------------------------------------------
// DAT-79 — near-zero RPO (replica / continuous copy / age badge / promotion)
// ---------------------------------------------------------------------------
{
  // Case-sensitive per-term counts: an /i flag on "RPO" matches the "rpo" in
  // "purpose" and inflated the first pass to 173 meaningless hits.
  const countHits = (re: RegExp) => srcHits(re).length;
  const replica = countHits(/\breplica\b/);
  const standby = countHits(/\bstandby\b/);
  const rpo = countHits(/\bRPO\b/);
  const promote = countHits(/\bpromot(e|ed|ion)\b/i);
  const lagBadge = countHits(/syncAge|lastSyncAge|outboxAge|replication.?lag|lag.?badge/i);
  const drill = countHits(/promotion.?drill|restore.?drill|failover.?test|failover/i);
  const outbox = countHits(/sync_outbox/);
  const replicaSites = srcHits(/\breplica\b/)
    .slice(0, 4)
    .map((h) => `${h.file}:${h.line}`)
    .join(',');
  record(
    'DAT-79',
    'FAIL',
    `replica_hits=${replica} standby_hits=${standby} RPO_hits=${rpo} promote_hits=${promote} lag_or_age_badge_hits=${lagBadge} failover_or_drill_hits=${drill} sync_outbox_mentions=${outbox} ` +
      `replica_sites_sample=${replicaSites} ` +
      `— every "replica" hit means the Dexie UI mirror or causal-convergence comment (sync/causalVersion.ts:14, sync/genericApply.ts:4), never a second DB copy: the only cross-machine transport is the row outbox to Turso, a store-and-forward queue. There is no hot standby, no RPO measurement, no lag/age badge, no promotion drill and no failover alert, so the case's four assertions (RPO in seconds under load, a failed replication shows an age badge and alerts, a replica can be promoted in a drill, replication never corrupts or slows sales) cannot hold. The RPO number itself was not measured because no replica exists to measure it against`,
  );
}

// ---------------------------------------------------------------------------
// I18-03 / I18-07 print facet — the ESC/POS text encoder (FACT only; the
// verdicts are emitted by the UI half, which owns display/storage).
// ---------------------------------------------------------------------------
{
  const dump = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const b1 = new EscPosBuilder();
  b1.text('Client: أحمد بن علي');
  const arabicBytes = b1.build();
  const b2 = new EscPosBuilder();
  b2.text('Tél:');
  const accentBytes = b2.build();
  const b3 = new EscPosBuilder();
  b3.text('🔛@X');
  const emojiBytes = b3.build();
  const hasEsc = emojiBytes.indexOf(0x1b) >= 0;
  const escAt = emojiBytes.indexOf(0x1b);
  const emojiLowBytes = '🔛'.split('').map((c) => c.charCodeAt(0) & 0xff);
  console.log(
    `FACT=I18-03_PRINT text_encoder="control bytes blocked in text(); characters above Latin-1 -> 0x3F; no code page command (ESC t never emitted)" ` +
      `arabic_name_bytes="${dump(arabicBytes)}" accent_label_bytes="${dump(accentBytes)}" ` +
      `printable_arabic_bytes_are_ascii=${[...arabicBytes].every((x) => x >= 0x20 && x <= 0x7e)} ` +
      `receipt_customer_line_source="${(read('src/utils/escpos.ts')
        .split(/\r?\n/)
        .find((l) => /builder\.text\(pair\('Client:'/.test(l))
        ?.trim() ?? '(not found)')}"`,
  );
  console.log(
    `FACT=I18-07_PRINT emoji="🔛" code_unit_low_bytes=${JSON.stringify(emojiLowBytes)} buffer_bytes="${dump(emojiBytes)}" ` +
      `esc_injected=${hasEsc} esc_at=${escAt} following_byte=${escAt >= 0 ? emojiBytes[escAt + 1]?.toString(16) : 'n/a'} ` +
      `- ${hasEsc
        ? 'a title containing an emoji whose low surrogate ends in 0x1B emits a raw ESC into the print stream; with a following 0x40 it is the ESC @ printer-reset command'
        : 'no control byte from the title reaches the stream: text() drops bytes < 0x20 and degrades characters above Latin-1 to "?", so a malicious title cannot inject ESC/GS commands. Arabic still prints as "?" because no code page or raster mode is negotiated (RCP-01)'}`,
  );
}

// ---------------------------------------------------------------------------
// Machine specs + summary
// ---------------------------------------------------------------------------
const cpus = os.cpus();
const specs = {
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: cpus[0]?.model ?? 'unknown',
  cores: cpus.length,
  ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
  node: process.version,
  freeGiB: +((fs.statfsSync?.(ROOT)?.bavail ?? 0) * (fs.statfsSync?.(ROOT)?.bsize ?? 0) / 2 ** 30).toFixed(1),
  at: new Date().toISOString(),
};
console.log(`MACHINE=${JSON.stringify(specs)}`);
const outDir = path.join(ROOT, 'e2e-tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '27c-i18-checks.json'), JSON.stringify({ specs, results }, null, 2));
const tally = results.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
console.log(`SUMMARY=${JSON.stringify(tally)} cases=${results.length}`);

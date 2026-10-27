// Part A item 4: Absence verdict verification with French/Arabic terms
import { grepSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const SRCTAURI = path.join(ROOT, 'src-tauri', 'src');

// Terms to search
const TERMS = {
  // RCP-14 (A4 invoice)
  'facture': ['facture', 'invoice'],
  'facture PDF': ['facture', 'pdf', 'invoice', 'document A4'],
  'bon de livraison': ['bon de livraison', 'delivery note', 'packing slip'],
  // RCP-15 (gift receipt, deposit slip)
  'ticket cadeau': ['ticket cadeau', 'gift receipt', 'bon cadeau'],
  'acompte': ['acompte', 'deposit slip', 'arrhes', 'versa'],
  'avoir': ['avoir', 'credit note', 'note de crédit'],
  // RCP-17 (language)
  'langue': ['langue', 'language', 'arabe', 'arabic'],
  // RCP-23 (warranty)
  'garantie': ['garantie', 'warranty', 'garant', 'guarantee'],
  'جديدة': ['جديدة', 'جديد', 'new warranty'],
  'مجانية': ['مجانية', 'warranty'],
  // TIM-04 (Hijri)
  'هجري': ['هجري', 'hijri', 'islamic', 'lunar'],
  'تقويم': ['تقويم', 'calendar'],
};

const RESULTS = {};
for (const [group, terms] of Object.entries(TERMS)) {
  RESULTS[group] = {};
  for (const term of terms) {
    try {
      const out = execSync(
        `Select-String -Path ..\\src\\* -Recurse -Include *.ts,*.tsx -CaseSensitive -Pattern "\\Q${term}\\E" 2>nul | Select-String -Pattern "\\.(ts|tsx):" | Select-Object -First 3`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, shell: true }
      );
      RESULTS[group][term] = out.trim().slice(0, 200) || 'not found';
    } catch {
      RESULTS[group][term] = 'not found';
    }
  }
}
console.log(JSON.stringify(RESULTS, null, 2));

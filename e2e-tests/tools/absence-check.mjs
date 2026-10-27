#!/usr/bin/env node
// Part A item 4: Absence verdict verification - French/Arabic terms
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Search terms grouped by case
const terms = {
  'RCP-14': ['facture', 'invoice', 'A4', 'pdfinvoice', 'salesinvoice', 'document'],
  'RCP-15': ['ticket cadeau', 'gift receipt', 'bon cadeau', 'deposit slip', 'acompte', 'arrhes', 'avoir', 'credit note'],
  'RCP-17': ['receipt language', 'receipt language', 'print language', 'français/arabe', 'عربي'],
  'RCP-23': ['nouvelle garantie', 'garantie neuve', 'garantie extend', 'warranty condition', 'refurbished warranty', 'جديدة', 'ضمان'],
  'TIM-04': ['hijri', 'islamic calendar', 'lunar', 'héjirien', 'هجري', 'تقويم'],
};

for (const [caseId, searchTerms] of Object.entries(terms)) {
  console.log(`\n=== ${caseId} ===`);
  for (const term of searchTerms) {
    try {
      const out = execSync(
        `Select-String -Path .\\src\\* -Recurse -Include *.ts,*.tsx -CaseSensitive -Pattern "\\Q${term}\\E" 2>nul | Select-String -Pattern "TSX?:" | Select-Object -First 2`,
        { cwd: ROOT, encoding: 'utf8', timeout: 20000, shell: true }
      );
      const hit = out.trim();
      if (hit && !hit.includes('Select-String')) {
        console.log(`  HIT "${term}": ${hit.slice(0, 180)}`);
      } else {
        console.log(`  miss: "${term}"`);
      }
    } catch {
      console.log(`  miss: "${term}"`);
    }
  }
}

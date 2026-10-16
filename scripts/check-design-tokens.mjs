import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const componentsDir = path.join(rootDir, 'src', 'components');
const baselineFile = path.join(__dirname, 'design-token-baseline.json');

const updateBaseline = process.argv.includes('--update-baseline');

const PATTERNS = {
  rawStatusColors: /\b(text|bg|border)-(emerald|rose|red|amber|sky|cyan|purple|indigo|green|blue|yellow|orange)-\d{2,3}\b/g,
  rawNeutrals: /\b(text|bg|border)-(slate|gray|zinc|neutral)-\d{2,3}\b|\btext-white\b/g,
  arbitraryTextSizes: /\btext-\[\d+px\]\b/g,
  arbitraryZ: /\bz-\[\d+\]\b/g,
  inlineHexInClassName: /#[0-9a-fA-F]{3,8}\]/g,
};

function getAllComponentFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === 'mobile') continue; // Exclude mobile directory
      results = results.concat(getAllComponentFiles(fullPath));
    } else if (file.endsWith('.tsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

function countPatterns(content) {
  const counts = {};
  for (const [key, regex] of Object.entries(PATTERNS)) {
    const matches = content.match(regex);
    counts[key] = matches ? matches.length : 0;
  }
  counts.totalDebt = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

const files = getAllComponentFiles(componentsDir);
const currentStats = {};
let totalSystemDebt = 0;

for (const filePath of files) {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf-8');
  const stats = countPatterns(content);
  currentStats[relPath] = stats;
  totalSystemDebt += stats.totalDebt;
}

if (updateBaseline || !fs.existsSync(baselineFile)) {
  fs.writeFileSync(baselineFile, JSON.stringify(currentStats, null, 2), 'utf-8');
  console.log(`[PASS] Design token baseline written with ${files.length} desktop files. Total system debt: ${totalSystemDebt}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
let violations = [];

for (const [relPath, current] of Object.entries(currentStats)) {
  const base = baseline[relPath];
  if (!base) {
    // New file must have 0 debt!
    if (current.totalDebt > 0) {
      violations.push({
        file: relPath,
        reason: `New desktop file introduced with ${current.totalDebt} debt items. New files must use design tokens only!`,
      });
    }
  } else if (current.totalDebt > base.totalDebt) {
    violations.push({
      file: relPath,
      reason: `Debt increased from ${base.totalDebt} to ${current.totalDebt} (+${current.totalDebt - base.totalDebt})!`,
    });
  }
}

if (violations.length > 0) {
  console.error('\n========================================================================');
  console.error('❌ DESIGN TOKEN RATCHET VIOLATIONS DETECTED');
  console.error('========================================================================\n');
  for (const v of violations) {
    console.error(`- ${v.file}: ${v.reason}`);
  }
  console.error('\nDo not introduce hardcoded hex, raw palette, or arbitrary px styles in desktop components.');
  process.exit(1);
}

console.log(`[PASS] Design token ratchet intact across ${files.length} desktop files. System debt: ${totalSystemDebt}`);
process.exit(0);


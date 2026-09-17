// MobiPOS — free disk-space gate for Android builds (used by build-android.bat).
// Usage: node scripts/check-disk.mjs [minGB]  (default 8)
// Exits 0 when the project drive has enough room, 1 otherwise. Dependency-free.
import fs from 'node:fs';
import path from 'node:path';

const minGB = parseFloat(process.argv[2] || '8') || 8;

try {
  const stats = fs.statfsSync(path.resolve('.'));
  const freeGB = (stats.bfree * stats.bsize) / 1073741824;
  console.log(`[OK] Free disk space: ${freeGB.toFixed(1)} GB`);
  if (freeGB < minGB) {
    console.error(
      `[FATAL] Only ${freeGB.toFixed(1)} GB free — Android builds need ${minGB}+ GB. ` +
        'Free space (empty Recycle Bin, move files off C:) and re-run.'
    );
    process.exit(1);
  }
} catch {
  console.log('[WARN] Could not check disk space, continuing.');
}

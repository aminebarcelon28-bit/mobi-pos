// Tier D killer: force-kills mobi-pos.exe once after a delay (mid-run fault).
// Usage: node scripts/fault-kill.mjs --delay-ms <n>
import { execSync } from 'node:child_process';

const delayArg = process.argv.find((a) => a.startsWith('--delay-ms='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 10000;
if (!Number.isFinite(delayMs) || delayMs < 0) {
  console.error('usage: fault-kill.mjs --delay-ms <n>');
  process.exit(2);
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(delayMs));
try {
  execSync('taskkill /F /IM mobi-pos.exe', { stdio: 'ignore' });
  console.log(`[fault-kill] killed mobi-pos.exe after ${delayMs}ms`);
} catch {
  console.log('[fault-kill] target already gone');
}

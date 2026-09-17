// MobiPOS — Java version gate for Android builds (used by build-android.bat).
// Exits 0 when a JDK >= 17 is available, 1 otherwise. Keep dependency-free.
import { execSync } from 'child_process';

try {
  const output = execSync('java -version 2>&1').toString();
  const major = parseInt((output.match(/version "(\d+)/) || [])[1] || '0', 10);
  if (!(major >= 17)) {
    console.error(`[FATAL] Java ${major} too old — JDK 17+ required for Gradle Android builds.`);
    process.exit(1);
  }
  console.log(`[OK] Java ${major}`);
} catch {
  console.error('[FATAL] Cannot read java version — is a JDK installed?');
  process.exit(1);
}

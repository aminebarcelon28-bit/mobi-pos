/**
 * Smoke test for the refund audit infrastructure.
 * Runs a small subset of scenarios through both UI and IPC modes.
 */

import { runScenarios, loadScenarios } from './test-executor.mjs';

async function main() {
  console.log('=== Refund Audit Smoke Test ===\n');

  // Load a few scenarios
  const scenarios = loadScenarios(5, 0, true);
  console.log(`Loaded ${scenarios.length} scenarios`);
  for (const s of scenarios) {
    console.log(`  ${s.id}: mode=${s.dimensions.mode}, method=${s.dimensions.paymentMethod}, valid=${s.validity}`);
  }

  // Run IPC-driven smoke test first (faster, more reliable)
  console.log('\n--- IPC-driven smoke test ---');
  try {
    const summary = await runScenarios({
      limit: 3,
      offset: 0,
      onlyExecutable: true,
      port: 9222,
      mode: 'ipc',
      stopOnFailure: false,
    });
    console.log('IPC smoke results:', JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error('IPC smoke test error:', e.message);
  }

  console.log('\n=== Smoke test complete ===');
}

main().catch((e) => {
  console.error('Smoke test failed:', e.message);
  process.exit(1);
});
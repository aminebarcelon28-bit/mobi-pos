/**
 * Shared loader for plain-node harnesses that need to execute TypeScript out
 * of `src/` (test_tradein_exchange.mjs, verify-tradein-phase01.mjs).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The old trick was `transpileModule()` the file, then `import()` it as a
 * `data:text/javascript;base64,…` URL. That works ONLY for a module whose own
 * imports are already self-contained. A data: URL has no filesystem base, so
 * Node cannot resolve that module's relative specifiers — `receiptMath.ts` →
 * `../types/pos`, `savValidation.ts` → `./deviceIdCodec`, `tradeInExchange.ts`
 * → `./savValidation` all died with ERR_UNSUPPORTED_RESOLVE_REQUEST.
 *
 * Inlining one level by hand (transpile the dependency, paste its data: URL
 * into the importer's source) only moves the failure down a level: the
 * dependency's own relative import still had no base. So resolve the WHOLE
 * graph at build time instead — the emitted module is self-contained and
 * importable from a data: URL again. Production sources are untouched.
 *
 * ── Bundler choice ──────────────────────────────────────────────────────────
 * esbuild when installed, else rolldown (which arrives with Vite — the bundler
 * this repo already runs). Both bundle TS/TSX and resolve extensionless
 * relative imports; only option names and result shape differ, so both are
 * normalized here. Nothing is added to package.json, and if neither is present
 * the harness fails loudly with an actionable message instead of a cryptic
 * ERR_MODULE_NOT_FOUND.
 *
 * ── Caveat ──────────────────────────────────────────────────────────────────
 * Each entry embeds its OWN copy of whatever it shares (receiptMath and
 * tradeInExchange each inline savValidation). Harmless for these pure utils —
 * no module-level mutable state, no cross-entry identity comparison — but a
 * harness must never mutate an imported binding in place.
 */

const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

/** Pick esbuild, else rolldown; normalize their build() options + result. */
const bundler = await (async () => {
  for (const [name, isEsbuild] of [['esbuild', true], ['rolldown', false]]) {
    try {
      return { name, isEsbuild, build: (await import(name)).build };
    } catch {
      // not installed — fall through to the next candidate
    }
  }
  throw new Error(
    'No TS bundler available to load modules from src/. Install esbuild, or keep ' +
    'rolldown reachable (it ships with Vite).',
  );
})();

/** Which bundler actually got used — worth printing when a harness misbehaves. */
export const bundlerName = bundler.name;

/**
 * Bundle one repo-relative module (transitive deps included) and import it.
 *
 * @param {string} relPath  e.g. 'src/utils/savValidation.ts'
 * @param {string} root     repo root (pass process.cwd())
 * @returns {Promise<Record<string, unknown>>} the module namespace
 */
export async function importModule(relPath, root = process.cwd()) {
  const input = `${root}/${relPath}`;
  const result = await bundler.build(
    bundler.isEsbuild
      ? { entryPoints: [input], bundle: true, write: false, format: 'esm', target: 'node18', platform: 'node' }
      : { input, platform: 'node' },
  );
  const code = result.outputFiles ? result.outputFiles[0].text : result.output[0].code; // esbuild | rolldown
  return import(toDataUrl(code));
}
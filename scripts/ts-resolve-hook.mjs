/**
 * Node ESM resolution shim for importing real TS sources in test harnesses.
 *
 * The app uses extensionless relative imports (`../platform/invoke`), which
 * Node's `--experimental-strip-types` does not resolve on its own. This hook
 * maps `./x` → `./x.ts` → `./x.tsx` → `./x/index.ts` (files only). It changes
 * NOTHING about the modules under test — only specifier resolution.
 *
 * Usage:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types <test>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolver.mjs', pathToFileURL('./scripts/'));

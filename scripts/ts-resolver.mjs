/**
 * Companion resolver for ts-resolve-hook.mjs (must be a separate module:
 * module.register() takes a specifier, not inline hooks).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  try {
    if (specifier.startsWith('.')) {
      const parentPath = context.parentURL
        ? fileURLToPath(context.parentURL)
        : process.cwd();
      const base = resolvePath(dirname(parentPath), specifier);
      if (!/\.[a-z0-9]+$/i.test(base)) {
        for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
          if (existsSync(cand)) {
            return { url: pathToFileURL(cand).href, shortCircuit: true };
          }
        }
      }
    }
  } catch {
    // Fall through to default resolution on any error.
  }
  return nextResolve(specifier, context);
}

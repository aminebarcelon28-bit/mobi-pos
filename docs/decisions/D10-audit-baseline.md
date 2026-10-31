# Decision D10 — static + dependency audit baseline

- **Status:** audited 2026-10-31. Two high advisories **fixed**; nine moderate advisories **accepted with
  a written rationale** and a follow-up; Clippy has **0 errors** and 30 style warnings (none on a money path).

## Static analysis — `cargo clippy --lib`

- **0 errors; 30 warnings.** Grouped: `contains()` vs `iter().any()` (6), loop-index over bytes (3), complex
  type (3), manual prefix strip (3), needless casts (6), collapsible `if let` (2), long argument list (1), …
- **None in `src-tauri/src/refund.rs` or `src-tauri/src/trust_core/`** (checked by path filter): the money
  and trust kernels are clippy-clean. The warnings live in unrelated modules.
- Decision: do not mass-edit 30 sites across the crate in this change. A styling sweep on money code is a
  risk with no correctness payoff; recorded as follow-up debt, not as "clean".

## Dependency audit — `npm audit --omit=dev` (production tree)

| Before | After `npm audit fix` | Advisory |
|---|---|---|
| **zod 4.6.5 — HIGH** (memory exhaustion validating oversized constrained collections) | **zod 4.6.7** | GHSA (fixed in 4.6.6+) |
| **source-map-js 1.2.1 — HIGH** (event-loop DoS via indexed source-map section offsets) | **source-map-js 1.2.2** | GHSA (fixed in 1.2.2) |
| postcss 8.5.28 / others | postcss 8.5.32 | transitive |
| 9 × moderate: `exceljs → archiver → archiver-utils/glob/minimatch/readdir-glob/zip-stream`, `uuid` | unchanged | minimatch DoS (GHSA-g3hv-75wg-m249), uuid bounds (GHSA-w5hq-g745-h8pq) |

**Why the two highs were fixed now:** both are reachable at runtime (zod validates inbound/structured data;
source-map-js runs in the bundle tooling), and `npm audit fix` resolved them with patch bumps only. Verified
after the bump: `tsc -b` clean, boundary suite 23/23, wedge guards 34/34, `test:sync` C1 contract success,
`test:ui-contracts` 17/17, `test:pos_math` 135/135.

**Why the nine moderates are accepted for now:** every one is inside `exceljs`'s archive/glob chain
(`archiver`, `minimatch`, `uuid`) — Excel import/export on **local files the merchant supplies**. There is no
remote input path, and the fixed version is `exceljs@3.4.0` … the audit's only remedy is a **semver-major**
`exceljs` change (`fixAvailable: {isSemVerMajor: true}`), which would touch the export lane that produces
fiscal documents. Boring-and-proven wins on a money path: schedule the major upgrade as its own change with
the export golden tests, rather than bundling it into a refund hotfix.

## Reproduce

```
cd src-tauri && cargo clippy --lib          # 0 errors, 30 warnings (none in refund.rs/trust_core)
npm audit --omit=dev                        # 9 moderate, 0 high/critical (after fix)
npm run test:boundaries                     # 23 + 65 + 80 + 34 checks, all pass
```

## Reversal

`npm audit fix` changed only `package-lock.json` (patch-level): revert the lockfile to restore the previous
versions. The accept-decision is revisited as soon as an `exceljs` 4.x upgrade is planned.

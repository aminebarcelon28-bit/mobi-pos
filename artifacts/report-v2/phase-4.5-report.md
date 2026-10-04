# Phase 4.5 Remediation & Trust Core Audit Report (v2 Draft)

- **Document Version:** v2.0-DRAFT
- **Generated (Local):** 2026-10-01T02:57:30+01:00
- **Generated (UTC):**   2026-10-01T01:57:30Z
- **Work Order Authority:** P4.5-R2 (Coordinator Order)
- **Status:** [PENDING CAPTURE — PHASE 5 UNLOCK]

---

## 1. Post-Mortem of v1 Report Rejection

The Phase 4.5 v1 report was rejected by the coordinator due to severe evidence protocol breaches and reporting defects. The post-mortem below mechanically dissects each defect, its root cause in the v1 assembly process, and the specific standing rule that prevents recurrence:

### Defect 1: Duplication of \ackup_snapshot_is_consistent\
- **Manifestation:** In the v1 test output, the line \	est trust_core::export_snapshot::tests::backup_snapshot_is_consistent ... ok\ appeared twice: once following \session::unavailable_clock_forces_new_session\ and once following \	ime_engine::challenge_single_use_with_expiry\. This is impossible in genuine sequential or parallel cargo output.
- **Assembly Root Cause:** The author combined output fragments from multiple distinct test invocations and terminal buffers. Cargo executes unit tests in parallel threads, resulting in non-deterministic completion order across runs. Manually splicing disparate terminal snippets resulted in copy-paste duplication of this test line.
- **Preventative Rule:** **Rule R5 (Honesty Protocol)** and **Phase 3 Capture Tooling**. Under R5, no output may ever be manually assembled, spliced, or typed. Under Phase 3, \scripts/capture-gates.mjs\ pipes child-process stdout/stderr directly into immutable files (\rtifacts/capture/NNN-slug/stdout.txt\), computing SHA-256 hashes automatically without human intervention.

### Defect 2: Line Count vs. Claimed 179
- **Manifestation:** The v1 report claimed 179 passed tests, but mechanical line counting revealed 180 test lines.
- **Assembly Root Cause:** The summary string (\179 passed\) was copied from the earlier \	ask-80.log\ execution, while the test list body included spliced additions from later runs (where new tests were added), creating an internal numerical contradiction.
- **Preventative Rule:** **Rule R5** (mechanical recounting; no estimation) and **Phase 4 Evidence Protocol** (all evidence must reference artifact paths and exact file hashes, not inline hand-edited lists).

### Defect 3: Substituted Failclosed Test Body
- **Manifestation:** The failclosed test output block was substituted with synthetic text rather than verbatim terminal capture.
- **Assembly Root Cause:** The author attempted to \"clean up\" or reconstruct the expected output rather than capturing the actual process stream.
- **Preventative Rule:** **Rule R5** (\"never present assembled text as captured output\") and **Phase 3 Capture Tooling** (all streams captured verbatim via \cmd /c\ to separate stdout/stderr files).

### Defect 4: Re-Run Over Polluted First Pass
- **Manifestation:** When a test run encountered an issue, it was re-executed over the polluted state without preserving the initial run's artifacts.
- **Assembly Root Cause:** The author treated test execution as an interactive debugging loop rather than a formal, auditable gate.
- **Preventative Rule:** **Phase 3 Capture Contract** (\"Failed or polluted slots keep their slot, marked failed/polluted, never re-run in place; re-runs get new slots; nothing is deleted\") and **Rule R4** (strict append-only).

### Defect 5: Absent Patch-Crate Capture
- **Manifestation:** Tests for \patches/tauri-plugin-sql\ were omitted from the verification suite.
- **Assembly Root Cause:** The author assumed \cargo test --workspace\ covered \patches/tauri-plugin-sql\. Because \	auri-plugin-sql\ is patched via \[patch.crates-io]\ and is not listed in root \Cargo.toml\'s \workspace.members\, workspace-level cargo commands bypass it completely.
- **Preventative Rule:** **Gate 7 Specification**. The test suite explicitly specifies \cargo test --manifest-path patches/tauri-plugin-sql/Cargo.toml\ as a standalone required gate.

---

## 2. Work Package Disposition: WP5 (Offline Re-Anchor Codes)

- **Name:** Offline Re-Anchor Codes (Protocol, Payload Envelope & Verifier).
- **Disposition:** **DEFERRED (HELD GATE)**.
- **Evidence:**
  - \AGENTS.md\ (Authoritative Policy): *\"Ship gates still open: data-plane gateway, signed-time endpoint, mobile on-device verification. Offline re-anchor codes are deferred and must share the export \integrity_state\ (\	amper\/\clock\) vocabulary.\"*
  - \docs/phase-4.3-gateway-design.md:143\: *\"Standing notes: Offline re-anchor codes (deferred) must share the \integrity_state\ (\	amper\/\clock\) vocabulary with the export flag so verifiers treat both paths identically — flagged, recovery-only.\"*
  - Git Commit Chain: Commits \54217e\ (WP1), \3f8248\ (WP2), \14cc21c\ (WP3), \1993213\ (WP4), \2983e6\ (WP6), and \f3b37d\ (closure capture) confirm that WP5 was deferred from the active implementation set and held as an open ship gate alongside the data-plane gateway.

---

## 3. Technical Review Inquiries & Architectural Evidence

### 1. Re-Seal Recording: Genesis vs. Log-Only
- **Verdict:** **Log-Only & Keystore-Recorded; NOT in Genesis.**
- **Evidence (\src-tauri/src/trust_core/audit_append.rs:430-449\):**
  When re-sealing occurs over an unanchored chain, \dvance_audit_head\ writes the terminal \AuditHead\ to the keystore (\store.store_audit_head(&head)\) and emits a warning log to stderr:
  \[trust_core] audit head re-sealed over {total}-link chain with no prior head (recovery path; survivors become the new baseline — review for truncation)\ (\udit_append.rs:439-442\).
  It does NOT append or modify genesis rows in the SQLite \udit_chain\ table. The genesis link in SQLite remains fixed at the chain origin.

### 2. Aggregation Queries on \security_audit_logs\ & Per-Device Rows
- **Verdict:** **Zero Aggregations; Flat Chronological Projections Only.**
- **Evidence (\src/db/auditQuery.ts:57-71\, \src/sync/payoutWatch.ts:118\):**
  Audit log queries in the TypeScript layer project individual rows (\SELECT id, timestamp, user, action, details, requires_pin, device_id, ip_address FROM security_audit_logs ... ORDER BY timestamp DESC LIMIT \). No queries perform \GROUP BY\, \COUNT(*) GROUP BY device_id\, or device-scoped partitioning. Per-device rows are presented as flat entries in chronological order.

### 3. Definition of \"Live Dir\" in \preflight_live_dir_with_tiny_db_passes\
- **Verdict:** In \src-tauri/src/trust_core/export_snapshot.rs:1240-1246\, \preflight_live_dir_with_tiny_db_passes\ defines \dir\ as \	mpdir(\"preflight\")\, which creates a sandbox folder under \std::env::temp_dir()\ named \mobi-snap-test-preflight-{nanos}-{pid}\. \"Live dir\" is this temporary directory acting as the parent container for the mock database \live.db\. In production runtime, this maps to \C:\\Users\\Click\\AppData\\Roaming\\com.mobi.pos\.

### 4. SQLite Test Isolation Matrix
- **Verdict:** **100% Isolated; Zero Production DB Access.**
- **Evidence:** Full audit of all \Connection::open\ calls across \src-tauri\ confirms that every test uses either \Connection::open_in_memory()\ or a unique subdirectory under \std::env::temp_dir()\ (\mobi-audit-conc-*\, \mobi-snap-test-*\, \mobi-test-ro-*\). No test runner touches or opens the production database \com.mobi.pos\\mobi_pos.db\.

### 5. \debug_env_key\ vs. \eanchor\ WP6 Asymmetry Analysis
- **Context:** \secure_storage.rs\ permits dynamic environment variable overrides via \MOBI_LICENSE_MAC_KEY\ under \cfg(debug_assertions)\. Conversely, \eanchor.rs\ uses a fixed hardcoded seed \TEST_TIME_SEED = [9u8; 32]\ under \cfg(debug_assertions)\ and \\"UNCONFIGURED\"\" in release, permitting no environment variable override.
- **Options:**
  - **Option A (Full Symmetry):** Add a \MOBI_TIME_PUBKEY\ environment variable in \eanchor.rs\ under \cfg(debug_assertions)\ to mirror \secure_storage.rs\.
  - **Option B (Hermetic Test Enforcement):** Remove \debug_env_key\ from \secure_storage.rs\ and bind license testing to hardcoded test keys, eliminating environment dependence.
  - **Option C (Security Separation - Current):** Maintain the asymmetry. The license MAC key is a local symmetric secret where developer environment injection is useful, whereas the time re-anchor key is an asymmetric cloud-pinned public key where hardcoding prevents unauthorized test key confusion.
- **Recommendation:** Retain Option C or adopt Option A upon signed-time endpoint delivery; final binding decision is reserved to the owner.

---

## 4. Proposed Gate-Set Definition of Done (DoD)

| Gate | Target Command | Scope / Cwd | DoD Status | Justification / Contract |
| :--- | :--- | :--- | :--- | :--- |
| **Gate 1** | \cargo test --workspace\ | Root | **IN** | Validates all Rust unit and integration tests across workspace crates. |
| **Gate 2** | \cargo test --release\ | Root | **IN** | Validates release-profile assertions, ensuring debug bypasses are absent. |
| **Gate 3** | \cargo clippy --workspace --all-targets -- -D warnings\ | Root | **IN** | Enforces zero compiler and linter warnings across all workspace targets. |
| **Gate 4** | \
px tsc -b\ | Root | **IN** | Verifies static TypeScript type correctness across all project packages. |
| **Gate 5** | \
pm run test:license\ | Root | **IN** | Verifies license cryptography, token validation, clock guard, and failclosed paths. |
| **Gate 6** | \
pm run test:boundaries\ | Root | **IN** | Verifies trust table write boundaries, registry checks, and PIN exposure invariants. |
| **Gate 7** | \cargo test --manifest-path patches/tauri-plugin-sql/Cargo.toml\ | Root | **IN** | Executes wrapper tests in patched plugin (bypassed by workspace test). |
| **Ancillary 1** | \
pm run build\ | Root | **IN** | Validates frontend Vite bundling and production asset compilation. |
| **Ancillary 2** | \
pm test\ | Root | **OUT** | Monolithic legacy suite (18 suites across e-commerce/sync); trust core is isolated in Gates 5 & 6. |
| **Ancillary 3** | \oxlint\ | Root | **OUT** | Stylistic linter; architectural boundaries and typing are enforced by Gates 4 & 6. |

---

## 5. Formal Enumeration of [UNKNOWN]s

In accordance with Rule R5, all areas where definitive facts cannot be established from preserved disk artifacts are formally disclosed below:

1. **[UNKNOWN] Incident Binary Exact SHA-256 at 22:13:50:** Because \	arget/debug/mobi-pos.exe\ was overwritten during subsequent compilation at 02:37:04 on Oct 1, the exact byte hash of the binary that ran under PID 21584 cannot be definitively proven.
2. **[UNKNOWN] Exact Uncommitted Source Tree at 22:12:20 Watcher Rebuild:** Because 17 files were captured into git retrospectively in commit \f3b37d\ at 01:44:52, the precise intermediate working-tree state compiled by the watcher at 22:12:20 is blurred.
3. **[UNKNOWN] Windows Credential Manager Elevation Context (Operator Item Q6):** Whether credentials for \mobi-pos-trust\ were created under the current user SID or SYSTEM integrity level requires elevated \cmdkey /list\ execution by the operator.
4. **[UNKNOWN] Prefetch Execution Timestamp for PID 21584 (Operator Item Q7):** Exact process start metadata from Windows Prefetch requires elevated operator extraction from \C:\\Windows\\Prefetch\\\.

---

## 6. Phase 5 Execution Status

**STATUS:** [LOCKED]
No test, build, or gate execution has occurred. All capture slots for Gates 1–7 remain [PENDING CAPTURE] pending explicit unlock from the coordinator.

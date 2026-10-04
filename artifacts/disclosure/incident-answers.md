# Incident Answers & Technical Forensics Disclosure (WORK ORDER P4.5-R2)

- **Generated (Local):** 2026-10-01T02:56:05+01:00
- **Generated (UTC):**   2026-10-01T01:56:05Z
- **Standard Protocol:** Every item structured as ANSWER → EVIDENCE → CONFIDENCE → BLOCKED-ON.

---

## Q1: File Writes Under Watched Paths (21:54:05–22:12:20)

- **ANSWER:** During the interval between 21:54:05 (tauri dev launch) and 22:12:20 (watcher rebuild), multiple source files under src-tauri/src/trust_core/ were being actively authored and modified in the working tree for Phase 4.5. Because these modifications were held in the working tree across several work packages and only committed later (between 00:01:23 and 01:45:06 on Oct 1), and because commit \f3b37d\ later captured 17 uncommitted dependency-closure files, the exact intermediate source snapshot compiled at 22:12:20 is blurred. What remains recoverable is: (1) 	arget/debug/.fingerprint timestamps and hash manifests for individual crate units; (2) 	arget/debug/deps compilation products; (3) git commit baselines (\54217e\ through \f3b37d\) representing the final state of those files.
- **EVIDENCE:**
  - rtifacts/disclosure/sequencing.md (Table A & Table B).
  - Git commit dates: \54217e\ (00:01:23), \3f8248\ (01:17:09), \14cc21c\ (01:28:55), \f3b37d\ (01:44:52).
  - Target fingerprints recorded in rtifacts/target-state/fingerprint-summary.txt.
- **CONFIDENCE:** [KNOWN] for commit and fingerprint timestamps; [RECONSTRUCTED] for intermediate working-tree state prior to \54217e\.
- **BLOCKED-ON:** None.

---

## Q2: Feature-Gate Inventory of secure_storage & TAMPER_SUSPECTED Triggers

- **ANSWER:**
  The secure_storage subsystem relies on feature gates:
  1. #[cfg(debug_assertions)]:
     - debug_env_key() (src-tauri/src/trust_core/secure_storage.rs:537-545): Reads std::env::var("MOBI_LICENSE_MAC_KEY").
     - esolve_mac_key() (secure_storage.rs:733-739): Prioritizes debug_env_key() over keystore lookup.
     - esolve_keystore() (secure_storage.rs:899-902): Evaluates debug_env_key() candidates before fallback.
  2. #[cfg(not(debug_assertions))]:
     - esolve_keystore() (secure_storage.rs:903-906): Tests ONLY LEGACY_V1_FALLBACK_KEY.
     - esolve_mac_key(): debug_env_key() is absent; reads ONLY the physical store.load_mac_key().
  3. #[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]:
     - ssert_not_in_unit_tests() (secure_storage.rs:141-150): Panics if OsKeyStore is called in unit tests.
  
  **Can TAMPER_SUSPECTED arise from:**
  - **(a) Build-config mismatch?** **YES**. If state was persisted in a debug build using MOBI_LICENSE_MAC_KEY without an entry in OS keyring, launching a release build causes esolve_mac_key to skip the env var, see prior_state_exists=true, return QuarantineNoKey (secure_storage.rs:761), and trigger kernel.set_state(LicenseState::TamperSuspected) (ipc_authorizer.rs:637).
  - **(b) Debug-gated logic?** **YES**. If esolve_keystore in release encounters a v1 file signed with an environment key, it rejects it as LoadVerdict::Corrupt (secure_storage.rs:911).
  - **(c) Version skew (WP1 evaluating pre-WP1 state)?** **YES**:
    1. secure_storage.rs:832-834: If a v1 file is loaded but store_counter.is_some(), WP1 returns LoadVerdict::QuarantineTamper(TamperReason::DowngradeV1) → TAMPER_SUSPECTED.
    2. secure_storage.rs:841-844: If a v2 file exists but ctive_key is None, returns LoadVerdict::QuarantineTamper(TamperReason::MissingStoreWithState) → TAMPER_SUSPECTED.
    3. secure_storage.rs:859-861: If ile.counter < known_store_counter, returns LoadVerdict::QuarantineTamper(TamperReason::CounterRollback) → TAMPER_SUSPECTED.
    4. ipc_authorizer.rs:637-638: If prior_state_exists=true (e.g., from old counter or file) but OS keyring key is absent → TAMPER_SUSPECTED.
- **EVIDENCE:**
  - src-tauri/src/trust_core/secure_storage.rs:141-150, 537-545, 733-739, 761-766, 810-870, 899-906.
  - src-tauri/src/trust_core/ipc_authorizer.rs:623-640, 669-672, 848-851.
- **CONFIDENCE:** [KNOWN] (exact code paths cited and audited).
- **BLOCKED-ON:** None.

---

## Q3: .env / dotenv Launch Paths & Security Environment Variables

- **ANSWER:**
  1. **.env / dotenv Loaders:** There are **ZERO** .env or dotenv loaders in src-tauri/ or src/. The application does not parse .env files in Rust.
  2. **Security Environment Variables:**
     - The ONLY environment variable read by src-tauri that alters security behavior is MOBI_LICENSE_MAC_KEY (src-tauri/src/trust_core/secure_storage.rs:539).
     - (Standard platform path variables LOCALAPPDATA, APPDATA, USERPROFILE, PUBLIC, PROGRAMDATA in src-tauri/src/lib.rs:459-483 configure default file paths only).
  3. **Inheritance for PID 21584:** Because the Rust executable does not load .env, for PID 21584 (mobi-pos.exe) to inherit MOBI_LICENSE_MAC_KEY, the variable must have been explicitly present in the environment block of the parent process that spawned it (e.g., cmd.exe or powershell.exe running 
px tauri dev), or registered globally in the user/system Windows environment variables registry.
- **EVIDENCE:**
  - git grep -i "dotenv" src-tauri/ src/ (0 matches).
  - git grep -n "env::var" src-tauri/ (secure_storage.rs:539).
- **CONFIDENCE:** [KNOWN] (static codebase search).
- **BLOCKED-ON:** None.

---

## Q4: Production Data Directory mtimes Now vs. 22:08:18 Observation

- **ANSWER:**
  - **22:08:18 Observation (2026-09-30 22:08:18+01:00 / 21:08:18Z):**
    - mobi_pos.db-wal: 0 bytes, mtime 2026-09-30 22:08:18.
    - mobi_pos.db-shm: 32768 bytes, mtime 2026-09-30 22:08:18.
    - mobi_pos.db: 134,012,928 bytes, mtime 2026-09-30 22:06:10.
    - .license_state.vault: 144 bytes, mtime 2026-09-30 17:39:xx.
  - **Present Observation (2026-10-01 02:53:55+01:00 / 01:53:55Z):**
    - mobi_pos.db-wal: 329,632 bytes, LastWriteTime 2026-10-01 02:16:43+01:00 (01:16:43Z).
    - mobi_pos.db-shm: 32,768 bytes, LastWriteTime 2026-10-01 02:38:21+01:00 (01:38:21Z).
    - mobi_pos.db: 651,264 bytes, LastWriteTime 2026-10-01 02:16:42+01:00 (01:16:42Z).
    - .license_state.vault: 291 bytes, LastWriteTime 2026-10-01 02:38:21+01:00 (01:38:21Z).
- **EVIDENCE:**
  - Preserved metadata in rtifacts/datadir-meta/datadir-metadata.json and rtifacts/datadir-meta/datadir-metadata.md.
  - Incident backup folder C:\Users\Click\Desktop\mobi-pos-incident-backup-2026-09-30T2212.
- **CONFIDENCE:** [KNOWN] (filesystem metadata inspection).
- **BLOCKED-ON:** None.

---

## Q5: Cargo Test Timestamps, 22:08:18 Writer Analysis & DB Isolation Matrix

- **ANSWER:**
  1. **Timestamps of the Three \cargo test\ Runs in Session:**
     - **Run 1 (task-80):** Started 2026-10-01T01:19:29Z, Completed 2026-10-01T01:20:47Z (Local: 02:19:29–02:20:47). Passed 179 tests.
     - **Run 2 (task-136):** Started 2026-10-01T01:26:16Z, Completed 2026-10-01T01:27:43Z (Local: 02:26:16–02:27:43). Passed 180 tests.
     - **Run 3 (task-216):** Started 2026-10-01T01:34:18Z, Completed 2026-10-01T01:36:12Z (Local: 02:34:18–02:36:12). Passed 180 tests.
  2. **Could Any Test Run be the 22:08:18 Writer?** **NO**.
     - Temporal impossibility: The 22:08:18 event occurred on 2026-09-30 at 21:08:18Z, over 4 hours before Run 1 began.
     - Path impossibility: All tests in the test suite are strictly isolated from the live database.
  3. **DB-Side Isolation Matrix (Full Inventory of SQLite Opens in Tests):**
     - src-tauri/src/commands.rs:396: Connection::open_in_memory().
     - src-tauri/src/db.rs:130: Connection::open_in_memory().
     - src-tauri/src/resolver.rs:447: Connection::open_in_memory().
     - src-tauri/src/emergency_export.rs:908: Connection::open_in_memory().
     - src-tauri/src/emergency_export.rs:982: 	empdir("ro").join("t.db") under std::env::temp_dir().
     - src-tauri/src/trust_core/audit_append.rs:995, 1118, 1415: Connection::open_in_memory().
     - src-tauri/src/trust_core/audit_append.rs:1450, 1477, 1512: std::env::temp_dir().join("mobi-audit-conc-*").
     - src-tauri/src/trust_core/export_snapshot.rs:1115, 1151, 1162, 1825, 1839: 	mpdir("...") under std::env::temp_dir().
     - src-tauri/src/trust_core/pin.rs:608: usqlite::Connection::open_in_memory().
     - **Conclusion:** ZERO tests open SQLite on a non-temporary or live path. The 22:08:18 writer was the running WebView/Tauri dev process (mobi_pos.db), not any test runner.
- **EVIDENCE:**
  - rtifacts/evidence-sources/session-tasks/task-80.log, 	ask-136.log, 	ask-216.log.
  - Static audit of all Connection::open* calls across src-tauri/src/.
- **CONFIDENCE:** [KNOWN].
- **BLOCKED-ON:** None.

---

## Q6 & Q7: Operator Items (Elevated Commands, Prefetch, Hash Pass)

- **ANSWER:** Delegated to the human operator per Standing Rules R3, R5, and R7. Detailed instructions and rationale are documented in rtifacts/findings/ESCALATION.md.
- **EVIDENCE:** rtifacts/findings/ESCALATION.md.
- **CONFIDENCE:** [KNOWN] (boundary separation).
- **BLOCKED-ON:** Operator execution.

---

## X1: OsKeyStore Test Isolation & Reachability Audit

- **ANSWER:**
  - **Can any test reach load_pin_lockouts / store_pin_lockouts?** **NO**.
    - In src-tauri/src/trust_core/secure_storage.rs:247, 259, both methods call ssert_not_in_unit_tests(...).
    - Under cfg(test), ssert_not_in_unit_tests panics with "SECURITY VIOLATION: OsKeyStore::{op} invoked under cargo test".
    - The dedicated test 	est_os_keystore_is_blocked_in_unit_tests (secure_storage.rs:1633-1634) explicitly asserts that calling these methods panics.
  - **When did the gate land?** In commit \54217e\ (Phase 4.5 WP1, author date 2026-10-01 00:01:23+01:00).
  - **Was the real keyring reachable during the three test runs?** **NO**. Every PIN test in pin.rs uses MemKeyStore or a temporary FileKeyStore (pin.rs:544, 565, 587).
  - **Origin of Windows Credential Manager pin-lockout-v1:** Written exclusively by the runtime application (mobi-pos.exe PID 21584) during interactive test sessions, never by cargo test.
- **EVIDENCE:**
  - src-tauri/src/trust_core/secure_storage.rs:141-150, 246-265, 1633-1634.
  - src-tauri/src/trust_core/pin.rs:542-598.
  - Commit \54217e\ diff.
- **CONFIDENCE:** [KNOWN].
- **BLOCKED-ON:** None.

---

## X2: Incident Binary Preservation Status

- **ANSWER:**
  - The incident binary 	arget/debug/mobi-pos.exe compiled at 22:12:20 and launched at 22:13:50 on 2026-09-30 did **NOT** survive intact; it was overwritten in place during subsequent cargo test and build invocations at 2026-10-01 02:37:04+01:00 (01:37:04Z).
  - No release binary exists in 	arget/release/mobi-pos.exe.
  - The surviving debug binary was immediately preserved at rtifacts/target-state/surviving-mobi-pos-debug.exe (SHA-256: 39599d19a27c76a524a2ef37d1e892c90680a6713cf14ef9745d475ef0ec9a41).
  - Detailed escalation recorded in rtifacts/findings/ESCALATION.md.
- **EVIDENCE:**
  - rtifacts/target-state/binary-status.md.
  - rtifacts/target-state/surviving-mobi-pos-debug.exe.
- **CONFIDENCE:** [KNOWN].
- **BLOCKED-ON:** None.

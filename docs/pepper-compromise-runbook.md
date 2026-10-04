# PIN pepper compromise runbook

Companion to `src-tauri/src/trust_core/pin.rs` (`load_pin_pepper`,
`ensure_pin_pepper`). The device pepper is 32 random bytes in the OS
keychain (desktop: `mobi-pos-pin`/`pepper`) or the device vault file
(mobile: `.pin_pepper.vault`) — never in the database, never synced, never
logged. It turns every Argon2id input into `SHA256(pepper || 0x00 || pin)`
before the KDF, which is what makes excavated databases useless offline.

## What "compromise" means here

- The keychain/vault value was read by an attacker (device seized unlocked,
  keychain backup restored elsewhere, vault file exfiltrated), OR
- The pepper row is GONE while `v2$` credentials exist (deleted keychain
  entry, wiped vault). The kernel treats this as key loss and fails closed:
  `pin_set` refuses (`PIN pepper absent with v2 credentials present`),
  `pin_verify` on `v2$` denies with `kdf_unavailable` (no lockout burn —
  nothing was tested).

Both cases have the SAME recovery: re-key every profile (below). There is
no bulk re-hash — the plaintexts are gone by design — and no downgrade:
pepperless verification is not implemented and must never be added (it
would re-open offline brute force for every excavated copy).

## Recovery (per terminal, in order)

1. **Confirm scope:** `v2$` rows verify nowhere without the pepper. Legacy
   `v1$` rows are unaffected (separate mechanism, still must rotate).
2. **Provision the new pepper:** delete NOTHING yet. On desktop, remove the
   `mobi-pos-pin`/`pepper` keychain entry if a suspect value remains (a
   present-but-compromised pepper must go; absence triggers the same path).
   On mobile, delete `.pin_pepper.vault`. The NEXT `pin_set` provisions a
   fresh pepper automatically — but ONLY when no `v2$` rows exist, so:
3. **Re-key the master through tech recovery (pepper-dead unboxing):**
   run the lock-screen challenge-response recovery and set the new manager
   PIN. The first attempt fails with a pepper-absent error; the flow
   retries ONCE with `recoveryReset`, which re-provisions a fresh pepper
   and re-keys the master in one step (`resolve_recovery_pepper`:
   master-only, refused on healthy installs, refused for non-master
   targets). Every other `v2$` keeps failing closed until rotated.
   Then rotate every cashier/admin profile from Settings (manager PIN
   gate first), or delete-and-recreate departed profiles.
   - Verify: each profile logs in once with the new PIN; the journal shows
     `Rotation PIN Sécurité … (format v2)` per profile.
4. **Verify the old pepper is dead:** no `v2$` row predating the incident
   may remain (query `app_settings`: every `pin` field must be a post-
   incident mint — compare rotation audit timestamps). Any leftover is a
   profile that still cannot log in: rotate it now.
5. **Record the incident** (date, terminal, suspected vector, profiles
   re-keyed, old pepper destroyed) — an unrecorded re-key did not happen.

## Why this terminates (no deadlock)

- The pepper and the BACKUP key are independent: snapshot decryption needs
  only the backup key + a working manager login. After step 3 the manager
  verifies under the fresh pepper, so `decrypt_snapshot_for_recovery`
  works even though pre-incident snapshots hold pre-incident hashes.
- The recovery flag cannot brick or bypass a healthy install: present
  pepper → `recovery reset not needed`; non-master → `master-only`. It is
  effective exactly in the dead state, where no working auth exists to
  bypass.

## What NOT to do

- Do NOT restore a backup to "recover" logins: pre-incident snapshots hold
  pre-incident hashes that fail under the new pepper (correct), and
  restoring would also roll back business data.
- Do NOT copy a pepper between terminals: per-device means per-device.
  Cloning a pepper clones the blast radius.
- Do NOT add a pepperless verification fallback "temporarily": that is the
  vulnerability, reintroduced with extra steps.

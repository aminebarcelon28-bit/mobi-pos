# Manager PIN length position (recorded decision)

**Status:** decided 2026-10-02. Manager 6–8 digits, cashier exactly 4.
Uniform mint cap enforced natively (`validate_pin`) and on every entry
surface (lock screen, rotation, recovery, first-boot, Settings).

## The tension (stated, not hidden)

- NIST SP 800-63B-4 §3.1.1.2 sets ≥15 chars (single-factor) / ≥8 (MFA-only)
  for centrally-verified passwords. A 6-digit numeric PIN is ~20 bits —
  nowhere near that bar.
- Retail reality (2026 vendor consensus: unique 4-digit staff PINs,
  supervisor override) and this app's threat model point the other way:
  these are device-local till activation secrets, not centrally-verified
  passwords.

## Why 6–8 / exactly-4 stands here (activation-secret scoping, §3.2.10)

1. **Verifier-local:** the PIN never leaves the terminal (no network
   authenticator, no replayable credential). NIST length rules target
   remote guessing at scale; our guessing surface is one keypad.
2. **Throttling stricter than both ceilings:** 5→60s, 10→15min, 15→60min
   persisted per profile, surviving restart — inside NIST rate-limiting
   (§3.2.2) and PCI DSS 8.3.4 (≤10 attempts, ≥30 min).
3. **Memory-hard KDF + secret pepper:** Argon2id 64 MiB/t=3/p=1 over
   `SHA256(device_pepper || pin)` (pepper in OS keychain, never synced).
   Excavated hashes are unverifiable offline, not merely expensive.
4. **Blocklist at mint** (NIST SHALL): runs, repeats, keypad lines,
   classics — enforced natively, pre-checked in UI.
5. **Unique per profile + single-PIN master contract:** no shared till
   code (PCI DSS 8.2.2 shared-only-on-exception, exceeded not met).
6. **Event-driven rotation, anomaly evidence:** legacy-migration forced
   rotation, compromise-triggered re-key (pepper runbook), kernel
   clock-anomaly rows, denial-burst telemetry — no expiry theater.

## The uniformity argument (why a CAP, not just a floor)

Every entry surface caps input (login keypad, rotation forms, first-boot);
a 9+-digit credential would be creatable but untypeable — a self-lockout
worse than any marginal entropy gain. The VERIFY path still accepts longer
legacy credentials (grandfathered once, then forced rotation to 6–8).

## What would change this decision

- A regulator or customer requiring ≥8-char manager secrets → raise
  `MANAGER_PIN_MIN_LEN` to 8 (one constant + UI copy; verify path
  untouched) and re-run `trust_core::pin` tests.
- Evidence of successful online guessing inside the lockout ladder.
- Centralized (network) authentication arriving — at that point these
  become centrally-verified passwords and the NIST length bar applies
  in full.

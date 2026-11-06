# ADR-007 — Audit chain baseline reset (sanctioned wipes only)

- Status: accepted (2026-11-06)
- Supersedes: none
- Related: ADR-005 (role-bound IPC), E-0217 (boot-hydration repair), E-0219 (harness isolation)

## Context

The audit ledger is tamper evidence. Links live in `audit_chain`, rows in
`security_audit_logs`, and the truncation anchor (the head `{seq, hash, mac}`)
lives in the native keystore, which outlives the database. `verify_audit_chain_full`
therefore fails closed when

- a chain link references a missing log row (`link failure: audit chain
  references missing log row`), or
- the sealed head is ahead of the chain (`truncation suspected`), or
- the head is absent while links exist.

The E2E harness wipes data tables between specs, under a live process, on
purpose. Before the fixture refactor it deleted `security_audit_logs` without
`audit_chain`, so every later spec in the same process saw a dangling link:
SEC-05 reported `linksVerified=0/105 headSeq=790` while the app was healthy.
That is the tamper detector working exactly as designed — a wipe under a live
process *is* the shape of a tamper.

Two wrong repairs were rejected: re-anchoring automatically in the audit path
(every tamper would heal itself) and deleting/ weakening the SEC-05 assertions.

## Decision

1. **The product never auto-heals the audit chain.** No boot or read path
   rewrites the head. `boot_audit_check` stays read-only; appends advance the
   head as they always did.
2. **One sanctioned reset path.** The harness's single reset helper wipes the
   data tables (log rows *and* chain links together), then calls the native
   `audit_reanchor` command, then the E-0217 debt repair. Post-reset state is
   the fresh-install shape: an empty chain, no stale head, and one chained
   `audit.baseline_reset` event as the new genesis link.
3. **`audit_reanchor` fails closed.** It refuses unless `audit_chain` is empty
   (`AUDIT_CHAIN_NOT_EMPTY`), so a live chain can never be re-baselined; it
   clears the head only through the dedicated `KeyStore::clear_audit_head`
   method, and it writes the reset event through the normal audited append
   path. Capability: `OperationalWrites`; registry 119 → 120. No new SQL text
   (sql-boundary stays 301).
4. **The reset is never silent.** The command returns the retired head
   sequence and the new event id; the harness logs `[reset] sanctioned: …` for
   every invocation. A refusal throws, so a half-reset cannot pass.
5. **Tamper detection stays a positive test.** SEC-05 keeps every assertion:
   it resets through the helper (baseline 105/105), then tampers a covered
   byte, restores it exactly, deletes a middle link, and re-inserts it
   verbatim. The delete/re-insert is `try/finally` so a failed assertion can
   never leave the chain broken for later specs.

## Consequences

- A wiped chain with a surviving head is still `Broken` for every consumer —
  the detector is unchanged; only the sanctioned reset retires the head, and it
  does so *before* any new append.
- If a reset races an in-flight append, the re-anchor refuses
  (`AUDIT_CHAIN_NOT_EMPTY`) and the helper throws; the run fails loudly rather
  than continuing on a broken chain.
- Production has one more `OperationalWrites` command. It cannot re-baseline a
  non-empty chain, and its event records the old head sequence, so its use is
  visible in the log too.

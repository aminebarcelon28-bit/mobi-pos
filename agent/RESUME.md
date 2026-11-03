# RESUME — after c01-rc-7 (queue 2 continued)

- **Tags:** `c01-rc-7` at `eeda281`; `c01-rc-6` at `d57ddef`; rc-1…rc-7 untouched.
- **Branch:** `c01-rc6-work`. Latest commits: `29f8e39` (numbering seam), `039d93d`
  (doc reword), `5774377` (SEC-01 inc 1), `3b82216` (two-instance harness).
- **New since rc-7:**
  - **SYN-02 closed with the decided device-series rule** (`src/utils/numbering.ts`,
    ADR-006): `PREFIX-<SERIES>-<000001>`, one continuous counter per terminal
    series, per-document-type lanes, legacy scheme still selectable, degraded
    store counted. Stamped **PASS** from a real checkout sale
    (`receipt=REC-Q4ZD-000001`) with a two-series negative control.
    **Provisional:** owner/accountant must confirm the fiscal layout (HAR-004).
  - **Two-instance app harness** (`npm run test:two-instance`): two real app
    processes at the same time, own sandboxes and driver ports, own device
    identities and series, overlapping windows — 8/8.
  - **SEC-01 increment 1:** `set_cloud_credentials` / `delete_cloud_credentials`
    are manager-only in the native authorizer (`PRIVILEGED_COMMANDS`) with a
    failing-then-passing Rust test; lib suite now 455/455.
- **Still BLOCKED (owner):** SYN-05/06/07/11/21/29 need the merchant gateway with
  enrolled per-device keys (HAR-003); the harness removes the "no second
  terminal" objection, not the gateway one.
- **Next increments:** SEC-01 increment 2 (read-only SQL for the renderer, writes
  through commands) or increment 1b (register `sqlite_db_maintenance` and the
  money commands once their tests are ready) · move the numbering counter into
  the native DB transaction + `UNIQUE(receipt_number)` · the product gaps listed
  in the rc-7 handoff.
- **Owner asks (unchanged, minimised):** printer (HAR-002) · merchant gateway +
  enrolled keys (HAR-003) · fiscal numbering confirmation (HAR-004, device-series
  recommended).

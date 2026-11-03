# Security policy

## Reporting a vulnerability

Do not open a public issue for a security defect. Report it privately to the
maintainer of this repository (the owner contact on the commercial agreement) with:

- the affected version (the `c01-rc-N` tag or the commit),
- the impact (fiscal data, PIN bypass, licence bypass, sync integrity, …),
- reproduction steps and, if possible, a minimal proof.

You will get an acknowledgement within 5 working days and a remediation plan.

## Supported versions

Only the newest `c01-rc-N` tag is supported. Older tags are kept for audit and are
never patched.

## Security model (what the product relies on)

- **Native authority.** Privileged operations run in Rust: refunds/voids with an
  in-transaction conservation check, audit append with a hash chain, licence and
  PIN handling. The WebView asks; it does not assert identity. See
  `docs/adr/ADR-001-native-session-principal.md`.
- **Role-bound commands (SEC-01).** Commands are registered with a capability and
  a role policy in `trust_core/ipc_authorizer.rs`; unknown commands are denied.
  Increment 1 makes sync credentials manager-only. Increment 2 adds a hardened
  read-only SQL lane.
- **PINs** are stored as device-local Argon2id envelopes; lockout is enforced
  natively (the lockout map is pruned/bounded so a full keyring cannot silently
  disable it).
- **Technician recovery** no longer ships a secret in the source (it used to be a
  universal backdoor): the install-time secret is provisioned per terminal and the
  lane fails closed until it exists.
- **Data at rest** is not encrypted; the deployment requirement is full-disk
  encryption (`docs/adr/ADR-003-at-rest-residual.md`).
- **Renderer SQL residual** is known and ratcheted: the WebView still holds a
  writable pool until the write migration lands (`docs/adr/ADR-005-role-bound-ipc.md`,
  `scripts/check-sql-boundary.mjs`).

## Secrets

No credentials are stored in the repository. `npm run gate:secrets` scans tracked
files for key blocks, cloud keys, tokens and secret-looking assignments; CI runs it
on every change. Test fixtures use obvious placeholders only.

## Dependency policy

Shipped dependencies must be MIT, Apache-2.0, BSD-family or equivalent permissive
(`npm run gate:licences`, `docs/THIRD_PARTY.md`, `docs/sbom.json`). Development
tooling is never bundled and is listed separately in the SBOM.

## What to include in a bug report about security

State the threat model you used (compromised WebView, cashier, local disk,
malicious peer terminal). The answers differ, and a report that names the model is
triaged in hours instead of days.

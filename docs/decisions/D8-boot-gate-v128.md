# Decision D8 — the boot gate must track the migration list (v128)

- **Status:** fixed; `EXPECTED_MAX_DB_USER_VERSION` 127 → **128**.
- **Owner of the invariant:** `src-tauri/src/lib.rs` — the constant's own doc comment says it *must track the
  largest version in `base_schema_migrations()`*, and startup refuses any DB stamped above it ("contract C6").

## The defect

Migration `version: 128` ("Smart Import: debt origin and source identity crosswalk") shipped in release
`v1.6.9` (`git log -S "128," -- src/lib.rs` → `2193436 chore(release): v1.6.9`) but the constant stayed 127.

Consequences, in order of severity:

1. **A terminal that migrated to 128 would refuse to open its own database on the next launch.** The gate
   reads the header `user_version` (offset 60) and returns "Base SQLite trop récente" for `128 > 127` — a
   self-inflicted boot failure on every upgraded device, offline, at the counter.
2. The test that exists to prevent exactly this (`base_schema_migrations_are_strictly_increasing_and_
   wellformed`) failed on every build since, so the whole `cargo test --lib` target could not go green.

## Evidence (primary sources, accessed 2026-10-31)

1. **SQLite — PRAGMA user_version** <https://sqlite.org/pragma.html#pragma_user_version>. `user_version` is a
   32-bit signed integer stored in the database header (offset 60) that applications use for their own schema
   numbering; it is not interpreted by SQLite. → the app's own list is the authority, and the gate's ceiling
   must be derived from that list, not from a remembered number.
2. **SQLite — database file format, header fields** <https://sqlite.org/fileformat2.html#database_header>.
   Confirms the header field's position/size (the boot gate reads it with `std::fs`, before any connection
   exists, so the value is trustworthy only if the file is a real SQLite database — already asserted by the
   magic check).
3. **The repository itself** is the third, decisive source: the constant's doc comment and the failing test
   both state the contract "constant == max(list)". Two independent expressions of the same invariant (doc +
   executable test) agree that 127 was the defect, not the test.

## Options rejected

- **Relax the test** (allow `max >= constant`): would let a DB newer than the build open silently — the exact
  C6 contract the gate exists to enforce. Rejected.
- **Delete migration 128**: it already shipped in `v1.6.9`; devices carry it. Removing it would leave those
  DBs at 128 with no definition. Rejected.
- **Catch up at boot** (re-stamp user_version): hides drift and rewrites the authority's own marker. Rejected.

## Choice

Bump the constant to 128 (the list is unchanged). The test now proves the two stay in lockstep; any future
migration that forgets the bump fails immediately with a precise message.

## Reversal

Set the constant back to 127. The boot gate then refuses any DB at 128 — i.e. every device upgraded through
`v1.6.9`. That is why this is recorded rather than done silently.

## Related fix in the same commit

`trust_core::export_snapshot::tests::manifest_canonical_bytes_are_stable_golden` pinned `app_version` to
`env!("CARGO_PKG_VERSION")`, so the 1.7.0 release bump broke a test whose subject is **field order and
canonical bytes**, not the version string. The fixture now pins `"1.7.0"` and the golden carries it; a real
serialization change still fails the test, a release bump no longer does.

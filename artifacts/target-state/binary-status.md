# mobi-pos.exe Binary State & Incident Binary Audit

- **Generated (Local):** 2026-10-01T02:53:40+01:00
- **Generated (UTC):** 2026-10-01T01:53:40Z

## Debug Binary (target/debug/mobi-pos.exe)
- **Path:** 	arget\debug\mobi-pos.exe
- **Size:** 31309824 bytes
- **LastWriteTime (Local):** 2026-10-01T02:37:36.3157046+01:00
- **LastWriteTime (UTC):**   2026-10-01T01:37:36.3157046Z
- **SHA-256:** 88d8dce23d7b30002d2d03fc1858ca6f9263b0ccd26f1665d9c01a2b95c3335a
- **Preserved Copy:** rtifacts/target-state/surviving-mobi-pos-debug.exe (SHA-256: 88d8dce23d7b30002d2d03fc1858ca6f9263b0ccd26f1665d9c01a2b95c3335a)

## Release Binary (target/release/mobi-pos.exe)
- **Path:** 	arget\release\mobi-pos.exe
- **Exists:** False
- **Status:** [KNOWN] Absent. No release build of mobi-pos.exe is present in target/release.

## Incident Binary Disposition (~22:13:50 on 2026-09-30)
- **Incident Binary Target Time:** 2026-09-30T22:13:50+01:00 (~21:13:50Z)
- **Status:** [KNOWN] OVERWRITTEN / NOT INTACT.
- **Evidence:** The current file in 	arget/debug/mobi-pos.exe carries mtime 2026-10-01T02:37:36.3157046+01:00, created during the compilation at 02:37:04+01:00. The incident binary compiled at 22:12:20 and launched at 22:13:50 was overwritten in place by subsequent cargo builds prior to preservation.
- **Escalation Reference:** Logged in rtifacts/findings/ESCALATION.md under R7(b).

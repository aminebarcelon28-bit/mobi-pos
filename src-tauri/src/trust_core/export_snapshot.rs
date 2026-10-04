//! Phase 3 — consistent snapshots, copy-side recovery, preflight, manifest.
//!
//! Plain-SQLite export substrate (see `trust_core` topology note: NO libSQL
//! replica exists; `mobi_pos.db` is a single-file WAL database).
//!
//! # Rules enforced here
//! 1. **Consistent snapshot first.** The live DB is read through the SQLite
//!    Online Backup API (`rusqlite::backup`) from a read-only source
//!    connection into a fresh single-file snapshot. The WebView sqlx pool
//!    may be writing concurrently — the backup API tolerates that (bounded
//!    Busy/Locked retries with a deadline). `.db`/`.wal`/`.shm` are NEVER
//!    hand-copied while the pool may write.
//! 2. **Copy-side recovery only.** If the live DB will not open, the
//!    db+WAL set is copied TOGETHER into a temp dir (-shm never copied:
//!    rebuilt from WAL on open), the COPY is opened (read-write permitted:
//!    it is disposable), and `integrity_check` runs on the copy. Recovery
//!    never touches live files: no checkpointing, no `PRAGMA` writes, no
//!    opens beyond read-only backup attempts.
//! 3. **Error classes.** `SQLITE_BUSY_RECOVERY` (261) during backup steps is
//!    transient (bounded retry). `SQLITE_READONLY_RECOVERY` (264) on the
//!    live open means the live needs write recovery — go to the trio-copy
//!    path instead of touching it. Other open failures (corrupt header,
//!    locks) also go trio-copy; integrity failure on the copy is terminal.
//! 4. **Preflight before output.** Required bytes = 2×(db+wal) + margin;
//!    failure yields typed `StorageExhausted` before anything is created.
//! 5. **Atomic output.** Staging dir (`<id>.tmp`) → fsync files → manifest
//!    → rename. `StagingGuard` removes unfinalized staging on drop, so an
//!    interrupted export leaves no partial final directory.
//! 6. **One export at a time.** `try_acquire_export` fails deterministically
//!    while another export runs (also makes stale-tmp cleanup race-free).

use super::ipc_authorizer::TrustError;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// `SQLITE_BUSY_RECOVERY`: another connection is busy recovering WAL —
/// concurrency condition, bounded retry (corrected directive C-01).
pub const SQLITE_BUSY_RECOVERY: i32 = 261;
/// `SQLITE_READONLY_RECOVERY`: recovery needs write access the read-only
/// handle lacks — route to the disposable copy, never the live files.
pub const SQLITE_READONLY_RECOVERY: i32 = 264;

/// Backup pages per step (small enough to yield to live writers).
const BACKUP_PAGES_PER_STEP: i32 = 64;
/// Hard deadline for one snapshot attempt ( writers churn indefinitely).
const BACKUP_DEADLINE: Duration = Duration::from_secs(60);
/// Bounded open retries for transient busy on the live file.
const OPEN_RETRIES: u32 = 5;
const OPEN_RETRY_SLEEP_MS: u64 = 200;

/// Preflight model: snapshot (≈db+wal) + projected CSV (≤ snapshot,
/// conservatively 1×) + fixed margin.
const ESTIMATE_MULTIPLIER: u64 = 2;
const EXPORT_MARGIN_BYTES: u64 = 8 * 1024 * 1024;
/// Floor kept free: streaming quota is `available − reserve`.
const FINAL_RESERVE_BYTES: u64 = 4 * 1024 * 1024;

/// Manifest format version (bump on schema change).
pub const EXPORT_FORMAT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/// Internal snapshot outcome classification. `NeedCopy` (live unopenable)
/// routes to the trio-copy path; `Busy` fails cleanly after the deadline.
#[derive(Debug)]
enum SnapshotFailure {
    NeedCopy,
    Busy(String),
    Fatal(TrustError),
}

impl From<SnapshotFailure> for TrustError {
    fn from(f: SnapshotFailure) -> Self {
        match f {
            SnapshotFailure::NeedCopy => {
                TrustError::op_failed("live database unavailable for snapshot")
            }
            SnapshotFailure::Busy(msg) => TrustError::op_failed(msg),
            SnapshotFailure::Fatal(e) => e,
        }
    }
}

fn extended_code(err: &rusqlite::Error) -> Option<i32> {
    match err {
        rusqlite::Error::SqliteFailure(e, _) => Some(e.extended_code),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Snapshot acquisition
// ---------------------------------------------------------------------------

/// Acquired consistent snapshot. The file lives in `work_dir` (the caller
/// keeps it inside staging so guards clean it up); `from_copy` records
/// whether copy-side recovery was used (reported, never hidden).
#[derive(Debug)]
pub struct AcquiredSnapshot {
    pub path: PathBuf,
    pub from_copy: bool,
}

/// Acquire a consistent single-file snapshot of the live database.
/// Never mutates the live files: read-only opens for backup, trio-copy +
/// copy-side `integrity_check` when the live will not open.
pub fn acquire_snapshot(live_db: &Path, work_dir: &Path) -> Result<AcquiredSnapshot, TrustError> {
    let snap_path = work_dir.join("snapshot.db");
    let _ = std::fs::remove_file(&snap_path);
    match backup_from_live(live_db, &snap_path, BACKUP_PAGES_PER_STEP, BACKUP_DEADLINE) {
        Ok(()) => Ok(AcquiredSnapshot {
            path: snap_path,
            from_copy: false,
        }),
        Err(SnapshotFailure::NeedCopy) => {
            let copy_db = copy_trio_to_temp(live_db, work_dir)?;
            recover_copy_to_snapshot(&copy_db, &snap_path)?;
            Ok(AcquiredSnapshot {
                path: snap_path,
                from_copy: true,
            })
        }
        Err(SnapshotFailure::Busy(msg)) => Err(TrustError::op_failed(msg)),
        Err(SnapshotFailure::Fatal(e)) => Err(e),
    }
}

/// Online backup from the live read-only source into `dst`.
fn backup_from_live(
    live_db: &Path,
    dst: &Path,
    pages_per_step: i32,
    deadline: Duration,
) -> Result<(), SnapshotFailure> {
    let src = open_live_ro(live_db)?;
    let mut out = Connection::open(dst)
        .map_err(|e| SnapshotFailure::Fatal(TrustError::op_failed(format!("snapshot create: {e}"))))?;
    backup_with_deadline(&src, &mut out, pages_per_step, deadline)?;
    drop(out);
    fsync_file(dst).map_err(SnapshotFailure::Fatal)?;
    Ok(())
}

/// Open the live DB strictly read-only, with bounded busy retries.
/// 264 (read-only recovery) and any other open failure route to the copy
/// path — the live files are never opened read-write here.
fn open_live_ro(live_db: &Path) -> Result<Connection, SnapshotFailure> {
    let flags =
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut last_err = String::new();
    for _ in 0..OPEN_RETRIES {
        match Connection::open_with_flags(live_db, flags) {
            Ok(conn) => {
                if let Err(e) = conn.busy_timeout(Duration::from_millis(1500)) {
                    return Err(SnapshotFailure::Fatal(TrustError::op_failed(format!(
                        "snapshot busy_timeout: {e}"
                    ))));
                }
                // SQLite opens lazily: force header validation now so a
                // corrupt file fails fast into the copy path instead of
                // mid-backup. Any failure here routes to recovery.
                if conn
                    .query_row("PRAGMA schema_version;", [], |r| r.get::<_, i64>(0))
                    .is_err()
                {
                    return Err(SnapshotFailure::NeedCopy);
                }
                return Ok(conn);
            }
            Err(e) => {
                match extended_code(&e) {
                    Some(SQLITE_READONLY_RECOVERY) => return Err(SnapshotFailure::NeedCopy),
                    Some(SQLITE_BUSY_RECOVERY) => {
                        last_err = e.to_string();
                        std::thread::sleep(Duration::from_millis(OPEN_RETRY_SLEEP_MS));
                    }
                    _ => return Err(SnapshotFailure::NeedCopy),
                }
            }
        }
    }
    Err(SnapshotFailure::Busy(format!(
        "live database busy, snapshot deadline suspected ({last_err})"
    )))
}

/// Stepped online backup with a hard deadline. Busy/Locked steps back off;
/// anything else aborts immediately.
fn backup_with_deadline(
    src: &Connection,
    dst: &mut Connection,
    pages_per_step: i32,
    deadline: Duration,
) -> Result<(), SnapshotFailure> {
    use rusqlite::backup::StepResult;
    let backup = rusqlite::backup::Backup::new(src, dst)
        .map_err(|e| SnapshotFailure::Fatal(TrustError::op_failed(format!("backup init: {e}"))))?;
    let start = Instant::now();
    let mut backoff = Duration::from_millis(20);
    loop {
        if start.elapsed() > deadline {
            return Err(SnapshotFailure::Busy(
                "snapshot busy deadline exceeded while writers churn; retry the export".into(),
            ));
        }
        match backup.step(pages_per_step) {
            Ok(StepResult::Done) => return Ok(()),
            Ok(StepResult::More) => {
                backoff = Duration::from_millis(5);
            }
            Ok(StepResult::Busy) | Ok(StepResult::Locked) => {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            // StepResult is #[non_exhaustive]: unknown future successes are
            // retried transiently; the hard deadline above bounds the loop.
            Ok(_) => {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            Err(e) => {
                return Err(SnapshotFailure::Fatal(TrustError::op_failed(format!(
                    "backup step: {e}"
                ))))
            }
        }
    }
}

/// Copy attempts for a churning WAL before failing typed (spurious failure
/// is acceptable; silent inconsistency is not).
const COPY_RETRIES: u32 = 3;
const COPY_RETRY_SLEEP_MS: u64 = 50;

/// Copy db + WAL (+rollback-journal if present) TOGETHER into `work_dir`.
///
/// - `-shm` is deliberately NOT copied: SQLite rebuilds the shared-memory
///   index from the WAL on open; copying it risks stale index pointers
///   (same rule as the backup commands in `lib.rs`).
/// - Order: db first, WAL immediately after, as close together as possible.
/// - The WAL fingerprint (size + 32-byte header incl. magic) is re-checked
///   after the copy; on change the whole set is recopied, bounded by
///   `COPY_RETRIES`, then typed failure. A missing WAL needs no re-check
///   (checkpointed/empty WAL is consistent by construction).
fn copy_trio_to_temp(live_db: &Path, work_dir: &Path) -> Result<PathBuf, TrustError> {
    std::fs::create_dir_all(work_dir)
        .map_err(|e| TrustError::op_failed(format!("recovery staging: {e}")))?;
    let stem = live_db
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mobi_pos.db".into());
    let dst_db = work_dir.join(format!("recovery_{stem}"));
    let wal_src = PathBuf::from(format!("{}-wal", live_db.display()));
    let wal_dst = PathBuf::from(format!("{}-wal", dst_db.display()));

    for _ in 0..COPY_RETRIES {
        // 1. DB first.
        std::fs::copy(live_db, &dst_db)
            .map_err(|e| TrustError::op_failed(format!("recovery copy (db): {e}")))?;
        fsync_file(&dst_db)?;
        // 2. WAL immediately after, with a before-fingerprint.
        let before = wal_fingerprint(&wal_src);
        if PathBuf::from(wal_src.display().to_string()).exists() {
            std::fs::copy(&wal_src, &wal_dst)
                .map_err(|e| TrustError::op_failed(format!("recovery copy (-wal): {e}")))?;
            fsync_file(&wal_dst)?;
        } else {
            let _ = std::fs::remove_file(&wal_dst);
        }
        // 3. Re-check: same WAL fingerprint after the copy?
        if wal_fingerprint(&wal_src) == before {
            // Rollback-journal (non-WAL moments) best-effort, no re-check:
            // it is transient by design and integrity_check is authoritative.
            let journal_src = PathBuf::from(format!("{}-journal", live_db.display()));
            if journal_src.exists() {
                let journal_dst = PathBuf::from(format!("{}-journal", dst_db.display()));
                let _ = std::fs::copy(&journal_src, &journal_dst);
            }
            return Ok(dst_db);
        }
        std::thread::sleep(Duration::from_millis(COPY_RETRY_SLEEP_MS));
    }
    Err(TrustError::op_failed(
        "recovery copy unstable (WAL churning under copy); retry the export".to_string(),
    ))
}

/// WAL identity fingerprint: (size, first-32-bytes incl. magic). `None`
/// when absent (checkpointed) — stable by construction, no retry needed.
fn wal_fingerprint(wal: &Path) -> Option<(u64, [u8; 32])> {
    let meta = std::fs::metadata(wal).ok()?;
    if meta.len() == 0 {
        return Some((0, [0u8; 32]));
    }
    let bytes = std::fs::read(wal).ok()?;
    let mut magic = [0u8; 32];
    let n = bytes.len().min(32);
    magic[..n].copy_from_slice(&bytes[..n]);
    Some((meta.len(), magic))
}

/// Open the disposable copy (read-write permitted: SQLite may need it for
/// WAL rollback on a copy that crashed mid-transaction), verify
/// `integrity_check` on the COPY, then back the copy up into a clean
/// single-file snapshot. Live files are never involved past the byte copy.
fn recover_copy_to_snapshot(copy_db: &Path, snapshot_dst: &Path) -> Result<(), TrustError> {
    let copy = Connection::open(copy_db)
        .map_err(|e| TrustError::op_failed(format!("recovery open (copy): {e}")))?;
    copy.busy_timeout(Duration::from_secs(5))
        .map_err(|e| TrustError::op_failed(format!("recovery busy_timeout: {e}")))?;
    integrity_check(&copy).map_err(|e| {
        TrustError::op_failed(format!("recovery integrity_check failed on copy (live untouched): {e}"))
    })?;
    let mut out = Connection::open(snapshot_dst)
        .map_err(|e| TrustError::op_failed(format!("snapshot create: {e}")))?;
    backup_with_deadline(&copy, &mut out, BACKUP_PAGES_PER_STEP, BACKUP_DEADLINE)?;
    drop(copy);
    drop(out);
    fsync_file(snapshot_dst)?;
    // Best-effort removal of the disposable set (staging guard covers rest;
    // -shm is listed defensively though never copied).
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}{suffix}", copy_db.display())));
    }
    Ok(())
}

/// `PRAGMA integrity_check` must return exactly one row: `ok`.
pub fn integrity_check(conn: &Connection) -> Result<(), TrustError> {
    let mut stmt = conn
        .prepare("PRAGMA integrity_check;")
        .map_err(|e| TrustError::op_failed(format!("integrity_check prepare: {e}")))?;
    let rows: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| TrustError::op_failed(format!("integrity_check read: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| TrustError::op_failed(format!("integrity_check decode: {e}")))?;
    if rows.len() == 1 && rows[0].to_lowercase() == "ok" {
        Ok(())
    } else {
        Err(TrustError::op_failed(format!(
            "integrity_check failed: {}",
            rows.join(" | ").chars().take(300).collect::<String>()
        )))
    }
}

/// Open a finished snapshot strictly read-only for extraction.
pub fn open_snapshot_ro(snapshot: &Path) -> Result<Connection, TrustError> {
    let conn = Connection::open_with_flags(
        snapshot,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| TrustError::op_failed(format!("snapshot open: {e}")))?;
    conn.execute_batch("PRAGMA query_only = ON;")
        .map_err(|e| TrustError::op_failed(format!("snapshot query_only: {e}")))?;
    Ok(conn)
}

fn fsync_file(path: &Path) -> Result<(), TrustError> {
    // NOTE: opened read+write deliberately — Windows FlushFileBuffers
    // requires GENERIC_WRITE (a read-only handle fails with EACCES), while
    // Unix fsync works on any fd. No bytes are written through this handle.
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| TrustError::op_failed(format!("fsync open ({}): {e}", path.display())))?;
    f.sync_all()
        .map_err(|e| TrustError::op_failed(format!("fsync ({}): {e}", path.display())))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage preflight
// ---------------------------------------------------------------------------

/// Bytes free on the filesystem containing `dir`.
pub fn dir_available_bytes(dir: &Path) -> Result<u64, TrustError> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::mem::MaybeUninit;
        let c = CString::new(dir.as_os_str().as_encoded_bytes()).map_err(|_| {
            TrustError::op_failed("preflight path encoding".to_string())
        })?;
        let mut st = MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: valid out-pointer; statvfs is async-signal-safe sync syscall.
        let rc = unsafe { libc::statvfs(c.as_ptr(), st.as_mut_ptr()) };
        if rc != 0 {
            return Err(TrustError::op_failed("preflight statvfs failed".to_string()));
        }
        let st = unsafe { st.assume_init() };
        Ok((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free: u64 = 0;
        // SAFETY: wide is NUL-terminated; out-pointer valid. (0.59 takes
        // raw *mut u64 out-params and returns BOOL.)
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(TrustError::op_failed("preflight disk-space query failed".to_string()));
        }
        Ok(free)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = dir;
        // Unknown platform: cannot measure — proceed (streaming quota still
        // guards), documented in the report.
        Ok(u64::MAX)
    }
}

/// Required bytes for an export of a (db+wal)-sized source.
pub fn estimate_required_bytes(db_len: u64, wal_len: u64) -> u64 {
    (db_len.saturating_add(wal_len))
        .saturating_mul(ESTIMATE_MULTIPLIER)
        .saturating_add(EXPORT_MARGIN_BYTES)
}

/// Pure budget check (unit-testable without disk pressure).
pub fn ensure_space(available_bytes: u64, required_bytes: u64) -> Result<(), TrustError> {
    if available_bytes >= required_bytes {
        Ok(())
    } else {
        Err(TrustError::StorageExhausted {
            detail: format!(
                "Espace insuffisant pour l'export: {available_bytes} octets libres, {required_bytes} requis."
            ),
        })
    }
}

/// Free-space probe seam (A6): the OS implementation runs in production;
/// fakes run on the host test suite (mobile branches compile but are NOT
/// verified on-device — no Android/iOS CI).
pub trait SpaceProbe {
    fn available_bytes(&self, dir: &Path) -> Result<u64, TrustError>;
}

/// Production probe: real per-OS syscalls (`statvfs` on Unix incl.
/// Android/iOS, `GetDiskFreeSpaceExW` on Windows).
pub struct OsSpaceProbe;

impl SpaceProbe for OsSpaceProbe {
    fn available_bytes(&self, dir: &Path) -> Result<u64, TrustError> {
        dir_available_bytes(dir)
    }
}

/// Pure path construction for one export (unit-testable on any host).
/// Returns `(staging_dir (<id>.tmp), final_dir (<id>))`.
pub fn staging_paths(exports_root: &Path, export_id: &str) -> (PathBuf, PathBuf) {
    (
        exports_root.join(format!("{export_id}.tmp")),
        exports_root.join(export_id),
    )
}

/// Preflight against the live files. Returns the streaming byte quota
/// (`available − reserve`). Fails with typed `StorageExhausted` before any
/// output is created.
pub fn check_preflight(parent_dir: &Path, live_db: &Path) -> Result<u64, TrustError> {
    check_preflight_with(&OsSpaceProbe, parent_dir, live_db)
}

/// Preflight with an injectable probe (host tests use fakes; mobile OS
/// branches are compiled but not executed here).
pub fn check_preflight_with(
    probe: &dyn SpaceProbe,
    parent_dir: &Path,
    live_db: &Path,
) -> Result<u64, TrustError> {
    let db_len = std::fs::metadata(live_db)
        .map_err(|e| TrustError::op_failed(format!("export source introuvable: {e}")))?
        .len();
    let wal_len = std::fs::metadata(PathBuf::from(format!("{}-wal", live_db.display())))
        .map(|m| m.len())
        .unwrap_or(0);
    let required = estimate_required_bytes(db_len, wal_len);
    let available = probe.available_bytes(parent_dir)?;
    ensure_space(available, required)?;
    Ok(available.saturating_sub(FINAL_RESERVE_BYTES))
}

// ---------------------------------------------------------------------------
// Atomic output + manifest
// ---------------------------------------------------------------------------

/// Guard: removes the staging dir on drop unless finalized. An interrupted
/// export therefore never leaves a partial FINAL directory.
pub struct StagingGuard {
    path: Option<PathBuf>,
}

impl StagingGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    pub fn path(&self) -> &Path {
        self.path.as_ref().expect("staging path taken")
    }

    /// Mark finalized (rename already done) — drop becomes a no-op.
    pub fn finalized(mut self) {
        self.path = None;
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

/// Remove stale `<id>.tmp` staging dirs (called with the export mutex held,
/// so no live export can race it).
pub fn cleanup_stale_staging(parent_dir: &Path) {
    let entries = match std::fs::read_dir(parent_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir()
            && p.extension().and_then(|e| e.to_str()) == Some("tmp")
            && p.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.starts_with("export_"))
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

static EXPORT_MUTEX: Mutex<()> = Mutex::new(());

/// Deterministic single-export ownership, in-process AND cross-process.
///
/// Layer 1 (this process): `EXPORT_MUTEX` try-lock.
/// Layer 2 (other processes): advisory exclusive lock on
/// `<exports_root>/export.lock`, non-blocking. There is NO single-instance
/// guarantee in this app (verified: no single-instance plugin/guards in
/// `src-tauri`), so two OS processes (installed + dev build, two sessions)
/// can genuinely run concurrently. Unique staging dirs already prevent
/// corruption, but without this lock a peer's `cleanup_stale_staging` could
/// delete a live export's staging mid-run.
///
/// OS advisory locks release automatically on process death, so a crashed
/// exporter can never leave a stale lock behind. Both layers report the same
/// deterministic busy error.
pub struct ExportOwnership {
    _thread: std::sync::MutexGuard<'static, ()>,
    _proc: ProcessExportLock,
}

impl std::fmt::Debug for ExportOwnership {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ExportOwnership(..)")
    }
}

/// Acquire full export ownership (file lock first, then thread mutex —
/// single acquisition site, so no lock-order inversion is possible).
pub fn try_acquire_export(exports_root: &Path) -> Result<ExportOwnership, TrustError> {
    let proc = ProcessExportLock::try_acquire(exports_root)?;
    let thread = EXPORT_MUTEX.try_lock().map_err(|_| busy_error())?;
    Ok(ExportOwnership {
        _thread: thread,
        _proc: proc,
    })
}

fn busy_error() -> TrustError {
    TrustError::op_failed("Un export d'urgence est déjà en cours.".to_string())
}

/// Held open lock file; dropping closes the handle, which releases the OS
/// advisory lock on every platform (no stale locks after a crash).
pub struct ProcessExportLock {
    _file: std::fs::File,
}

impl ProcessExportLock {
    pub fn lock_path(exports_root: &Path) -> PathBuf {
        // App-private storage on every target: `exports_root` always lives
        // under Tauri's app_data_dir (OS app-data dir on desktop, internal
        // app storage on Android, sandbox container on iOS). The advisory
        // lock is therefore only meaningful between this app's own
        // processes — which is exactly the threat (two running instances).
        // Mobile branches are compiled but NOT verified on-device (gate).
        exports_root.join("export.lock")
    }

    pub fn try_acquire(exports_root: &Path) -> Result<Self, TrustError> {
        let path = Self::lock_path(exports_root);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| TrustError::op_failed(format!("export lock open: {e}")))?;
        try_lock_exclusive(&file)?;
        Ok(Self { _file: file })
    }
}

#[cfg(windows)]
impl Drop for ProcessExportLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
        use windows_sys::Win32::System::IO::OVERLAPPED;
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        unsafe {
            UnlockFileEx(
                self._file.as_raw_handle() as _,
                0,
                0xFFFFFFFF,
                0xFFFFFFFF,
                &mut ov,
            );
        }
    }
}

/// Non-blocking exclusive lock; failure means a live peer exporter.
fn try_lock_exclusive(file: &std::fs::File) -> Result<(), TrustError> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: fd valid; flock with NB never blocks.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(busy_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        use windows_sys::Win32::System::IO::OVERLAPPED;
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        // SAFETY: handle valid; zeroed OVERLAPPED with immediate-fail never blocks.
        let ok = unsafe {
            LockFileEx(
                file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                0xFFFFFFFF,
                0xFFFFFFFF,
                &mut ov,
            )
        };
        if ok == 0 {
            return Err(busy_error());
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Unknown platform: no advisory-lock primitive wired — the
        // in-process mutex still holds. Documented in the report.
        let _ = file;
        Ok(())
    }
}

/// One file row of the external manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ManifestFileEntry {
    pub table: String,
    pub file_name: String,
    pub row_count: u64,
    pub byte_len: u64,
    pub sha256: String,
}

/// External export manifest (stored OUTSIDE the DB as `manifest.json`).
/// The operational DB may be full/locked/read-only, so this file — not a DB
/// audit row — is the authoritative export receipt.
///
/// Authenticity: `manifest_mac` is an HMAC-SHA256 over the canonical
/// (compact-JSON, mac-field-absent) manifest bytes, keyed by the trust MAC
/// key. Hashes detect corruption; the MAC detects tampering (including a
/// recomputed-hash forgery, which the forger cannot re-MAC without the key).
/// When no key is available the MAC is `None` and `mac_status` records why —
/// a missing MAC is never faked.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManifestDoc {
    pub export_format_version: u32,
    pub export_id: String,
    pub app_version: String,
    pub license_state: String,
    /// Integrity posture at export: `"clean"`, `"tamper"`, or `"clock"`.
    /// MAC-covered (inside the canonical bytes): it cannot be stripped or
    /// downgraded to clean without failing verification. A verifier shows
    /// non-clean exports as flagged (recovery-only, never evidence).
    pub integrity_state: String,
    /// Audit-chain posture at export: `"intact"`, `"broken"`, or
    /// `"unsealed"`. MAC-covered like everything else in this doc.
    pub chain_status: String,
    pub files: Vec<ManifestFileEntry>,
    pub total_rows: u64,
    pub total_bytes: u64,
    /// SHA-256 over the concatenation of per-file hashes (deterministic,
    /// verifiable without re-reading the CSVs — though verifiers SHOULD).
    pub export_sha256: String,
    /// Trusted-time anchor at export: EVIDENCE ONLY, never authority.
    pub trusted_wall_utc_ms: Option<u64>,
    pub trusted_server_utc_ms: Option<u64>,
    pub exported_at: String,
    /// Audit-row outcome: success id, or the failure text when the DB could
    /// not accept another row. Failure never blocks the export.
    pub audit_event_id: Option<String>,
    pub audit_error: Option<String>,
    /// `"hmac-sha256"` or `"no-key:<reason>"` — never faked.
    pub mac_status: String,
    /// HMAC-SHA256 over the canonical bytes (this field absent during MAC).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_mac: Option<String>,
}

/// MAC material for manifest sealing: either the key or a recorded reason.
/// There is no third option — callers cannot invent a MAC.
pub enum ManifestMac {
    Key(Vec<u8>),
    Unavailable(String),
}

/// Resolve the manifest-sealing key through the trust keystore path
/// (`resolve_mac_key`, prior state implied: export authorization already
/// proved state exists). Store selection duplicates the kernel's desktop/
/// mobile rule (see `ipc_authorizer::select_store` — kept local by the
/// Phase 3.1 file-scope rule; the canonical implementation stays there).
pub fn resolve_manifest_mac_key(app_data_dir: &Path) -> ManifestMac {
    use super::secure_storage as ss;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let store: Box<dyn ss::KeyStore> =
        Box::new(ss::FileKeyStore::new(ss::FileKeyStore::default_path(app_data_dir)));
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let store: Box<dyn ss::KeyStore> = Box::new(ss::OsKeyStore);
    let path = ss::snapshot_path(app_data_dir);
    let counter_hint = store.load_counter().ok().flatten();
    let prior = path.exists() || counter_hint.is_some();
    match ss::resolve_mac_key(&*store, prior) {
        ss::KeyResolution::Active { key, .. } => ManifestMac::Key(key),
        ss::KeyResolution::ProvisionOnFirstPersist => {
            ManifestMac::Unavailable("no-key:store-empty-during-export".into())
        }
        ss::KeyResolution::QuarantineNoKey => {
            ManifestMac::Unavailable("no-key:keystore-unavailable".into())
        }
    }
}

/// Canonical bytes for MAC: compact JSON of the doc with `manifest_mac`
/// absent. Deterministic (struct field order, no whitespace variance).
fn manifest_canonical_bytes(doc: &ManifestDoc) -> Vec<u8> {
    let mut unsigned = doc.clone();
    unsigned.manifest_mac = None;
    serde_json::to_vec(&unsigned).unwrap_or_default()
}

/// Map a native license state code to the manifest integrity posture.
/// Only the two quarantine states flag; everything else (including unknown
/// future codes, fail-closed direction) is recorded as flagged, never
/// clean — `"clean"` requires an exact match.
pub fn integrity_state_for_license(code: &str) -> &'static str {
    match code {
        "TAMPER_SUSPECTED" => "tamper",
        "CLOCK_RESET_REQUIRED" => "clock",
        "OPERATIONAL" | "EXPIRED" | "GRACE_EXCEEDED" | "SUSPENDED" | "UNACTIVATED" => "clean",
        _ => "tamper",
    }
}

/// Input assembled by the export command.
pub struct ManifestInput {
    pub export_id: String,
    pub license_state: String,
    /// See `ManifestDoc::integrity_state`. Computed by the caller from the
    /// native license code via [`integrity_state_for_license`].
    pub integrity_state: String,
    /// Audit-chain status string for the manifest (see `chain_state_value`).
    pub chain_status: String,
    pub files: Vec<ManifestFileEntry>,
    pub trusted_wall_utc_ms: Option<u64>,
    pub trusted_server_utc_ms: Option<u64>,
    pub exported_at: String,
    pub audit_event_id: Option<String>,
    pub audit_error: Option<String>,
    pub mac: ManifestMac,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA256 (RFC 2104) built on the existing `sha2` dependency.
/// Deliberate choice, stated: the `hmac` crate would add a dependency (and
/// its transitive surface) for ~20 lines of textbook construction over an
/// already-audited hash. If `hmac`/`sha2` ever enter the tree for other
/// reasons, prefer them and delete this.
/// Raw HMAC-SHA256 bytes (shared with audit chaining).
pub(crate) fn hmac_sha256_raw(key: &[u8], msg: &[u8]) -> Vec<u8> {    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut h = Sha256::new();
        h.update(key);
        let d: Vec<u8> = h.finalize().to_vec();
        k[..d.len()].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (ipad, opad): (Vec<u8>, Vec<u8>) = (
        k.iter().map(|b| b ^ 0x36).collect(),
        k.iter().map(|b| b ^ 0x5c).collect(),
    );
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg);
    let inner_digest: Vec<u8> = inner.finalize().to_vec();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_digest);
    outer.finalize().to_vec()
}

fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    hmac_sha256_raw(key, msg)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Manifest sealing sub-key: `HMAC(master, "MOBI-MANIFEST-V1")` (raw bytes).
/// The trust MAC key is NEVER used raw for manifests — purpose separation is
/// cheap (this function) and prevents a manifest MAC from being replayable
/// in any other protocol keyed by the master, and vice versa.
fn manifest_subkey(master: &[u8]) -> Vec<u8> {
    domain_subkey(master, b"MOBI-MANIFEST-V1")
}

/// General purpose-separated sub-key derivation shared by trust protocols
/// (manifest sealing, audit chaining). One master, one label, one purpose.
pub(crate) fn domain_subkey(master: &[u8], label: &[u8]) -> Vec<u8> {
    hmac_sha256_raw(master, label)
}

/// Constant-time-ish equality for MAC comparison (shared with audit chain).
pub(crate) fn mac_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Write + fsync `manifest.json` into the staging dir. Returns its path.
/// I/O and encoding failures map to typed `ExportManifestFailed` (distinct
/// from storage/quota errors): output without evidence is refused so the
/// caller can fix the cause and retry.
pub fn write_manifest(staging_dir: &Path, input: ManifestInput) -> Result<PathBuf, TrustError> {
    let joined: String = input.files.iter().map(|f| f.sha256.as_str()).collect();
    let unsigned = ManifestDoc {
        export_format_version: EXPORT_FORMAT_VERSION,
        export_id: input.export_id.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        license_state: input.license_state.clone(),
        integrity_state: input.integrity_state.clone(),
        chain_status: input.chain_status.clone(),
        files: input.files.clone(),
        total_rows: input.files.iter().map(|f| f.row_count).sum(),
        total_bytes: input.files.iter().map(|f| f.byte_len).sum(),
        export_sha256: sha256_hex(joined.as_bytes()),
        trusted_wall_utc_ms: input.trusted_wall_utc_ms,
        trusted_server_utc_ms: input.trusted_server_utc_ms,
        exported_at: input.exported_at.clone(),
        audit_event_id: input.audit_event_id.clone(),
        audit_error: input.audit_error.clone(),
        mac_status: match &input.mac {
            ManifestMac::Key(_) => "hmac-sha256".to_string(),
            ManifestMac::Unavailable(reason) => format!("no-key:{reason}"),
        },
        manifest_mac: None,
    };
    // MAC the canonical bytes with the DERIVED sub-key (never the raw
    // master — see manifest_subkey).
    let mut doc = unsigned;
    if let ManifestMac::Key(master) = &input.mac {
        doc.manifest_mac = Some(hmac_sha256_hex(
            &manifest_subkey(master),
            &manifest_canonical_bytes(&doc),
        ));
    }
    let path = staging_dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&doc).map_err(|e| {
        TrustError::ExportManifestFailed {
            detail: format!("manifest encode impossible: {e}"),
        }
    })?;
    std::fs::write(&path, json).map_err(|e| TrustError::ExportManifestFailed {
        detail: format!(
            "manifest write impossible (disque plein ou erreur d'écriture — libérez de l'espace puis réessayez): {e}"
        ),
    })?;
    fsync_file(&path).map_err(|e| TrustError::ExportManifestFailed {
        detail: format!("manifest fsync impossible: {e}"),
    })?;
    Ok(path)
}

/// Verifier outcome (owner policy, stated on the enum — the closest thing to
/// a policy doc in scope, mirrored in the final report):
/// - `VerifiedClean`: MAC valid and `integrity_state == "clean"`. May be
///   shown as verified.
/// - `Flagged`: MAC valid but `integrity_state` is `"tamper"`/`"clock"` (or
///   any unknown value — flag on doubt). Shown as flagged, NEVER as clean.
/// - `Unauthenticated`: no MAC was recorded (hashes still passed). Usable
///   for DATA RECOVERY ONLY — never evidence for disputes, audits, license
///   or compliance decisions, because anyone can strip `manifest_mac` and
///   edit the file. The UI must never show it as verified.
/// - `Err`: hashes fail (corrupt) or a recorded MAC fails (tamper) — hard
///   failure in both cases, never a warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    VerifiedClean { files: usize },
    Flagged { files: usize, integrity_state: String },
    Unauthenticated { files: usize },
}

/// Rich verification: authenticity + integrity + posture in one call.
/// `mac_key` is `Some` when the verifier holds the trust key; `None` means
/// hash-only verification (corruption detected, authenticity unjudged).
pub fn verify_manifest_status(
    export_dir: &Path,
    mac_key: Option<&[u8]>,
) -> Result<VerifyOutcome, TrustError> {
    let raw = std::fs::read_to_string(export_dir.join("manifest.json"))
        .map_err(|e| TrustError::op_failed(format!("manifest read: {e}")))?;
    let doc: ManifestDoc = serde_json::from_str(&raw)
        .map_err(|e| TrustError::op_failed(format!("manifest parse: {e}")))?;
    // Hashes first: corruption fails everything regardless of MAC.
    let files = verify_manifest(export_dir)?;
    match (doc.manifest_mac.as_deref(), mac_key) {
        (Some(stored), Some(key)) => {
            let expected = hmac_sha256_hex(
                &manifest_subkey(key),
                &manifest_canonical_bytes(&doc),
            );
            if !mac_eq(stored, &expected) {
                return Err(TrustError::op_failed(
                    "manifest MAC invalide: falsification détectée".to_string(),
                ));
            }
            if doc.integrity_state == "clean" {
                Ok(VerifyOutcome::VerifiedClean { files })
            } else {
                Ok(VerifyOutcome::Flagged {
                    files,
                    integrity_state: doc.integrity_state.clone(),
                })
            }
        }
        (Some(_), None) => Err(TrustError::op_failed(
            "manifest authentifié mais aucune clé de vérification fournie".to_string(),
        )),
        (None, _) => Ok(VerifyOutcome::Unauthenticated { files }),
    }
}

/// Verify a finalized export (hashes only): re-hash every CSV, compare
/// per-file and top-level digests. Returns the verified file count.
/// This detects corruption, NOT tampering — use
/// [`verify_manifest_status`] with the trust key for authenticity.
pub fn verify_manifest(export_dir: &Path) -> Result<usize, TrustError> {
    let raw = std::fs::read_to_string(export_dir.join("manifest.json"))
        .map_err(|e| TrustError::op_failed(format!("manifest read: {e}")))?;
    let doc: ManifestDoc = serde_json::from_str(&raw)
        .map_err(|e| TrustError::op_failed(format!("manifest parse: {e}")))?;
    if doc.export_format_version != EXPORT_FORMAT_VERSION {
        return Err(TrustError::op_failed(format!(
            "manifest version {} non supportée",
            doc.export_format_version
        )));
    }
    for f in &doc.files {
        let bytes = std::fs::read(export_dir.join(&f.file_name))
            .map_err(|e| TrustError::op_failed(format!("verify read {}: {e}", f.file_name)))?;
        let actual = sha256_hex(&bytes);
        if actual != f.sha256 {
            return Err(TrustError::op_failed(format!(
                "intégrité rompue: {} (attendu {}, calculé {})",
                f.file_name, f.sha256, actual
            )));
        }
        if bytes.len() as u64 != f.byte_len {
            return Err(TrustError::op_failed(format!(
                "taille incohérente: {}",
                f.file_name
            )));
        }
    }
    let joined: String = doc.files.iter().map(|f| f.sha256.as_str()).collect();
    if sha256_hex(joined.as_bytes()) != doc.export_sha256 {
        return Err(TrustError::op_failed("export_sha256 incohérent".to_string()));
    }
    Ok(doc.files.len())
}

/// Strict verification WITH authenticity: checks the HMAC first (fails on
/// any 1-byte change AND on recomputed-hash forgery), then the hash chain.
/// Returns the verified file count for authentic exports — clean AND
/// flagged alike (flagged exports are authentic records of a quarantined
/// terminal; posture is reported via [`verify_manifest_status`]).
/// A manifest recorded without MAC fails here with a distinct message —
/// absence is reported, never faked or waved through.
pub fn verify_manifest_with_key(export_dir: &Path, mac_key: &[u8]) -> Result<usize, TrustError> {
    match verify_manifest_status(export_dir, Some(mac_key))? {
        VerifyOutcome::VerifiedClean { files } | VerifyOutcome::Flagged { files, .. } => Ok(files),
        VerifyOutcome::Unauthenticated { .. } => Err(TrustError::op_failed(
            "manifest non authentifié; hachages seuls vérifiables".to_string(),
        )),
    }
}

/// Atomic finalization: rename staging → final (same filesystem: the staging
/// dir is created under the final parent). fsync the parent best-effort.
pub fn finalize_export_dir(staging_dir: &Path, final_dir: &Path) -> Result<(), TrustError> {
    if final_dir.exists() {
        return Err(TrustError::op_failed("destination d'export déjà existante".to_string()));
    }
    std::fs::rename(staging_dir, final_dir)
        .map_err(|e| TrustError::op_failed(format!("finalisation impossible: {e}")))?;
    if let Some(parent) = final_dir.parent() {
        fsync_dir(parent)?;
    }
    Ok(())
}

/// fsync a directory handle so entries created/renamed inside it are
/// durable across power loss. Unix (Linux, macOS, Android, iOS): real
/// fsync on the dir fd. Windows: NO user-space equivalent exists —
/// directory handles cannot be flushed (NTFS journals metadata instead),
/// so this is a documented no-op returning Ok.
pub fn fsync_dir(path: &Path) -> Result<(), TrustError> {
    #[cfg(unix)]
    {
        let f = std::fs::File::open(path).map_err(|e| {
            TrustError::op_failed(format!("dir fsync open ({}): {e}", path.display()))
        })?;
        f.sync_all().map_err(|e| {
            TrustError::op_failed(format!("dir fsync ({}): {e}", path.display()))
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;
    use rusqlite::params;

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("mobi-snap-test-{tag}-{nanos}-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixture_db(path: &Path, rows: u64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);")
            .unwrap();
        for i in 0..rows {
            conn.execute("INSERT INTO t(v) VALUES (?1)", params![format!("row-{i}")])
                .unwrap();
        }
        // Leave WAL content un-checkpointed to prove WAL-aware reads.
        drop(conn);
    }

    fn count_rows(path: &Path) -> u64 {
        let conn = open_snapshot_ro(path).unwrap();
        conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, u64>(0))
            .unwrap()
    }

    #[test]
    fn backup_snapshot_is_consistent() {
        let dir = tmpdir("basic");
        let live = dir.join("live.db");
        fixture_db(&live, 50);
        let snap = dir.join("snap.db");
        backup_from_live(&live, &snap, 64, Duration::from_secs(30)).unwrap();
        assert_eq!(count_rows(&snap), 50);
        integrity_check(&open_snapshot_ro(&snap).unwrap()).unwrap();
    }

    #[test]
    fn concurrent_writer_during_snapshot() {
        let dir = tmpdir("race");
        let live = dir.join("live.db");
        fixture_db(&live, 20);
        // Writer churns the live DB while the snapshot crawls one page/step.
        let writer_path = live.clone();
        let handle = std::thread::spawn(move || {
            let conn = Connection::open(&writer_path).unwrap();
            conn.busy_timeout(Duration::from_secs(10)).unwrap();
            for i in 0..200u64 {
                let _ = conn.execute("INSERT INTO t(v) VALUES (?1)", params![format!("w-{i}")]);
            }
        });
        let snap = dir.join("snap.db");
        backup_from_live(&live, &snap, 1, Duration::from_secs(60)).unwrap();
        handle.join().unwrap();
        let snap_rows = count_rows(&snap);
        let live_rows = {
            let c = Connection::open(&live).unwrap();
            c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, u64>(0)).unwrap()
        };
        // Snapshot is a valid prefix view: never more than live, integrity ok.
        assert!(snap_rows <= live_rows, "snapshot {snap_rows} vs live {live_rows}");
        integrity_check(&open_snapshot_ro(&snap).unwrap()).unwrap();
    }

    #[test]
    fn corrupted_live_routes_to_copy_then_fails_typed_without_touching_live() {
        let dir = tmpdir("corrupt");
        let live = dir.join("live.db");
        fixture_db(&live, 10);
        // Corrupt the header magic in place.
        let mut raw = std::fs::read(&live).unwrap();
        raw[0] = 0x00;
        std::fs::write(&live, &raw).unwrap();
        let corrupted_bytes = std::fs::read(&live).unwrap();

        let snap = dir.join("snap.db");
        let err = backup_from_live(&live, &snap, 64, Duration::from_secs(10)).unwrap_err();
        assert!(matches!(err, SnapshotFailure::NeedCopy));
        // Full acquire path: trio copy → integrity fails → typed error.
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let err = acquire_snapshot(&live, &work).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("integrity") || msg.contains("recovery"),
            "typed recovery failure, got: {msg}"
        );
        // Recovery never touched the live bytes.
        assert_eq!(std::fs::read(&live).unwrap(), corrupted_bytes);
    }

    #[test]
    fn truncated_wal_copy_fails_safely() {
        let dir = tmpdir("truncwal");
        let live = dir.join("live.db");
        fixture_db(&live, 30);
        // Build a trio copy with a truncated WAL: header (32 B) + crumbs.
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let copy_db = copy_trio_to_temp(&live, &work).unwrap();
        let wal = PathBuf::from(format!("{}-wal", copy_db.display()));
        if wal.exists() {
            let raw = std::fs::read(&wal).unwrap();
            assert!(raw.len() > 64, "fixture must have WAL content");
            std::fs::write(&wal, &raw[..10]).unwrap(); // truncated header
            let snap = dir.join("snap.db");
            let r = recover_copy_to_snapshot(&copy_db, &snap);
            // Either SQLite tolerates the stump or it fails typed — never a
            // panic, never a live touch. Assert the failure path explicitly
            // when it triggers; both outcomes keep live files intact.
            if let Err(e) = &r {
                assert!(
                    e.to_string().contains("integrity") || e.to_string().contains("recovery"),
                    "unexpected error shape: {e}"
                );
            }
            // Success is only acceptable with a clean integrity proof.
            if r.is_ok() {
                integrity_check(&open_snapshot_ro(&snap).unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn preflight_math_and_storage_exhausted() {
        assert_eq!(estimate_required_bytes(100, 20), 2 * 120 + 8 * 1024 * 1024);
        assert!(ensure_space(1_000_000, 999).is_ok());
        let err = ensure_space(10, 100).unwrap_err();
        assert!(matches!(err, TrustError::StorageExhausted { .. }));
        assert_eq!(err.gate_code(), "NONE");
        assert!(err.to_string().contains("10") && err.to_string().contains("100"));
    }

    #[test]
    fn preflight_live_dir_with_tiny_db_passes() {
        let dir = tmpdir("preflight");
        let live = dir.join("live.db");
        fixture_db(&live, 5);
        let quota = check_preflight(&dir, &live).unwrap();
        assert!(quota > 0);
    }

    #[test]
    fn staging_guard_removes_unfinalized_dir() {
        let dir = tmpdir("guard");
        let staging = dir.join("export_x.tmp");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("part.csv"), b"a,b\n").unwrap();
        { let _g = StagingGuard::new(staging.clone()); }
        assert!(!staging.exists(), "unfinalized staging must be removed");
        // Finalized guard is a no-op (consumes itself).
        std::fs::create_dir_all(&staging).unwrap();
        let g = StagingGuard::new(staging.clone());
        let stay = staging.clone();
        g.finalized();
        assert!(stay.exists());
        let _ = std::fs::remove_dir_all(&stay);
    }

    #[test]
    fn stale_tmp_cleanup_only_touches_export_tmps() {
        let dir = tmpdir("staleclean");
        let stale = dir.join("export_old.tmp");
        let keep = dir.join("notes.tmp");
        let keep2 = dir.join("export_final");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&keep).unwrap();
        std::fs::create_dir_all(&keep2).unwrap();
        cleanup_stale_staging(&dir);
        assert!(!stale.exists());
        assert!(keep.exists() && keep2.exists());
    }

    #[test]
    fn export_ownership_is_deterministic_busy_across_handles() {
        use std::fs::OpenOptions;
        let _g = serial_test_lock();
        let dir = tmpdir("ownertest");
        // Full ownership twice → second fails deterministically.
        let held = try_acquire_export(&dir).unwrap();
        let err = try_acquire_export(&dir).unwrap_err();
        assert!(err.to_string().contains("déjà en cours"));
        drop(held);
        assert!(try_acquire_export(&dir).is_ok());
        // File-lock mechanics directly: a second open+lock on the same path
        // conflicts even in-process (OS advisory semantics, both families).
        let a = ProcessExportLock::try_acquire(&dir).unwrap();
        let second = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(ProcessExportLock::lock_path(&dir))
            .unwrap();
        assert!(
            try_lock_exclusive(&second).is_err(),
            "second exclusive lock must conflict"
        );
        drop(second);
        drop(a);
        assert!(
            ProcessExportLock::try_acquire(&dir).is_ok(),
            "lock releases with the handle (no stale locks after crash)"
        );
    }

    #[test]
    fn manifest_roundtrip_and_tamper_detection() {
        let dir = tmpdir("manifest");
        std::fs::write(dir.join("a.csv"), b"id,v\n1,x\n").unwrap();
        std::fs::write(dir.join("b.csv"), b"id,v\n2,y\n3,z\n").unwrap();
        let files: Vec<ManifestFileEntry> = ["a.csv", "b.csv"]
            .iter()
            .map(|n| {
                let bytes = std::fs::read(dir.join(n)).unwrap();
                ManifestFileEntry {
                    table: n.to_string(),
                    file_name: n.to_string(),
                    row_count: bytes.iter().filter(|&&c| c == b'\n').count() as u64 - 1,
                    byte_len: bytes.len() as u64,
                    sha256: sha256_hex(&bytes),
                }
            })
            .collect();
        let input = ManifestInput {
            export_id: "export_test1".into(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files,
            trusted_wall_utc_ms: Some(1_700_000_000_000),
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: None,
            audit_error: Some("db plein".into()),
            mac: ManifestMac::Key(b"test-manifest-key-32bytes!!".to_vec()),
        };
        write_manifest(&dir, input).unwrap();
        assert_eq!(verify_manifest(&dir).unwrap(), 2);
        assert_eq!(
            verify_manifest_with_key(&dir, b"test-manifest-key-32bytes!!").unwrap(),
            2
        );
        // Tamper with one byte → both verifiers detect it.
        let mut raw = std::fs::read(dir.join("a.csv")).unwrap();
        raw[4] ^= 0xFF;
        std::fs::write(dir.join("a.csv"), raw).unwrap();
        assert!(verify_manifest(&dir).is_err());
        assert!(verify_manifest_with_key(&dir, b"test-manifest-key-32bytes!!").is_err());
    }

    #[test]
    fn hmac_vector_rfc4231_case1() {
        // RFC 4231 §4.2 test case 1: key = 0x0b×20, data = "Hi There".
        let mac = hmac_sha256_hex(
            &[0x0bu8; 20],
            b"Hi There",
        );
        assert_eq!(
            mac,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn recomputed_hash_forgery_fails_mac_but_passes_hashes() {
        // The money test for A1: attacker tampers a CSV AND recomputes the
        // manifest hashes (hashes alone cannot see this) but cannot re-MAC
        // without the key. Hash-only verification passes; MAC fails.
        let dir = tmpdir("forgery");
        std::fs::write(dir.join("a.csv"), b"id,v\n1,x\n").unwrap();
        let key = b"real-trust-key-sealed-in-keyring".to_vec();
        let bytes = std::fs::read(dir.join("a.csv")).unwrap();
        let input = ManifestInput {
            export_id: "export_forge1".into(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files: vec![ManifestFileEntry {
                table: "a.csv".into(),
                file_name: "a.csv".into(),
                row_count: 1,
                byte_len: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            }],
            trusted_wall_utc_ms: None,
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: None,
            audit_error: None,
            mac: ManifestMac::Key(key.clone()),
        };
        write_manifest(&dir, input).unwrap();
        assert!(verify_manifest_with_key(&dir, &key).is_ok());
        // Attacker: modify CSV, patch manifest hashes to match, leave MAC.
        let mut evil = std::fs::read(dir.join("a.csv")).unwrap();
        evil.extend_from_slice(b"999,evil\n");
        std::fs::write(dir.join("a.csv"), &evil).unwrap();
        let forged_hash = sha256_hex(&evil);
        let manifest_path = dir.join("manifest.json");
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        doc["files"][0]["sha256"] = serde_json::Value::String(forged_hash.clone());
        doc["files"][0]["row_count"] = serde_json::Value::from(2u64);
        doc["files"][0]["byte_len"] = serde_json::Value::from(evil.len() as u64);
        doc["export_sha256"] =
            serde_json::Value::String(sha256_hex(forged_hash.as_bytes()));
        std::fs::write(&manifest_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        // Hashes alone are blind to this forgery…
        assert!(verify_manifest(&dir).is_ok());
        // …the MAC is not.
        let err = verify_manifest_with_key(&dir, &key).unwrap_err();
        assert!(err.to_string().contains("falsification"));
        // Wrong key also fails.
        assert!(verify_manifest_with_key(&dir, b"wrong-key").is_err());
    }

    #[test]
    fn manifest_without_key_records_absence_verifies_hashes_only() {
        let dir = tmpdir("nomac");
        std::fs::write(dir.join("a.csv"), b"id,v\n1,x\n").unwrap();
        let bytes = std::fs::read(dir.join("a.csv")).unwrap();
        let input = ManifestInput {
            export_id: "export_nomac1".into(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files: vec![ManifestFileEntry {
                table: "a.csv".into(),
                file_name: "a.csv".into(),
                row_count: 1,
                byte_len: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            }],
            trusted_wall_utc_ms: None,
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: None,
            audit_error: None,
            mac: ManifestMac::Unavailable("keystore-unavailable".into()),
        };
        write_manifest(&dir, input).unwrap();
        // Recorded honestly, never faked.
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap())
                .unwrap();
        assert!(doc.get("manifest_mac").is_none());
        assert_eq!(doc["mac_status"], "no-key:keystore-unavailable");
        // Hashes still verify (corruption detection intact)…
        assert_eq!(verify_manifest(&dir).unwrap(), 1);
        // …but MAC verification refuses with a distinct message.
        let err = verify_manifest_with_key(&dir, b"any-key").unwrap_err();
        assert!(err.to_string().contains("non authentifié"));
    }

    #[test]
    fn raw_master_mac_is_rejected_subkey_required() {
        // Key separation proof: a MAC computed with the RAW master key must
        // fail verification, which only accepts the derived sub-key. This is
        // what makes cross-protocol replay (snapshot MAC ↔ manifest MAC)
        // impossible even under a shared master.
        let dir = tmpdir("subkey");
        std::fs::write(dir.join("a.csv"), b"id,v\n1,x\n").unwrap();
        let master = b"shared-master-key-32bytes!!!!!!!".to_vec();
        let bytes = std::fs::read(dir.join("a.csv")).unwrap();
        let input = ManifestInput {
            export_id: "export_subkey1".into(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files: vec![ManifestFileEntry {
                table: "a.csv".into(),
                file_name: "a.csv".into(),
                row_count: 1,
                byte_len: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            }],
            trusted_wall_utc_ms: None,
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: None,
            audit_error: None,
            mac: ManifestMac::Key(master.clone()),
        };
        write_manifest(&dir, input).unwrap();
        assert!(verify_manifest_with_key(&dir, &master).is_ok());
        // Splice in a raw-master MAC over identical canonical bytes.
        let manifest_path = dir.join("manifest.json");
        let mut doc: ManifestDoc =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        doc.manifest_mac = Some(hmac_sha256_hex(&master, &manifest_canonical_bytes(&doc)));
        std::fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
        let err = verify_manifest_with_key(&dir, &master).unwrap_err();
        assert!(err.to_string().contains("falsification"));
    }

    #[test]
    fn manifest_subkey_differs_from_master() {
        let sub = manifest_subkey(b"shared-master-key-32bytes!!!!!!!");
        assert_eq!(sub.len(), 32);
        assert_ne!(sub.as_slice(), b"shared-master-key-32bytes!!!!!!!");
        // Deterministic: same master always derives the same sub-key.
        assert_eq!(sub, manifest_subkey(b"shared-master-key-32bytes!!!!!!!"));
    }

    #[test]
    fn manifest_canonical_bytes_are_stable_golden() {
        // Golden bytes for a fixed manifest: struct field order is the
        // serialization order (serde, structs — not maps), so any reorder,
        // rename, or serde behavior change fails loudly here instead of
        // silently invalidating previously sealed exports. Update the golden
        // ONLY with owner review (and note that old exports verify against
        // the old bytes, not the new).
        let doc = ManifestDoc {
            export_format_version: EXPORT_FORMAT_VERSION,
            export_id: "export_golden1".into(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files: vec![ManifestFileEntry {
                table: "sales_journal".into(),
                file_name: "sales_journal.csv".into(),
                row_count: 2,
                byte_len: 44,
                sha256: "aaa".into(),
            }],
            total_rows: 2,
            total_bytes: 44,
            export_sha256: "bbb".into(),
            trusted_wall_utc_ms: Some(1_700_000_000_000),
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: Some("AUD-1".into()),
            audit_error: None,
            mac_status: "hmac-sha256".into(),
            manifest_mac: None,
        };
        let actual = String::from_utf8(manifest_canonical_bytes(&doc)).unwrap();
        assert_eq!(actual, GOLDEN_MANIFEST_CANONICAL);
    }

    /// Golden canonical bytes — see test above. Regenerate deliberately only.
    /// NOTE: embeds app_version 1.6.8; a version bump intentionally breaks
    /// this test so the format change gets explicit review.
    const GOLDEN_MANIFEST_CANONICAL: &str = "{\"export_format_version\":1,\"export_id\":\"export_golden1\",\"app_version\":\"1.6.8\",\"license_state\":\"EXPIRED\",\"integrity_state\":\"clean\",\"chain_status\":\"intact\",\"files\":[{\"table\":\"sales_journal\",\"file_name\":\"sales_journal.csv\",\"row_count\":2,\"byte_len\":44,\"sha256\":\"aaa\"}],\"total_rows\":2,\"total_bytes\":44,\"export_sha256\":\"bbb\",\"trusted_wall_utc_ms\":1700000000000,\"trusted_server_utc_ms\":null,\"exported_at\":\"2026-01-01T00:00:00Z\",\"audit_event_id\":\"AUD-1\",\"audit_error\":null,\"mac_status\":\"hmac-sha256\"}";

    /// A6: host-runnable probe fake (mobile OS branches compile but are NOT
    /// executed here — no Android/iOS CI; see report).
    struct FakeSpaceProbe {
        available: u64,
    }

    impl SpaceProbe for FakeSpaceProbe {
        fn available_bytes(&self, _dir: &Path) -> Result<u64, TrustError> {
            Ok(self.available)
        }
    }

    #[test]
    fn staging_paths_shape_is_stable_per_os() {
        // Pure path construction runs identically on every host; per-OS
        // roots (app_data_dir) come from Tauri and are listed in the report.
        let root = PathBuf::from("/tmp/exports");
        let (staging, final_dir) = staging_paths(&root, "export_1_abcdef12");
        assert_eq!(staging, PathBuf::from("/tmp/exports/export_1_abcdef12.tmp"));
        assert_eq!(final_dir, PathBuf::from("/tmp/exports/export_1_abcdef12"));
        assert_eq!(
            staging.extension().and_then(|e| e.to_str()),
            Some("tmp"),
            "cleanup only ever targets *.tmp"
        );
        assert!(final_dir.extension().is_none());
    }

    #[test]
    fn preflight_with_fake_probe_fails_typed_on_zero_space() {
        // Exercises estimate→compare through the real preflight function
        // (stronger than the pure ensure_space unit test).
        let dir = tmpdir("fakeprobe");
        let live = dir.join("live.db");
        fixture_db(&live, 5);
        let zero = FakeSpaceProbe { available: 0 };
        let err = check_preflight_with(&zero, &dir, &live).unwrap_err();
        assert!(matches!(err, TrustError::StorageExhausted { .. }));
        let plenty = FakeSpaceProbe {
            available: u64::MAX / 2,
        };
        let quota = check_preflight_with(&plenty, &dir, &live).unwrap();
        assert!(quota > 0);
    }

    #[test]
    fn fsync_dir_succeeds_on_host() {
        // Real syscall on Unix (incl. Android/iOS builds); documented no-op
        // on Windows. Either way it must succeed for an existing dir.
        let dir = tmpdir("fsyncdir");
        assert!(fsync_dir(&dir).is_ok());
        // Missing dir: real error on Unix, no-op Ok on Windows (no syscall
        // exists to fail). Assert per platform, honestly.
        #[cfg(unix)]
        assert!(fsync_dir(&dir.join("nope")).is_err());
        #[cfg(not(unix))]
        assert!(fsync_dir(&dir.join("nope")).is_ok());
    }

    #[test]
    fn verify_status_distinguishes_clean_flagged_and_unauthenticated() {
        // Owner Q1: three distinct outcomes — verified, flagged, unauthenticated.
        let key = b"status-test-key-32bytes!!!!!!!".to_vec();
        let build = |dir: &std::path::Path, integrity: &str, mac: ManifestMac| {
            std::fs::write(dir.join("a.csv"), b"id,v\n1,x\n").unwrap();
            let bytes = std::fs::read(dir.join("a.csv")).unwrap();
            write_manifest(
                dir,
                ManifestInput {
                    export_id: "export_status1".into(),
                    license_state: "TAMPER_SUSPECTED".into(),
                    integrity_state: integrity.into(),
                    chain_status: "intact".into(),
                    files: vec![ManifestFileEntry {
                        table: "a.csv".into(),
                        file_name: "a.csv".into(),
                        row_count: 1,
                        byte_len: bytes.len() as u64,
                        sha256: sha256_hex(&bytes),
                    }],
                    trusted_wall_utc_ms: None,
                    trusted_server_utc_ms: None,
                    exported_at: "2026-01-01T00:00:00Z".into(),
                    audit_event_id: None,
                    audit_error: None,
                    mac,
                },
            )
            .unwrap();
        };
        // Clean + MAC → VerifiedClean.
        let clean = tmpdir("statusclean");
        build(&clean, "clean", ManifestMac::Key(key.clone()));
        assert!(matches!(
            verify_manifest_status(&clean, Some(&key)),
            Ok(VerifyOutcome::VerifiedClean { files: 1 })
        ));
        // Tamper flag + valid MAC → Flagged (authentic record, not evidence).
        let flagged = tmpdir("statusflag");
        build(&flagged, "tamper", ManifestMac::Key(key.clone()));
        assert!(matches!(
            verify_manifest_status(&flagged, Some(&key)),
            Ok(VerifyOutcome::Flagged { files: 1, .. })
        ));
        // Unknown posture value → flagged on doubt, never clean.
        let weird = tmpdir("statusweird");
        build(&weird, "quarantine-v9", ManifestMac::Key(key.clone()));
        assert!(matches!(
            verify_manifest_status(&weird, Some(&key)),
            Ok(VerifyOutcome::Flagged { .. })
        ));
        // No MAC recorded → Unauthenticated (hashes passed).
        let nomac = tmpdir("statusnomac");
        build(
            &nomac,
            "clean",
            ManifestMac::Unavailable("keystore-unavailable".into()),
        );
        assert!(matches!(
            verify_manifest_status(&nomac, Some(&key)),
            Ok(VerifyOutcome::Unauthenticated { files: 1 })
        ));
        // MAC present but wrong → hard failure, never a warning.
        let bad = tmpdir("statusbad");
        build(&bad, "clean", ManifestMac::Key(key.clone()));
        let mut doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(bad.join("manifest.json")).unwrap(),
        )
        .unwrap();
        doc["manifest_mac"] = serde_json::Value::String("0".repeat(64));
        std::fs::write(
            bad.join("manifest.json"),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
        assert!(verify_manifest_status(&bad, Some(&key)).is_err());
    }

    #[test]
    fn integrity_state_mapping_is_fail_closed_on_doubt() {
        assert_eq!(integrity_state_for_license("OPERATIONAL"), "clean");
        assert_eq!(integrity_state_for_license("EXPIRED"), "clean");
        assert_eq!(integrity_state_for_license("TAMPER_SUSPECTED"), "tamper");
        assert_eq!(integrity_state_for_license("CLOCK_RESET_REQUIRED"), "clock");
        assert_eq!(integrity_state_for_license("FUTURE_V9"), "tamper");
        assert_eq!(integrity_state_for_license(""), "tamper");
    }

    #[test]
    fn quarantine_states_may_export_without_changing_state() {
        // Owner Q2: TAMPER_SUSPECTED and CLOCK_RESET_REQUIRED allow export;
        // authorization is read-only w.r.t. license state (no transition,
        // no generation bump, no unlock). REVOKED still denies.
        use crate::trust_core::ipc_authorizer::{authorize_and_execute, global_kernel};
        use crate::trust_core::{Capability, LicenseState};
        let _g = serial_test_lock();
        for state in [LicenseState::TamperSuspected, LicenseState::ClockResetRequired] {
            global_kernel().set_state(state);
            let (_, gen_before) = global_kernel().get();
            assert!(authorize_and_execute(
                "emergency_export_ledger",
                Capability::EmergencyExport,
                |_| Ok::<_, TrustError>(())
            )
            .is_ok(), "{state:?} must allow emergency export");
            let (after, gen_after) = global_kernel().get();
            assert_eq!(after, state, "export must not change license state");
            assert_eq!(gen_after, gen_before, "export must not bump generation");
        }
        global_kernel().set_state(LicenseState::Revoked);
        assert!(authorize_and_execute(
            "emergency_export_ledger",
            Capability::EmergencyExport,
            |_| Ok::<_, TrustError>(())
        )
        .is_err(), "REVOKED must deny emergency export");
    }

    #[test]
    fn manifest_write_failure_is_typed_distinct_and_retryable() {
        // Owner Q3: manifest unwritable → typed ExportManifestFailed
        // (distinct kind + gate), no staging/final residue beyond the guard,
        // and a retry after fixing the cause succeeds.
        let dir = tmpdir("manifestfail");
        let blocker = dir.join("staging.tmp");
        std::fs::write(&blocker, b"I am a file, not a dir").unwrap();
        let input = || ManifestInput {
            export_id: "export_mfail1".into(),
            license_state: "EXPIRED".into(),
            integrity_state: "clean".into(),
            chain_status: "intact".into(),
            files: vec![],
            trusted_wall_utc_ms: None,
            trusted_server_utc_ms: None,
            exported_at: "2026-01-01T00:00:00Z".into(),
            audit_event_id: None,
            audit_error: None,
            mac: ManifestMac::Unavailable("test".into()),
        };
        let err = write_manifest(&blocker, input()).unwrap_err();
        assert!(
            matches!(err, TrustError::ExportManifestFailed { .. }),
            "distinct typed error, got: {err}"
        );
        assert_ne!(
            std::mem::discriminant(&err),
            std::mem::discriminant(&TrustError::StorageExhausted {
                detail: String::new()
            }),
            "must differ from storage errors"
        );
        assert_eq!(err.gate_code(), "NONE");
        // No manifest file was produced through the blocker.
        assert!(!blocker.join("manifest.json").exists());
        // Retry after removing the blocker succeeds.
        std::fs::remove_file(&blocker).unwrap();
        std::fs::create_dir_all(&blocker).unwrap();
        write_manifest(&blocker, input()).unwrap();
        assert_eq!(verify_manifest(&blocker).unwrap(), 0);
    }

    #[test]
    fn capability_gates_snapshot_export_states() {        use crate::trust_core::ipc_authorizer::{authorize_and_execute, global_kernel};
        use crate::trust_core::{Capability, LicenseState};
        let _g = serial_test_lock();
        global_kernel().set_state(LicenseState::Expired);
        assert!(authorize_and_execute(
            "emergency_export_ledger",
            Capability::EmergencyExport,
            |_| Ok::<_, TrustError>(())
        )
        .is_ok(), "EXPIRED must allow emergency export");
        global_kernel().set_state(LicenseState::Revoked);
        assert!(authorize_and_execute(
            "emergency_export_ledger",
            Capability::EmergencyExport,
            |_| Ok::<_, TrustError>(())
        )
        .is_err(), "REVOKED must deny emergency export");
    }

    #[test]
    fn wal_fingerprint_stable_then_sensitive() {
        let dir = tmpdir("fingerprint");
        let wal = dir.join("x.db-wal");
        std::fs::write(&wal, vec![0xABu8; 100]).unwrap();
        let a = wal_fingerprint(&wal).expect("present");
        assert_eq!(wal_fingerprint(&wal), Some(a));
        // One appended byte changes the fingerprint.
        std::fs::write(&wal, vec![0xABu8; 101]).unwrap();
        assert_ne!(wal_fingerprint(&wal), Some(a));
        // Absent WAL fingerprints as stable-None (no retry needed).
        assert_eq!(wal_fingerprint(&dir.join("nope.db-wal")), None);
    }

    #[test]
    fn copy_under_active_writer_never_silent_inconsistent() {
        // Writer churns WAL while the copy set is taken repeatedly.
        // Contract under test: every outcome is either Ok-with-clean-
        // integrity or a typed retryable error — never a panic, never a
        // silently inconsistent copy. (A torn tail frame that slips past the
        // size/magic re-check is caught by integrity_check downstream, which
        // is exactly the production layered defense.)
        let dir = tmpdir("copyrace");
        let live = dir.join("live.db");
        fixture_db(&live, 10);
        let writer_path = live.clone();
        let handle = std::thread::spawn(move || {
            let conn = Connection::open(&writer_path).unwrap();
            conn.busy_timeout(Duration::from_secs(10)).unwrap();
            for i in 0..300u64 {
                let _ = conn.execute("INSERT INTO t(v) VALUES (?1)", params![format!("c-{i}")]);
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let mut clean = 0u32;
        let mut typed = 0u32;
        for round in 0..15u32 {
            let work = dir.join(format!("copy{round}"));
            std::fs::create_dir_all(&work).unwrap();
            match copy_trio_to_temp(&live, &work) {
                Ok(copy_db) => {
                    let conn = Connection::open(&copy_db).unwrap();
                    match integrity_check(&conn) {
                        Ok(()) => clean += 1,
                        Err(e) => {
                            typed += 1;
                            assert!(
                                e.to_string().contains("integrity"),
                                "unexpected error shape: {e}"
                            );
                        }
                    }
                    drop(conn);
                }
                Err(e) => {
                    typed += 1;
                    assert!(
                        e.to_string().contains("churning") || e.to_string().contains("recovery"),
                        "unexpected error shape: {e}"
                    );
                }
            }
        }
        handle.join().unwrap();
        eprintln!("[test] copy-under-write: {clean}/15 clean, {typed}/15 typed-retryable");
    }

    #[test]
    fn no_cargo_profile_enables_debug_assertions() {
        // A2: fail CI if any workspace manifest enables debug-assertions.
        // Scope: workspace root + every crate/patch manifest (mobile builds
        // share these manifests — there are no per-platform profiles).
        let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = crate_dir.parent().expect("workspace root above src-tauri");
        let root_toml = std::fs::read_to_string(root.join("Cargo.toml"))
            .expect("workspace root Cargo.toml must exist");
        assert!(
            root_toml.contains("[workspace]"),
            "test anchor broken: parent of src-tauri is not the workspace root"
        );
        let manifests = [
            ("Cargo.toml", true),
            ("src-tauri/Cargo.toml", true),
            ("crates/pos-core/Cargo.toml", false),
            ("crates/pos-peripherals/Cargo.toml", false),
            ("patches/tauri-plugin-sql/Cargo.toml", false),
        ];
        for (rel, required) in manifests {
            let path = root.join(rel);
            let Ok(raw) = std::fs::read_to_string(&path) else {
                assert!(!required, "required manifest missing: {rel}");
                continue;
            };
            for (i, line) in raw.lines().enumerate() {
                let code = line.split('#').next().unwrap_or("");
                let flat: String = code.chars().filter(|c| !c.is_whitespace()).collect();
                assert!(
                    !flat.contains("debug-assertions=true"),
                    "{rel}:{} enables debug-assertions (release builds must not): {line}",
                    i + 1
                );
            }
        }
    }
}

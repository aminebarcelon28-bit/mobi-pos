"""
Tamper-evident, hash-chained audit ledger.

Each record embeds the HMAC of its predecessor, so any edit, reorder, or
deletion breaks verification from that point forward:

    RecordHash = HMAC-SHA256(PrevHash || Timestamp || Action || Payload, NodeSecret)

The chain is verified on startup and before every write. A failure raises
:class:`LedgerIntegrityException`, which the UI surfaces as a blocking security
warning: the console switches to read-only so a compromised ledger cannot be
silently "repaired" by writing more entries over the damage.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import AUDIT_LOG_PATH, node_secret

#: Genesis value for the first record's PrevHash.
GENESIS = "0" * 64

#: Newest-first retention cap. Truncation rewrites the chain, so it is applied
#: on write and the retained head is re-chained.
MAX_RECORDS = 500

_lock = threading.RLock()
_write_locked = False


class LedgerIntegrityException(Exception):
    """Raised when the audit chain fails verification."""

    def __init__(self, message: str, record_index: Optional[int] = None):
        super().__init__(message)
        self.record_index = record_index


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _canonical(payload: Any) -> str:
    """Stable serialisation so the same data always hashes identically."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_hash(prev_hash: str, timestamp: str, action: str, payload: Any) -> str:
    """Compute one link of the chain."""
    message = "|".join([prev_hash, timestamp, action, _canonical(payload)])
    return hmac.new(
        node_secret(), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()


@dataclass
class AuditRecord:
    """One immutable link in the chain."""

    timestamp: str
    action: str
    payload: Dict[str, Any] = field(default_factory=dict)
    prev_hash: str = GENESIS
    record_hash: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "action": self.action,
            "payload": self.payload,
            "prev_hash": self.prev_hash,
            "record_hash": self.record_hash,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AuditRecord":
        return cls(
            timestamp=str(data.get("timestamp", "")),
            action=str(data.get("action", "")),
            payload=data.get("payload") or {},
            prev_hash=str(data.get("prev_hash", GENESIS)),
            record_hash=str(data.get("record_hash", "")),
        )


# ---------------------------------------------------------------------------
# Load / verify / append
# ---------------------------------------------------------------------------
def _read_raw() -> List[Dict[str, Any]]:
    if not AUDIT_LOG_PATH.exists():
        return []
    try:
        raw = json.loads(AUDIT_LOG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # An unparseable ledger is treated as tampering rather than ignored.
        raise LedgerIntegrityException(
            "Audit ledger is unreadable or corrupted; writes are blocked."
        )
    if not isinstance(raw, list):
        raise LedgerIntegrityException("Audit ledger has an unexpected shape.")
    return raw


def verify_chain(entries: Optional[List[Dict[str, Any]]] = None) -> None:
    """
    Verify every link in the chain.

    Raises LedgerIntegrityException on a hash mismatch, a broken link, or a
    missing/extra sequence value. ``entries`` defaults to the on-disk ledger.
    """
    entries = _read_raw() if entries is None else entries
    if not entries:
        return

    # Records are stored newest-first; verify from the oldest link forward.
    ordered = list(reversed(entries))
    prev_hash = GENESIS

    for index, raw in enumerate(ordered):
        record = AuditRecord.from_dict(raw)

        if record.prev_hash != prev_hash:
            raise LedgerIntegrityException(
                f"Chain break at record {index}: expected prev_hash "
                f"{prev_hash[:12]}…, found {record.prev_hash[:12]}…",
                record_index=index,
            )
        if not record.record_hash:
            raise LedgerIntegrityException(
                f"Record {index} has no hash and cannot be authenticated.",
                record_index=index,
            )

        expected = compute_hash(
            record.prev_hash, record.timestamp, record.action, record.payload
        )
        if not hmac.compare_digest(expected, record.record_hash):
            raise LedgerIntegrityException(
                f"Record {index} failed HMAC verification "
                f"(action={record.action}). The ledger has been modified.",
                record_index=index,
            )
        prev_hash = record.record_hash


def load_audit_log() -> List[Dict[str, Any]]:
    """
    Load audit events, verifying integrity first.

    Returns newest-first records, matching the historical format.
    """
    with _lock:
        verify_chain()
        return _read_raw()


def record_audit_event(
    action: str,
    details: str = "",
    client_name: str = "",
    license_key: str = "",
    **extra: Any,
) -> Optional[Dict[str, Any]]:
    """
    Append a chained audit event.

    Returns the stored record, or None when writes are blocked because the
    chain failed verification.
    """
    global _write_locked

    payload: Dict[str, Any] = {
        "details": details,
        "client": client_name,
        "key": license_key,
    }
    if extra:
        payload["extra"] = extra

    with _lock:
        if _write_locked:
            return None
        try:
            entries = _read_raw()
            verify_chain(entries)
        except LedgerIntegrityException:
            _write_locked = True
            return None

        prev_hash = entries[0]["record_hash"] if entries else GENESIS
        timestamp = _now()
        record = AuditRecord(
            timestamp=timestamp,
            action=action,
            payload=payload,
            prev_hash=prev_hash,
            record_hash=compute_hash(prev_hash, timestamp, action, payload),
        )

        entries.insert(0, record.to_dict())
        if len(entries) > MAX_RECORDS:
            entries = _rechain(entries[:MAX_RECORDS])

        try:
            AUDIT_LOG_PATH.write_text(
                json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except OSError:
            return None
        return record.to_dict()


def _rechain(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Rebuild hashes for a truncated chain, oldest first.

    Required after dropping old records so the retained window stays verifiable.
    """
    rebuilt: List[Dict[str, Any]] = []
    prev_hash = GENESIS
    for raw in reversed(entries):
        record = AuditRecord.from_dict(raw)
        record.prev_hash = prev_hash
        record.record_hash = compute_hash(
            prev_hash, record.timestamp, record.action, record.payload
        )
        rebuilt.append(record.to_dict())
        prev_hash = record.record_hash
    return list(reversed(rebuilt))


def clear_audit_log() -> bool:
    """Reset the ledger to an empty, valid chain."""
    global _write_locked
    with _lock:
        try:
            AUDIT_LOG_PATH.write_text("[]", encoding="utf-8")
        except OSError:
            return False
        _write_locked = False
        return True


def writes_blocked() -> bool:
    """True when a previous integrity failure disabled writes."""
    return _write_locked


def integrity_status() -> Dict[str, Any]:
    """Diagnostic summary for the telemetry card."""
    try:
        entries = _read_raw()
    except LedgerIntegrityException as exc:
        return {"ok": False, "error": str(exc), "count": 0, "writes_blocked": True}

    try:
        verify_chain(entries)
    except LedgerIntegrityException as exc:
        return {
            "ok": False,
            "error": str(exc),
            "count": len(entries),
            "writes_blocked": True,
        }

    return {
        "ok": True,
        "error": None,
        "count": len(entries),
        "writes_blocked": writes_blocked(),
        "head": entries[0]["record_hash"][:12] + "…" if entries else None,
    }


# ----------------------------------------------------------------------
# Server-side anchoring
# ----------------------------------------------------------------------
class AuditAnchorTamperError(Exception):
    """
    The server rejected our ledger checkpoint.

    Either the local sequence went backwards (records were deleted) or the same
    sequence now carries a different head hash (the history was rewritten).
    Both indicate tampering, so the console must stop writing.
    """

    def __init__(self, message: str, server_sequence: Optional[int] = None):
        super().__init__(message)
        self.server_sequence = server_sequence


def client_identifier() -> str:
    """
    Stable per-installation identifier used as the checkpoint key.

    Derived from the machine HWID so it is stable across restarts but not
    guessable from a hostname.
    """
    from .hwid import detect_local_hwid

    return f"mobi-{detect_local_hwid()['hash'][:32]}"


def ledger_head(entries: Optional[List[Dict[str, Any]]] = None) -> tuple:
    """
    (sequence_number, head_audit_hash) for the current ledger head.

    Sequence is the number of records retained, which the server compares
    against the highest value it has ever stored. An empty ledger anchors at
    sequence 0 with the genesis hash.
    """
    if entries is None:
        try:
            entries = _read_raw()
        except LedgerIntegrityException:
            entries = []
    if not entries:
        return 0, GENESIS
    return len(entries), entries[0]["record_hash"]


def anchor_audit_ledger(client: Any = None) -> Dict[str, Any]:
    """
    Push the current ledger head to the server for tamper anchoring.

    On success the server has recorded this (sequence, head hash) pair; any
    future call reporting a lower sequence is refused, which is how a local
    deletion is detected.

    Raises:
        AuditAnchorTamperError: the server answered 409. The caller must lock
            the console out; this is a security event, not a transient error.
    """
    import requests

    from .api import AdminApiClient

    entries = _read_raw()
    verify_chain(entries)
    sequence, head_hash = ledger_head(entries)

    client = client or AdminApiClient()
    try:
        client.anchor_audit_checkpoint(client_identifier(), sequence, head_hash)
    except requests.HTTPError as exc:
        response = exc.response
        if response is not None and response.status_code == 409:
            try:
                body = response.json()
            except ValueError:
                body = {}
            detail = body.get("error") or "Audit checkpoint rejected by server."
            server_sequence = body.get("server_sequence")
            global _write_locked
            # A server-side refusal is authoritative: stop writing immediately
            # so no further entries are appended over a tampered ledger.
            _write_locked = True
            raise AuditAnchorTamperError(detail, server_sequence) from exc
        raise

    return {
        "anchored": True,
        "sequence_number": sequence,
        "head_audit_hash": head_hash,
    }

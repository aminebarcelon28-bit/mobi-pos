"""
Typed domain model for MobiPOS licensing.

No Qt, no network, no I/O. Every field the UI renders is derived here so the
presentation layer never has to interpret raw payloads.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

#: Days under which an active licence is flagged as expiring soon.
EXPIRY_WARNING_DAYS = 10

#: Formula tags that are time-boxed trials.
TRIAL_FORMULAS = frozenset({"24H", "DEMO", "90D", "30D", "1_DAY", "1_MONTH", "3_MONTHS"})

#: Formula tags that never expire.
LIFETIME_FORMULAS = frozenset({"LIFETIME", "LIFE"})


class LicenseStatus(str, Enum):
    """Effective status shown in the UI."""

    ACTIVE = "active"
    TRIAL = "trial"
    EXPIRED = "expired"
    UNREGISTERED = "unregistered"
    SUSPENDED = "suspended"
    REVOKED = "revoked"
    PENDING_SYNC = "pending_sync"


class SyncStatus(str, Enum):
    """Local/cloud reconciliation state for a single licence."""

    SYNCED = "synced"
    LOCAL_ONLY = "local_only"
    CLOUD_ONLY = "cloud_only"
    CONFLICT = "conflict"


class SeatKind(str, Enum):
    """Which entitlement pool a seat is drawn from."""

    POS = "pos"
    DESK = "desk"


@dataclass(frozen=True, slots=True)
class DeviceBinding:
    """A hardware device bound to a licence."""

    hwid: str
    label: str = ""
    first_seen: Optional[datetime.datetime] = None
    last_seen: Optional[datetime.datetime] = None
    ip_address: Optional[str] = None
    platform: str = "Windows"
    seat_kind: SeatKind = SeatKind.POS

    @classmethod
    def from_payload(cls, data: Any) -> "DeviceBinding":
        if not isinstance(data, dict):
            return cls(hwid="")
        return cls(
            hwid=str(data.get("hwid") or data.get("device_id") or ""),
            label=str(data.get("label") or data.get("name") or ""),
            first_seen=parse_datetime(data.get("first_seen") or data.get("created_at")),
            last_seen=parse_datetime(data.get("last_seen") or data.get("last_seen_at")),
            ip_address=data.get("ip_address") or data.get("ip"),
            platform=str(data.get("platform") or data.get("os") or "Windows"),
            seat_kind=_coerce_seat(data.get("seat_kind") or data.get("device_type")),
        )

    @property
    def short_hwid(self) -> str:
        return self.hwid[:8] + "…" if len(self.hwid) > 12 else self.hwid


def _coerce_seat(value: Any) -> SeatKind:
    text = str(value or "").strip().lower()
    return SeatKind.DESK if text in ("desk", "backoffice", "back_office") else SeatKind.POS


@dataclass
class LicenseRecord:
    """A licence merged from the cloud database and the local ledger."""

    id: str = ""
    customer: str = "Client Inconnu"
    license_key: str = ""
    formula: str = "LIFETIME"
    raw_status: str = "active"
    max_desktops: int = 1
    max_mobiles: int = 1
    active_desktops: int = 0
    active_mobiles: int = 0
    turso_url: str = ""
    created_at: str = ""
    expires_at: Optional[str] = None
    phone: str = ""
    city: str = ""
    notes: str = ""
    in_cloud: bool = False
    in_ledger: bool = False
    devices: List[DeviceBinding] = field(default_factory=list)
    ledger_hash: str = ""

    # -- Derived: status -------------------------------------------------
    @property
    def is_trial_formula(self) -> bool:
        return self.formula.strip().upper() in TRIAL_FORMULAS

    @property
    def is_lifetime(self) -> bool:
        return self.formula.strip().upper() in LIFETIME_FORMULAS

    @property
    def days_left(self) -> Optional[int]:
        """
        Days until expiry, or None when undated.

        An explicit expiry date outranks the formula tag, so a LIFETIME record
        the server gave a date is treated as time-boxed.
        """
        if not self.expires_at or self.expires_at == "NONE":
            return None
        expiry = parse_datetime(self.expires_at)
        if expiry is None:
            return None
        now = datetime.datetime.now(datetime.timezone.utc)
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=datetime.timezone.utc)
        return (expiry - now).days

    @property
    def is_expired(self) -> bool:
        days = self.days_left
        return days is not None and days < 0

    @property
    def is_expiring_soon(self) -> bool:
        days = self.days_left
        return days is not None and 0 <= days <= EXPIRY_WARNING_DAYS

    @property
    def is_full(self) -> bool:
        return (
            self.active_desktops >= max(1, self.max_desktops)
            or self.active_mobiles >= max(1, self.max_mobiles)
        )

    @property
    def has_plaintext_key(self) -> bool:
        """False when only a redacted cloud placeholder is available."""
        return bool(self.license_key) and not self.license_key.startswith("[")

    @property
    def status(self) -> LicenseStatus:
        """
        Effective status.

        Precedence: revoked > suspended > unsynced > expired > trial > active.
        A revoked licence stays revoked even after its expiry date passes.
        """
        raw = (self.raw_status or "").strip().lower()
        if raw == "revoked":
            return LicenseStatus.REVOKED
        if raw == "suspended":
            return LicenseStatus.SUSPENDED
        if raw == "pending_sync" or not self.in_cloud:
            return LicenseStatus.UNREGISTERED
        if self.is_expired:
            return LicenseStatus.EXPIRED
        if self.is_trial_formula:
            return LicenseStatus.TRIAL
        return LicenseStatus.ACTIVE

    @property
    def sync_status(self) -> SyncStatus:
        if self.in_cloud and self.in_ledger:
            return SyncStatus.SYNCED
        return SyncStatus.LOCAL_ONLY if self.in_ledger else SyncStatus.CLOUD_ONLY

    # -- Derived: seats --------------------------------------------------
    @property
    def total_devices(self) -> int:
        return self.active_desktops + self.active_mobiles

    @property
    def seat_ratio(self) -> float:
        return self.active_desktops / max(1, self.max_desktops)

    @property
    def mobile_ratio(self) -> float:
        return self.active_mobiles / max(1, self.max_mobiles)

    @property
    def created_date(self) -> str:
        return (self.created_at or "")[:10]

    @property
    def search_blob(self) -> str:
        return " ".join(
            (self.customer, self.license_key, self.phone, self.city,
             self.notes, self.turso_url)
        ).lower()

    # -- Serialisation ---------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        """Camel-case payload for the cloud API and existing dialogs."""
        return {
            "id": self.id,
            "customer": self.customer,
            "licenseKey": self.license_key,
            "type": self.formula,
            "status": self.raw_status,
            "desktops": self.max_desktops,
            "mobiles": self.max_mobiles,
            "activeDesktops": self.active_desktops,
            "activeMobiles": self.active_mobiles,
            "tursoUrl": self.turso_url,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "phone": self.phone,
            "city": self.city,
            "notes": self.notes,
            "inCloud": self.in_cloud,
            "inLedger": self.in_ledger,
        }

    @classmethod
    def from_merged(cls, data: Dict[str, Any]) -> "LicenseRecord":
        """Build from the camel-case output of merge_cloud_and_ledger."""
        return cls(
            id=str(data.get("id", "")),
            customer=data.get("customer") or "Client Inconnu",
            license_key=data.get("licenseKey") or "",
            formula=(data.get("type") or "LIFETIME").upper(),
            raw_status=(data.get("status") or "active").lower(),
            max_desktops=_as_int(data.get("desktops"), 1),
            max_mobiles=_as_int(data.get("mobiles"), 1),
            active_desktops=_as_int(data.get("activeDesktops"), 0),
            active_mobiles=_as_int(data.get("activeMobiles"), 0),
            turso_url=data.get("tursoUrl") or "",
            created_at=data.get("createdAt") or "",
            expires_at=data.get("expiresAt"),
            phone=data.get("phone") or "",
            city=data.get("city") or "",
            notes=data.get("notes") or "",
            in_cloud=bool(data.get("inCloud", False)),
            in_ledger=bool(data.get("inLedger", False)),
            ledger_hash=data.get("ledgerHash") or "",
        )


@dataclass
class FleetSummary:
    """Aggregate metrics across the whole fleet."""

    records: List[LicenseRecord] = field(default_factory=list)

    @property
    def total_customers(self) -> int:
        return len(self.records)

    @property
    def total_active_desktops(self) -> int:
        return sum(r.active_desktops for r in self.records)

    @property
    def total_max_desktops(self) -> int:
        return sum(r.max_desktops for r in self.records)

    @property
    def total_active_mobiles(self) -> int:
        return sum(r.active_mobiles for r in self.records)

    @property
    def total_max_mobiles(self) -> int:
        return sum(r.max_mobiles for r in self.records)

    @property
    def count_expired(self) -> int:
        return sum(1 for r in self.records if r.status is LicenseStatus.EXPIRED)

    @property
    def count_expiring_soon(self) -> int:
        return sum(1 for r in self.records if r.is_expiring_soon)

    def count(self, status: LicenseStatus) -> int:
        return sum(1 for r in self.records if r.status is status)

    def counts(self) -> Dict[str, int]:
        return {s.value: self.count(s) for s in LicenseStatus}


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_datetime(value: Any) -> Optional[datetime.datetime]:
    """Parse an ISO-8601 timestamp, tolerating a trailing Z."""
    if not value:
        return None
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None

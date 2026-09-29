"""
Application service: the single boundary the UI uses for licensing work.

Contains no Qt imports. Every method returns a result object rather than
letting exceptions escape into the presentation layer, and network calls use
bounded exponential backoff so a flaky edge does not stall the console.
"""

from __future__ import annotations

import datetime
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, TypeVar

from .api import AdminApiClient, load_ledger, merge_cloud_and_ledger
from .models import FleetSummary, LicenseRecord, LicenseStatus, SyncStatus

T = TypeVar("T")

#: Retry policy for transient network failures.
RETRY_DELAYS = (1.0, 2.0, 4.0, 8.0)


@dataclass
class ServiceResult:
    """Outcome of a refresh, always safe to hand to the UI."""

    records: List[LicenseRecord] = field(default_factory=list)
    healthy: bool = False
    latency_ms: float = 0.0
    service_message: str = ""
    error: Optional[str] = None
    offline: bool = False
    retries: int = 0

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def summary(self) -> FleetSummary:
        return FleetSummary(self.records)


@dataclass(frozen=True)
class Conflict:
    """
    A divergence between the cloud record and the local ledger.

    Reported instead of silently overwriting either side, so an operator can
    decide which value is authoritative.
    """

    license_id: str
    customer: str
    license_key: str
    field_name: str
    cloud_value: str
    local_value: str

    @property
    def label(self) -> str:
        return f"{self.customer} · {self.field_name}"


def with_retry(
    operation: Callable[[], T],
    attempts: int = len(RETRY_DELAYS) + 1,
    sleep: Callable[[float], None] = time.sleep,
) -> Tuple[Optional[T], Optional[str], int]:
    """
    Run an operation with exponential backoff.

    Returns (value, error, retries_used). A network exception is retried;
    an application-level failure (False result) is returned immediately since
    retrying it would not change the outcome.
    """
    last_error = ""
    for index in range(attempts):
        try:
            return operation(), None, index
        except Exception as exc:  # network/transport only
            last_error = str(exc)
            if index >= len(RETRY_DELAYS):
                break
            sleep(RETRY_DELAYS[index])
    return None, last_error, attempts - 1


class LicensingService:
    """Coordinates the cloud API and the local ledger."""

    def __init__(self, api_client: Optional[AdminApiClient] = None):
        self.api_client = api_client or AdminApiClient()

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    def refresh(self) -> ServiceResult:
        """
        Fetch health and cloud licences, merge with the ledger, and model them.

        Never raises. A cloud failure degrades to local-only data with a clear
        message rather than an empty table.
        """
        healthy, latency, service_msg = self.api_client.check_health()
        retries = 0

        cloud: List[Dict[str, Any]] = []
        if healthy:
            value, error, retries = with_retry(self.api_client.list_cloud_licenses)
            if error:
                healthy = False
                service_msg = f"Cloud read failed: {error}"
            else:
                cloud = value or []

        records = self._build_records(cloud, load_ledger())
        return ServiceResult(
            records=records,
            healthy=healthy,
            latency_ms=latency,
            service_message=service_msg,
            error=None if healthy else service_msg,
            offline=not healthy,
            retries=retries,
        )

    def local_only(self) -> ServiceResult:
        records = self._build_records([], load_ledger())
        return ServiceResult(
            records=records,
            healthy=False,
            service_message="Local mode (offline)",
            offline=True,
        )

    @staticmethod
    def _build_records(cloud, ledger) -> List[LicenseRecord]:
        merged = merge_cloud_and_ledger(cloud, ledger)
        return [LicenseRecord.from_merged(item) for item in merged]

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------
    def set_status(self, license_key: str, status: str) -> Tuple[bool, str]:
        value, error, _ = with_retry(lambda: self.api_client.set_status(license_key, status))
        if error:
            return False, f"Status update failed: {error}"
        if not value:
            return False, "The server did not confirm the change."
        return True, ""

    def reset_seats(self, license_key: str) -> Tuple[int, str]:
        value, error, _ = with_retry(lambda: self.api_client.reset_seats(license_key))
        if error:
            return 0, f"Seat reset failed: {error}"
        return int(value or 0), ""

    def update_quotas(
        self, license_key: str, max_desktops: int, max_mobiles: int
    ) -> Tuple[bool, str]:
        value, error, _ = with_retry(
            lambda: self.api_client.update_seats(license_key, max_desktops, max_mobiles)
        )
        if error:
            return False, f"Quota update failed: {error}"
        if not value:
            return False, "The server did not confirm the quota change."
        return True, ""

    def unbind_device(self, license_key: str, device_id: str) -> Tuple[bool, str]:
        value, error, _ = with_retry(
            lambda: self.api_client.unbind_single_device(license_key, device_id)
        )
        if error:
            return False, f"Unbind failed: {error}"
        return bool(value), "" if value else "The server did not confirm the unbind."

    def get_devices(self, license_key: str) -> Tuple[List[Dict[str, Any]], str]:
        value, error, _ = with_retry(lambda: self.api_client.get_devices(license_key))
        if error:
            return [], f"Could not fetch devices: {error}"
        return value or [], ""

    def check_health(self) -> Tuple[bool, float, str]:
        return self.api_client.check_health()

    def audit_status(self) -> Dict[str, Any]:
        from .audit import integrity_status

        return integrity_status()


# ----------------------------------------------------------------------
# Filtering, sorting, export (pure functions over the model)
# ----------------------------------------------------------------------
def filter_records(
    records: List[LicenseRecord],
    query: str = "",
    formula: str = "",
    status_filter: str = "ALL",
) -> List[LicenseRecord]:
    """
    Apply search text, formula, and status-pill filters.

    status_filter accepts ALL, a LicenseStatus value, or the pseudo-filters
    FULL (quota exhausted) and EXPIRING.
    """
    needle = (query or "").strip().lower()
    formula_filter = (formula or "").strip().upper()

    out: List[LicenseRecord] = []
    for record in records:
        if not _matches_status(record, status_filter):
            continue
        if needle and needle not in record.search_blob:
            continue
        if formula_filter and formula_filter != record.formula.upper():
            continue
        out.append(record)
    return out


def _matches_status(record: LicenseRecord, status_filter: str) -> bool:
    if not status_filter or status_filter == "ALL":
        return True
    if status_filter == "FULL":
        return record.is_full
    if status_filter == "EXPIRING":
        return record.is_expiring_soon or record.is_expired
    if status_filter == LicenseStatus.TRIAL.value:
        # Trials that have lapsed are still trial-formula licences.
        return record.status in (LicenseStatus.TRIAL, LicenseStatus.EXPIRED)
    return record.status.value == status_filter


_SORT_KEYS: Dict[str, Callable[[LicenseRecord], Any]] = {
    "customer": lambda r: r.customer.lower(),
    "licenseKey": lambda r: r.license_key.lower(),
    "formula": lambda r: r.formula.lower(),
    "desktops": lambda r: r.seat_ratio,
    "mobiles": lambda r: r.mobile_ratio,
    "status": lambda r: r.status.value,
    "expiry": lambda r: r.days_left if r.days_left is not None else 10**6,
    "createdAt": lambda r: r.created_at,
    "sync": lambda r: r.sync_status.value,
}


def sort_records(
    records: List[LicenseRecord], column: str, reverse: bool = False
) -> List[LicenseRecord]:
    """Stable sort by a named column; unknown columns are a no-op."""
    key = _SORT_KEYS.get(column)
    if key is None:
        return list(records)
    return sorted(records, key=key, reverse=reverse)


#: Fields compared when detecting a cloud/local divergence.
CONFLICT_FIELDS = {
    "customer": ("customer",),
    "phone": ("phone",),
    "city": ("city",),
    "notes": ("notes",),
    "tursoUrl": ("turso_url",),
}


def detect_conflicts(
    cloud_records: List[LicenseRecord], local_records: List[LicenseRecord]
) -> List[Conflict]:
    """
    Find fields where cloud and local disagree for the same licence.

    Matching is by licence id, falling back to the normalised key. A missing
    counterpart is not a conflict (that is a sync-state difference, reported
    separately by ``sync_status``).
    """
    local_by_id = {r.id: r for r in local_records if r.id}
    local_by_key = {
        k: r for k, r in ((r.license_key.strip().upper(), r) for r in local_records)
        if k
    }

    conflicts: List[Conflict] = []
    for cloud in cloud_records:
        local = local_by_id.get(cloud.id)
        if local is None and cloud.license_key:
            local = local_by_key.get(cloud.license_key.strip().upper())
        if local is None:
            continue

        for api_field, (attr,) in CONFLICT_FIELDS.items():
            cloud_value = str(getattr(cloud, attr) or "").strip()
            local_value = str(getattr(local, attr) or "").strip()
            if cloud_value and local_value and cloud_value != local_value:
                conflicts.append(
                    Conflict(
                        license_id=cloud.id,
                        customer=cloud.customer,
                        license_key=cloud.license_key,
                        field_name=api_field,
                        cloud_value=cloud_value,
                        local_value=local_value,
                    )
                )
    return conflicts


def export_rows(records: List[LicenseRecord]) -> List[List[str]]:
    """Flatten records into CSV/Excel-friendly rows."""
    header = [
        "ID", "Client", "Cle de Licence", "Formule", "Statut", "Sync",
        "Caisses Max", "Caisses Actives", "Mobiles Max", "Mobiles Actifs",
        "Expire le (jours)", "Telephone", "Ville", "Notes", "Base Turso", "Creee le",
    ]
    rows: List[List[str]] = []
    for r in records:
        days = r.days_left
        rows.append([
            r.id,
            r.customer,
            r.license_key,
            r.formula,
            r.status.value,
            r.sync_status.value,
            r.max_desktops,
            r.active_desktops,
            r.max_mobiles,
            r.active_mobiles,
            "" if days is None else days,
            r.phone,
            r.city,
            r.notes,
            r.turso_url,
            r.created_at,
        ])
    return [header] + rows


def today_stamp() -> str:
    return datetime.date.today().isoformat()

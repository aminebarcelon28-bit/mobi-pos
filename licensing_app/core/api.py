"""
Transport client and local licence ledger storage.

TLS is enforced explicitly: certificate verification is on, the minimum
version is pinned to TLS 1.2+ (1.3 where the platform supports it), and
redirects that would downgrade to HTTP are refused.
"""

import json
import ssl
import time
from typing import List, Dict, Any, Optional, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

from ..config import LEDGER_PATH, SETTINGS
from .crypto import normalize_key, hash_key

#: Require TLS 1.2 as a floor (1.3 is negotiated automatically where the
#: platform supports it) and never accept an unverified or hostname-mismatched
#: certificate. urllib3 names this parameter ssl_minimum_version.
TLS_CONTEXT = create_urllib3_context(
    ssl_minimum_version=ssl.TLSVersion.TLSv1_2,
    cert_reqs=ssl.CERT_REQUIRED,
)
TLS_CONTEXT.check_hostname = True
TLS_CONTEXT.verify_mode = ssl.CERT_REQUIRED


class _TLSAdapter(HTTPAdapter):
    """
    Mounts the hardened SSL context.

    ``HTTPAdapter`` does not forward pool kwargs on every supported requests
    version, so the pool manager is built explicitly to guarantee the context
    is actually used rather than silently falling back to urllib3 defaults.
    """

    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = TLS_CONTEXT
        return super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        kwargs["ssl_context"] = TLS_CONTEXT
        return super().proxy_manager_for(*args, **kwargs)


class AdminApiClient:
    def __init__(self, endpoint: str = "", master_key: str = "", token: str = ""):
        self.endpoint = (endpoint or SETTINGS.endpoint).rstrip("/")
        self.master_key = master_key or SETTINGS.master_encryption_key
        self.token = token or SETTINGS.admin_token
        self.session = requests.Session()
        self.session.mount("https://", _TLSAdapter(max_retries=0))
        auth = self.token or self.master_key
        self.session.headers.update({
            "Content-Type": "application/json",
            "User-Agent": "MobiPOS-LicensingConsole/3.1",
            "X-Client-Version": "3.1.0",
        })
        if auth:
            self.session.headers["Authorization"] = f"Bearer {auth}"

    def check_health(self) -> Tuple[bool, float, str]:
        """
        Check connectivity and latency to the Cloudflare Worker Edge.
        Returns: (is_healthy, latency_ms, message)
        """
        t0 = time.perf_counter()
        try:
            resp = self.session.get(f"{self.endpoint}/health", timeout=6.0)
            latency = (time.perf_counter() - t0) * 1000.0
            if resp.status_code == 200:
                data = resp.json()
                return True, round(latency, 1), data.get("service", "Cloudflare Edge")
            return False, round(latency, 1), f"HTTP {resp.status_code}"
        except Exception as e:
            latency = (time.perf_counter() - t0) * 1000.0
            return False, round(latency, 1), str(e)

    def list_cloud_licenses(self) -> List[Dict[str, Any]]:
        """
        Fetch all licenses from Master Turso DB via Worker.
        """
        url = f"{self.endpoint}/api/v1/admin/list"
        resp = self.session.get(url, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("licenses", [])

    def get_devices(self, license_key: str) -> List[Dict[str, Any]]:
        """
        Fetch active device bindings for a given license key.
        """
        url = f"{self.endpoint}/api/v1/admin/devices"
        payload = {"license_key": license_key}
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("devices", [])

    def remote_sign_license(
        self,
        customer: str,
        formula: str,
        seats_pos: int,
        seats_desk: int,
        expires_at: Optional[str] = None,
        hwid_bindings: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Sign a licence on the Cloudflare Edge with the vendor Ed25519 key.

        The private key never leaves the worker, so the desktop console cannot
        forge a licence on a stolen machine. Returns the worker's JSON body.

        Raises requests.HTTPError on a non-2xx response; a 503 means the worker
        has no signing key bound.
        """
        url = f"{self.endpoint}/api/v1/admin/licenses/sign"
        payload = {
            "customer": customer,
            "formula": formula,
            "seats_pos": int(seats_pos),
            "seats_desk": int(seats_desk),
            "expires_at": expires_at,
            "hwid_bindings": list(hwid_bindings or []),
        }
        resp = self.session.post(url, json=payload, timeout=15.0)
        resp.raise_for_status()
        return resp.json()

    def anchor_audit_checkpoint(
        self, client_id: str, sequence_number: int, head_audit_hash: str
    ) -> Dict[str, Any]:
        """
        Anchor the local audit ledger head to the server.

        The server stores the highest sequence it has ever seen for this client.
        A lower sequence on a later call means records were removed locally, so
        the worker answers 409 and the console must lock out.

        Raises requests.HTTPError on 409 (tamper) or any other non-2xx.
        """
        url = f"{self.endpoint}/api/v1/admin/audit/checkpoint"
        payload = {
            "client_id": client_id,
            "sequence_number": int(sequence_number),
            "head_audit_hash": head_audit_hash,
        }
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        return resp.json()

    def sync_license(self, license_data: Dict[str, Any]) -> bool:
        """
        Upsert a license to Cloud Master Turso DB.
        """
        url = f"{self.endpoint}/api/v1/admin/sync"
        resp = self.session.post(url, json=license_data, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("status") == "success"

    def update_seats(self, license_key: str, max_desktops: int, max_mobiles: int) -> bool:
        """
        Update seat quotas for caisses and mobiles.
        """
        url = f"{self.endpoint}/api/v1/admin/update-seats"
        payload = {
            "license_key": license_key,
            "max_desktops": max_desktops,
            "max_mobiles": max_mobiles
        }
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("status") == "success"

    def reset_seats(self, license_key: str) -> int:
        """
        Deactivate all bound devices for a key (allows re-binding on new hardware).
        Returns number of seats cleared.
        """
        url = f"{self.endpoint}/api/v1/admin/reset-seats"
        payload = {"license_key": license_key}
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return int(data.get("seats_cleared", 0))

    def set_status(self, license_key: str, status: str) -> bool:
        """
        Change license status: 'active', 'suspended', 'revoked'.
        """
        url = f"{self.endpoint}/api/v1/admin/set-status"
        payload = {
            "license_key": license_key,
            "status": status.lower()
        }
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("status") == "success"

    def unbind_single_device(self, license_key: str, device_id: str) -> bool:
        """
        Unbind an individual device without clearing other devices.
        """
        url = f"{self.endpoint}/api/v1/license/deactivate"
        payload = {
            "license_key": license_key,
            "device_id": device_id
        }
        resp = self.session.post(url, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        return data.get("status") == "success"


# =========================================================================
# Local Ledger Management & Cloud Synchronization
# =========================================================================

def load_ledger() -> List[Dict[str, Any]]:
    """Load local licenses from licenses_ledger.json."""
    if not LEDGER_PATH.exists():
        return []
    try:
        with open(LEDGER_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error reading ledger {LEDGER_PATH}: {e}")
        return []

def save_ledger(ledger: List[Dict[str, Any]]) -> bool:
    """Save ledger entries to licenses_ledger.json."""
    try:
        with open(LEDGER_PATH, "w", encoding="utf-8") as f:
            json.dump(ledger, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"Error saving ledger {LEDGER_PATH}: {e}")
        return False

def record_in_ledger(entry: Dict[str, Any]) -> None:
    """Add or update an entry in local ledger."""
    ledger = load_ledger()
    norm_new = normalize_key(entry.get("licenseKey", ""))
    found_idx = -1
    for idx, item in enumerate(ledger):
        if item.get("id") == entry.get("id") or normalize_key(item.get("licenseKey", "")) == norm_new:
            found_idx = idx
            break
    if found_idx >= 0:
        ledger[found_idx].update(entry)
    else:
        ledger.append(entry)
    save_ledger(ledger)

def merge_cloud_and_ledger(
    cloud_list: List[Dict[str, Any]],
    ledger_list: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Merge Cloudflare DB results with local ledger.
    Produces rich client records with plaintext keys and live device metrics.
    """
    merged: List[Dict[str, Any]] = []
    
    # Map ledger by key_hash and by normalized key
    ledger_by_id: Dict[str, Dict[str, Any]] = {}
    ledger_by_key: Dict[str, Dict[str, Any]] = {}
    ledger_by_hash: Dict[str, Dict[str, Any]] = {}

    for item in ledger_list:
        if item.get("id"):
            ledger_by_id[item["id"]] = item
        raw_key = item.get("licenseKey", "")
        if raw_key:
            norm = normalize_key(raw_key)
            ledger_by_key[norm] = item
            h = hash_key(raw_key)
            ledger_by_hash[h] = item

    processed_ledger_ids = set()

    # Process all cloud licenses
    for cloud_item in cloud_list:
        cid = cloud_item.get("id", "")
        customer_name = cloud_item.get("customer_name", "Client Inconnu")
        
        # Try to resolve plaintext key from ledger
        matched_ledger = ledger_by_id.get(cid)
        if not matched_ledger:
            # Try matching by normalized key if available
            for leg in ledger_list:
                if leg.get("customer", "").strip().lower() == customer_name.strip().lower():
                    matched_ledger = leg
                    break

        clean_name = (matched_ledger.get("customer") if matched_ledger and matched_ledger.get("customer") else "") or customer_name
        plaintext_key = matched_ledger.get("licenseKey", "") if matched_ledger else ""
        if matched_ledger and matched_ledger.get("id"):
            processed_ledger_ids.add(matched_ledger["id"])

        record = {
            "id": cid,
            "customer": clean_name,
            "licenseKey": plaintext_key or f"[Clé Cloud {cid[:8]}]",
            "type": cloud_item.get("license_type", "LIFETIME"),
            "status": cloud_item.get("status", "active"),
            "desktops": int(cloud_item.get("max_desktops", 1)),
            "mobiles": int(cloud_item.get("max_mobiles", 1)),
            "activeDesktops": int(cloud_item.get("active_desktops", 0)),
            "activeMobiles": int(cloud_item.get("active_mobiles", 0)),
            "tursoUrl": cloud_item.get("turso_url", "") or (matched_ledger.get("tursoUrl", "") if matched_ledger else ""),
            "createdAt": cloud_item.get("created_at", "") or (matched_ledger.get("createdAt", "") if matched_ledger else ""),
            "expiresAt": cloud_item.get("expires_at"),
            "phone": matched_ledger.get("phone", "") if matched_ledger else "",
            "city": matched_ledger.get("city", "") if matched_ledger else "",
            "notes": matched_ledger.get("notes", "") if matched_ledger else "",
            "inCloud": True,
            "inLedger": matched_ledger is not None
        }
        merged.append(record)

    # Add any ledger items that haven't been synced to cloud yet
    for leg in ledger_list:
        lid = leg.get("id", "")
        if lid not in processed_ledger_ids:
            record = {
                "id": lid,
                "customer": leg.get("customer", "Client"),
                "licenseKey": leg.get("licenseKey", ""),
                "type": leg.get("type", "LIFETIME"),
                "status": "pending_sync",
                "desktops": int(leg.get("desktops", 1)),
                "mobiles": int(leg.get("mobiles", 1)),
                "activeDesktops": 0,
                "activeMobiles": 0,
                "tursoUrl": leg.get("tursoUrl", ""),
                "createdAt": leg.get("createdAt", ""),
                "expiresAt": leg.get("expiresAt"),
                "phone": leg.get("phone", ""),
                "city": leg.get("city", ""),
                "notes": leg.get("notes", ""),
                "inCloud": False,
                "inLedger": True
            }
            merged.append(record)

    return merged


def delete_from_ledger(license_id: str, license_key: str = "") -> bool:
    """Remove a license permanently from the local ledger."""
    ledger = load_ledger()
    norm_target = normalize_key(license_key) if license_key else ""
    new_ledger = []
    found = False
    for item in ledger:
        match_id = (item.get("id") == license_id) if license_id else False
        match_key = (normalize_key(item.get("licenseKey", "")) == norm_target) if norm_target else False
        if match_id or match_key:
            found = True
        else:
            new_ledger.append(item)
    if found:
        save_ledger(new_ledger)
    return found


def update_customer_metadata(
    license_key: str,
    phone: Optional[str] = None,
    city: Optional[str] = None,
    notes: Optional[str] = None,
    customer_name: Optional[str] = None
) -> bool:
    """Update phone, city, notes, or name for a client in the local ledger."""
    ledger = load_ledger()
    norm = normalize_key(license_key)
    updated = False
    for item in ledger:
        if normalize_key(item.get("licenseKey", "")) == norm:
            if phone is not None:
                item["phone"] = phone.strip()
            if city is not None:
                item["city"] = city.strip()
            if notes is not None:
                item["notes"] = notes.strip()
            if customer_name is not None and customer_name.strip():
                item["customer"] = customer_name.strip()
                item["customer_name"] = customer_name.strip()
            updated = True
            break
    if updated:
        save_ledger(ledger)
    return updated


# =========================================================================
# Audit logging
# =========================================================================
# Re-exported from core.audit so the hash-chained ledger is the single source
# of truth. The previous plaintext, append-only JSON writer has been removed:
# it had no integrity protection, so a modified file was indistinguishable
# from an original one.
from .audit import (  # noqa: E402
    LedgerIntegrityException,
    clear_audit_log,
    load_audit_log,
    record_audit_event,
)

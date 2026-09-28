"""
API Client and Ledger Storage for MobiPOS License Admin.
Communicates with Cloudflare Workers Edge and manages local audit ledger.
"""

import json
import time
from typing import List, Dict, Any, Optional, Tuple
import requests

try:
    from .config import (
        CLOUD_LICENSING_ENDPOINT,
        MASTER_ENCRYPTION_KEY,
        LEDGER_PATH,
        AUDIT_LOG_PATH
    )
    from .crypto import normalize_key, hash_key
except (ImportError, ValueError):
    from config import (
        CLOUD_LICENSING_ENDPOINT,
        MASTER_ENCRYPTION_KEY,
        LEDGER_PATH,
        AUDIT_LOG_PATH
    )
    from crypto import normalize_key, hash_key

class AdminApiClient:
    def __init__(self, endpoint: str = CLOUD_LICENSING_ENDPOINT, master_key: str = MASTER_ENCRYPTION_KEY):
        self.endpoint = endpoint.rstrip("/")
        self.master_key = master_key
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.master_key}",
            "User-Agent": "MobiPOS-AdminDesktop/2.0"
        })

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
# Administrative Audit Logging System
# =========================================================================

def record_audit_event(action: str, details: str, client_name: str = "", license_key: str = "") -> None:
    """Record an administrative action to licenses_audit.json."""
    import datetime
    events = load_audit_log()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = {
        "timestamp": now_str,
        "action": action,
        "details": details,
        "client": client_name,
        "key": license_key
    }
    events.insert(0, entry)  # Prepend newest first
    if len(events) > 500:
        events = events[:500]
    try:
        with open(AUDIT_LOG_PATH, "w", encoding="utf-8") as f:
            json.dump(events, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving audit log: {e}")


def load_audit_log() -> List[Dict[str, Any]]:
    """Load audit events from licenses_audit.json."""
    if not AUDIT_LOG_PATH.exists():
        return []
    try:
        with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def clear_audit_log() -> bool:
    """Clear all events from licenses_audit.json."""
    try:
        with open(AUDIT_LOG_PATH, "w", encoding="utf-8") as f:
            json.dump([], f, indent=2)
        return True
    except Exception:
        return False

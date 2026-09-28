//! Hardware auto-discovery + customer VFD display writer (desktop).
//!
//! - `hardware_scan_devices`: enumerates Windows spooler printers + serial
//!   ports (Windows) or serial devices (Linux/macOS). No new dependencies:
//!   Windows uses PowerShell CIM queries, Unix scans `/dev`.
//! - `hardware_update_vfd`: writes two 20-char lines to a serial VFD.
//!   The port is strictly allow-listed (COM1–COM999 on Windows,
//!   `/dev/tty{S,USB,ACM}*` on Linux, `/dev/tty.*`|`/dev/cu.*` on macOS),
//!   so a crafted port name can never open an arbitrary file for writing.
//!   The requested baud rate is validated against standard rates; the port
//!   itself is opened with OS/driver defaults (USB-serial VFDs are
//!   overwhelmingly 9600 8N1 out of the box).
//!
//! Mobile returns honest errors: the TS auto-detect hook (`useAutoDetectedHardware`)
//! degrades to manual configuration. No hotplug events are emitted yet — the
//! hook re-scans on demand, so discovery stays pull-based.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

/// Mirrors the TS `DiscoveredDevice` contract (`src/types/pos.ts`).
/// Serialized keys must stay camelCase: id / name / category /
/// portOrQueue / isUsb / description?.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub id: String,
    pub name: String,
    pub category: String,
    pub port_or_queue: String,
    pub is_usb: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl DiscoveredDevice {
    // Only called from desktop scan paths; kept for all targets to preserve API shape.
    #[cfg_attr(mobile, allow(dead_code))]
    fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        category: &str,
        port_or_queue: impl Into<String>,
        is_usb: bool,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            category: category.into(),
            port_or_queue: port_or_queue.into(),
            is_usb,
            description: None,
        }
    }
}

/// Best-effort printer classification for the TS auto-binder, which scores
/// by name anyway. Unknown spooler printers fall back to `genericSerial`
/// (visible, never auto-picked as a receipt printer) rather than risking
/// ESC/POS bytes sent to a LaserJet.
#[cfg_attr(mobile, allow(dead_code))]
fn categorize_printer(name: &str) -> &'static str {
    let lowered = name.to_lowercase();
    const LABEL_HINTS: &[&str] = &[
        "zebra", "zd", "gk420", "tsc", "ttp-", "da200", "365b", "350b", "label",
    ];
    const THERMAL_HINTS: &[&str] = &[
        "xprinter", "xp-", "epson", "tm-", "star", "tsp", "bixolon", "srp", "thermal",
        "receipt", "citizen", "ct-", "rongta", "sprt", "gprinter", "gp-",
    ];
    if LABEL_HINTS.iter().any(|hint| lowered.contains(hint)) {
        return "labelPrinter";
    }
    if THERMAL_HINTS.iter().any(|hint| lowered.contains(hint)) {
        return "thermalPrinter";
    }
    "genericSerial"
}

#[tauri::command]
pub fn hardware_scan_devices() -> Result<Vec<DiscoveredDevice>, String> {
    #[cfg(mobile)]
    {
        return Err(
            "Détection matérielle non supportée sur mobile (configuration manuelle requise)."
                .into(),
        );
    }
    #[cfg(not(mobile))]
    {
        Ok(scan_desktop_devices())
    }
}

#[cfg(not(mobile))]
fn scan_desktop_devices() -> Vec<DiscoveredDevice> {
    let mut devices = Vec::new();
    #[cfg(target_os = "windows")]
    {
        devices.extend(scan_windows_printers());
        devices.extend(scan_windows_serial_ports());
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        devices.extend(scan_unix_serial_ports());
    }
    devices
}

#[cfg(all(target_os = "windows", not(mobile)))]
fn run_powershell_json(ps_command: &str) -> Vec<serde_json::Value> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            ps_command,
        ])
        .output();
    let output = match output {
        Ok(out) if out.status.success() => out,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    match parsed {
        // ConvertTo-Json emits a bare object (not an array) for a single result.
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    }
}

#[cfg(all(target_os = "windows", not(mobile)))]
fn scan_windows_printers() -> Vec<DiscoveredDevice> {
    let mut devices = Vec::new();
    let items = run_powershell_json(
        "Get-CimInstance Win32_Printer | Select-Object Name, PortName | ConvertTo-Json -Compress -Depth 2",
    );
    for item in &items {
        let name = item
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }
        let port = item
            .get("PortName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let is_usb = port.to_uppercase().starts_with("USB");
        let mut device = DiscoveredDevice::new(
            format!("win-printer:{port}:{name}"),
            name,
            categorize_printer(name),
            port,
            is_usb,
        );
        if device.category == "genericSerial" {
            device.description =
                Some("Imprimante spooler (type à confirmer manuellement)".to_string());
        }
        devices.push(device);
    }
    devices
}

#[cfg(all(target_os = "windows", not(mobile)))]
fn scan_windows_serial_ports() -> Vec<DiscoveredDevice> {
    let mut devices = Vec::new();
    let items = run_powershell_json(
        "Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Name, Description | ConvertTo-Json -Compress -Depth 2",
    );
    for item in &items {
        let device_id = item
            .get("DeviceID")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_uppercase();
        if device_id.is_empty() {
            continue;
        }
        let name = item
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or(&device_id)
            .trim()
            .to_string();
        let description = item
            .get("Description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let is_usb = description.to_uppercase().contains("USB");
        let mut device = DiscoveredDevice::new(
            format!("win-serial:{device_id}"),
            name,
            "genericSerial",
            device_id,
            is_usb,
        );
        if !description.is_empty() {
            device.description = Some(description);
        }
        devices.push(device);
    }
    devices
}

#[cfg(all(target_os = "linux", not(mobile)))]
fn scan_unix_serial_ports() -> Vec<DiscoveredDevice> {
    scan_dev_dir(&["ttyS", "ttyUSB", "ttyACM"], true)
}

#[cfg(all(target_os = "macos", not(mobile)))]
fn scan_unix_serial_ports() -> Vec<DiscoveredDevice> {
    scan_dev_dir(&["tty.", "cu."], false)
}

/// Lists `/dev` entries with one of the given prefixes.
/// `usb_by_prefix` marks USB-backed ports when the prefix itself implies USB
/// (Linux `ttyUSB`/`ttyACM`); otherwise USB is guessed from the name.
#[cfg(all(any(target_os = "linux", target_os = "macos"), not(mobile)))]
fn scan_dev_dir(prefixes: &[&str], usb_by_prefix: bool) -> Vec<DiscoveredDevice> {
    let mut devices = Vec::new();
    let entries = match std::fs::read_dir("/dev") {
        Ok(entries) => entries,
        Err(_) => return devices,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let matched = prefixes.iter().find(|prefix| name.starts_with(**prefix));
        let Some(prefix) = matched else {
            continue;
        };
        let path = format!("/dev/{name}");
        let is_usb = if usb_by_prefix {
            *prefix != "ttyS"
        } else {
            name.to_uppercase().contains("USB")
        };
        devices.push(DiscoveredDevice::new(
            format!("unix-serial:{path}"),
            name.clone(),
            "genericSerial",
            path,
            is_usb,
        ));
    }
    devices.sort_by(|a, b| a.port_or_queue.cmp(&b.port_or_queue));
    devices
}

// ---------------------------------------------------------------------------
// Customer VFD display writer
// ---------------------------------------------------------------------------

/// Mirrors the TS call shape:
/// `{ interface: { type: 'serial', port_name, baud_rate }, item_title, total_price_formatted }`.
#[derive(Debug, Deserialize)]
pub struct VfdInterface {
    #[serde(rename = "type")]
    pub kind: String,
    pub port_name: String,
    pub baud_rate: Option<u32>,
}

// Only read from the desktop command branch; kept for all targets to preserve API shape.
#[cfg_attr(mobile, allow(dead_code))]
const STANDARD_BAUD_RATES: &[u32] = &[
    300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400,
];

fn fit_display_cell(input: &str) -> String {
    let taken: String = input.chars().take(20).collect();
    format!("{taken:<20}")
}

/// ESC @ + clear-screen + two 20-char lines. Pure function — unit-tested.
#[cfg_attr(mobile, allow(dead_code))]
pub fn build_vfd_payload(line1: &str, line2: &str) -> Vec<u8> {
    let mut out = vec![0x1Bu8, 0x40, 0x0C];
    out.extend_from_slice(fit_display_cell(line1).as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(fit_display_cell(line2).as_bytes());
    out
}

#[cfg(all(target_os = "windows", not(mobile)))]
fn sanitize_serial_port(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_uppercase();
    if let Some(number) = upper.strip_prefix("COM") {
        if !number.is_empty()
            && number.len() <= 3
            && number.bytes().all(|b| b.is_ascii_digit())
        {
            return Ok(format!("\\\\.\\COM{number}"));
        }
    }
    Err("Port série non autorisé (COM1–COM999 uniquement).".to_string())
}

#[cfg(all(not(target_os = "windows"), not(mobile)))]
fn sanitize_serial_port(raw: &str) -> Result<String, String> {
    let port = raw.trim();
    let Some(base) = port.strip_prefix("/dev/") else {
        return Err("Port série non autorisé (périphérique /dev/* uniquement).".to_string());
    };
    let charset_ok = !base.is_empty()
        && !base.contains("..")
        && !base.contains('/')
        && base
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if !charset_ok {
        return Err("Nom de port série invalide.".to_string());
    }
    #[cfg(target_os = "macos")]
    let allowed = base.starts_with("tty.") || base.starts_with("cu.");
    #[cfg(not(target_os = "macos"))]
    let allowed = ["ttyS", "ttyUSB", "ttyACM"]
        .iter()
        .any(|prefix| base.starts_with(prefix));
    if !allowed {
        return Err("Port série non autorisé pour l'afficheur VFD.".to_string());
    }
    Ok(port.to_string())
}

#[cfg(all(target_os = "windows", not(mobile)))]
mod serial {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut std::ffi::c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
        fn WriteFile(
            h_file: *mut std::ffi::c_void,
            lp_buffer: *const u8,
            n_number_of_bytes_to_write: u32,
            lp_number_of_bytes_written: *mut u32,
            lp_overlapped: *mut std::ffi::c_void,
        ) -> i32;
        fn CloseHandle(h_object: *mut std::ffi::c_void) -> i32;
    }

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;

    pub fn write_serial(path: &str, data: &[u8]) -> Result<(), String> {
        use std::ptr::null_mut;

        if data.len() > 64 * 1024 {
            return Err("Trame VFD trop volumineuse.".to_string());
        }
        let data_len: u32 = u32::try_from(data.len())
            .map_err(|_| "Taille de trame VFD invalide.".to_string())?;
        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            );
            if handle.is_null() || handle == -1isize as *mut std::ffi::c_void {
                return Err(format!("Ouverture du port série impossible ({path})."));
            }
            let mut written: u32 = 0;
            let write_ok =
                WriteFile(handle, data.as_ptr(), data_len, &mut written, null_mut());
            CloseHandle(handle);
            if write_ok == 0 || written != data_len {
                return Err("Écriture vers l'afficheur client impossible.".to_string());
            }
            Ok(())
        }
    }
}

#[cfg(all(unix, not(mobile)))]
fn write_serial_unix(path: &str, data: &[u8]) -> Result<(), String> {
    use std::io::Write;

    if data.len() > 64 * 1024 {
        return Err("Trame VFD trop volumineuse.".to_string());
    }
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|err| format!("Ouverture du port série impossible ({path}) : {err}"))?;
    handle
        .write_all(data)
        .map_err(|err| format!("Écriture vers l'afficheur client impossible : {err}"))?;
    Ok(())
}

#[cfg(not(mobile))]
fn write_serial_port(path: &str, data: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        serial::write_serial(path, data)
    }
    #[cfg(not(target_os = "windows"))]
    {
        write_serial_unix(path, data)
    }
}

#[tauri::command]
pub fn hardware_update_vfd(
    interface: VfdInterface,
    item_title: String,
    total_price_formatted: String,
) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (&interface, &item_title, &total_price_formatted);
        return Err("Afficheur client non supporté sur mobile.".to_string());
    }
    #[cfg(not(mobile))]
    {
        if interface.kind != "serial" {
            return Err("Interface VFD non supportée (serial uniquement).".to_string());
        }
        if let Some(rate) = interface.baud_rate {
            if !STANDARD_BAUD_RATES.contains(&rate) {
                return Err(format!("Vitesse série non standard : {rate} bauds."));
            }
        }
        let port = sanitize_serial_port(&interface.port_name)?;
        let payload = build_vfd_payload(&item_title, &total_price_formatted);
        write_serial_port(&port, &payload)
    }
}

const APP_HWID_SALT: &[u8] = b"mobi-pos-license-salt-v1:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareFingerprintResult {
    pub formatted: String,
    pub hash: String,
    pub platform: String,
}

fn format_hwid(raw_entropy: &str) -> (String, String) {
    let mut hasher = Sha256::new();
    hasher.update(APP_HWID_SALT);
    hasher.update(raw_entropy.as_bytes());
    let hex_digest = format!("{:x}", hasher.finalize());
    let upper = hex_digest.to_uppercase();
    let g1 = &upper[0..4];
    let g2 = &upper[4..8];
    let g3 = &upper[8..12];
    let g4 = &upper[12..16];
    (format!("MOBI-{g1}-{g2}-{g3}-{g4}"), hex_digest)
}

#[cfg(target_os = "windows")]
fn get_platform_raw_hwid() -> (String, String) {
    use winreg::enums::*;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let machine_guid = hklm
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ)
        .and_then(|crypto| crypto.get_value::<String, _>("MachineGuid"))
        .unwrap_or_else(|_| "UNKNOWN_WINDOWS_GUID".to_string());

    let board = hklm
        .open_subkey_with_flags(r"HARDWARE\DESCRIPTION\System\BIOS", KEY_READ)
        .ok()
        .and_then(|bios| bios.get_value::<String, _>("BaseBoardProduct").ok())
        .unwrap_or_else(|| "GENERIC_BOARD".to_string());

    (format!("win:{}:{}", machine_guid.trim(), board.trim()), "windows".to_string())
}

#[cfg(target_os = "android")]
fn get_platform_raw_hwid(app: &tauri::AppHandle) -> (String, String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join(".android_device_id");
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return (format!("android:{}", trimmed), "android".to_string());
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let minted = format!("droid-{:x}", now);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, &minted);
        return (format!("android:{}", minted), "android".to_string());
    }
    ("android:fallback-device-id".to_string(), "android".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn get_platform_raw_hwid() -> (String, String) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
            return (format!("linux:{}", id.trim()), "linux".to_string());
        }
    }
    ("generic:pos-terminal".to_string(), "fallback".to_string())
}

#[tauri::command]
pub fn get_hardware_fingerprint(app_handle: tauri::AppHandle) -> Result<HardwareFingerprintResult, String> {
    #[cfg(target_os = "windows")]
    let (raw, platform) = {
        let _ = &app_handle;
        get_platform_raw_hwid()
    };

    #[cfg(target_os = "android")]
    let (raw, platform) = get_platform_raw_hwid(&app_handle);

    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let (raw, platform) = {
        let _ = &app_handle;
        get_platform_raw_hwid()
    };

    let (formatted, hash) = format_hwid(&raw);
    Ok(HardwareFingerprintResult { formatted, hash, platform })
}

fn get_license_vault_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".license_token.vault"))
}

#[tauri::command]
pub fn get_license_token(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(entry) = keyring::Entry::new("mobi-pos-license", "token") {
            match entry.get_password() {
                Ok(token) => return Ok(Some(token)),
                Err(keyring::Error::NoEntry) => {}
                Err(e) => eprintln!("[license] keyring read failed: {e}"),
            }
        }
    }

    let vault_path = get_license_vault_path(&app_handle)?;
    if vault_path.exists() {
        let data = std::fs::read_to_string(&vault_path).map_err(|e| e.to_string())?;
        let trimmed = data.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn set_license_token(app_handle: tauri::AppHandle, token: String) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(entry) = keyring::Entry::new("mobi-pos-license", "token") {
            if let Ok(()) = entry.set_password(&token) {
                if let Ok(path) = get_license_vault_path(&app_handle) {
                    let _ = std::fs::remove_file(path);
                }
                return Ok(());
            }
        }
    }

    let vault_path = get_license_vault_path(&app_handle)?;
    std::fs::write(&vault_path, token).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_license_token(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(entry) = keyring::Entry::new("mobi-pos-license", "token") {
            let _ = entry.delete_credential();
        }
    }

    let vault_path = get_license_vault_path(&app_handle)?;
    if vault_path.exists() {
        let _ = std::fs::remove_file(vault_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discovered_device_matches_ts_contract() {
        let device = DiscoveredDevice::new(
            "win-serial:COM3",
            "COM3",
            "genericSerial",
            "COM3",
            false,
        );
        let value = serde_json::to_value(&device).expect("device must serialize");
        assert_eq!(value["id"], "win-serial:COM3");
        assert_eq!(value["name"], "COM3");
        assert_eq!(value["category"], "genericSerial");
        assert_eq!(value["portOrQueue"], "COM3");
        assert_eq!(value["isUsb"], false);
        // `description` is omitted when None (TS field is optional).
        assert!(value.get("description").is_none());
    }

    #[test]
    fn test_categorize_printer_keywords() {
        assert_eq!(categorize_printer("XP-80C Thermal"), "thermalPrinter");
        assert_eq!(categorize_printer("Epson TM-T20III"), "thermalPrinter");
        assert_eq!(categorize_printer("Zebra GK420d"), "labelPrinter");
        assert_eq!(categorize_printer("TSC DA200"), "labelPrinter");
        // Unknown spooler printers stay visible but are never auto-picked.
        assert_eq!(categorize_printer("HP LaserJet Pro"), "genericSerial");
        assert_eq!(categorize_printer("Microsoft Print to PDF"), "genericSerial");
    }

    #[test]
    fn test_vfd_payload_shape_two_lines() {
        let payload = build_vfd_payload("Croissant", "Total 250 DA");
        assert_eq!(&payload[0..3], &[0x1B, 0x40, 0x0C]);
        let text = String::from_utf8_lossy(&payload[3..]);
        assert!(text.contains("Croissant"));
        assert!(text.contains("Total 250 DA"));
        // 20-char line + CRLF + 20-char line.
        assert_eq!(payload.len(), 3 + 20 + 2 + 20);
    }

    #[test]
    fn test_vfd_payload_truncates_long_lines() {
        let payload = build_vfd_payload("0123456789ABCDEFGHIJ-extra-long-line", "x");
        assert_eq!(payload.len(), 3 + 20 + 2 + 20);
        let text = String::from_utf8_lossy(&payload[3..]);
        assert!(text.starts_with("0123456789ABCDEFGHIJ"));
        assert!(!text.contains("extra-long"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_sanitize_windows_ports() {
        assert_eq!(sanitize_serial_port("COM3").unwrap(), "\\\\.\\COM3");
        assert_eq!(sanitize_serial_port("com12").unwrap(), "\\\\.\\COM12");
        assert!(sanitize_serial_port("COM").is_err());
        assert!(sanitize_serial_port("COM9999").is_err());
        assert!(sanitize_serial_port("C:\\Windows\\System32\\evil.dll").is_err());
        assert!(sanitize_serial_port("COM1 & del C:\\").is_err());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    #[test]
    fn test_sanitize_linux_ports() {
        assert_eq!(
            sanitize_serial_port("/dev/ttyUSB0").unwrap(),
            "/dev/ttyUSB0"
        );
        assert_eq!(sanitize_serial_port("/dev/ttyS1").unwrap(), "/dev/ttyS1");
        assert!(sanitize_serial_port("/etc/passwd").is_err());
        assert!(sanitize_serial_port("/dev/../etc/shadow").is_err());
        assert!(sanitize_serial_port("COM3").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_sanitize_macos_ports() {
        assert!(sanitize_serial_port("/dev/tty.usbserial-0001").is_ok());
        assert!(sanitize_serial_port("/dev/cu.usbserial-0001").is_ok());
        assert!(sanitize_serial_port("/etc/passwd").is_err());
        assert!(sanitize_serial_port("/dev/ttyUSB0").is_err());
    }
}

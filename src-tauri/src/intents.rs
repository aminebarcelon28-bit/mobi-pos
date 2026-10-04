// Native Intent & URL Opener Module — Bug Fix F-01 (v1.7.0)
// Gated with an allow-list for tel:, mailto:, and WhatsApp URLs to prevent arbitrary protocol execution.

use serde::de::DeserializeOwned;
use tauri::{plugin::{Builder as PluginBuilder, PluginApi, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::trust_core::{
    capability_policy::Capability,
    ipc_authorizer::{authorize_and_execute, TrustError},
};

const ALLOWED_HOSTS: &[&str] = &["wa.me", "api.whatsapp.com"];

fn normalize_phone_for_call(phone: &str) -> String {
    phone
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '+')
        .collect()
}

#[cfg(target_os = "android")]
const PHONE_PLUGIN_IDENTIFIER: &str = "com.mobi.pos";

#[cfg(target_os = "android")]
struct PhonePlugin<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    {
        let handle = api.register_android_plugin(PHONE_PLUGIN_IDENTIFIER, "PhonePlugin")?;
        app.manage(PhonePlugin(handle));
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, api);
    Ok(())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R, ()>::new("phone")
        .setup(init)
        .build()
}

pub fn is_url_allowed(raw_url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(raw_url) {
        let scheme = parsed.scheme();
        if scheme == "tel" || scheme == "mailto" {
            return true;
        }
        if scheme == "https" {
            if let Some(host) = parsed.host_str() {
                return ALLOWED_HOSTS.contains(&host);
            }
        }
    }
    false
}

#[tauri::command]
pub fn launch_dialer(app: tauri::AppHandle, phone: String) -> Result<(), TrustError> {
    authorize_and_execute("launch_dialer", Capability::HardwareOperations, |_| {
        let clean_phone = normalize_phone_for_call(&phone);
        if clean_phone.is_empty() {
            return Err(TrustError::IPCProtocolError {
                reason: "numéro de téléphone vide",
            });
        }
        let tel_url = format!("tel:{}", clean_phone);
        app.opener()
            .open_url(&tel_url, None::<&str>)
            .map_err(TrustError::op_failed)
    })
}

#[tauri::command]
pub fn launch_call<R: Runtime>(app: AppHandle<R>, phone: String) -> Result<(), TrustError> {
    authorize_and_execute("launch_call", Capability::HardwareOperations, |_| {
        let clean_phone = normalize_phone_for_call(&phone);
        if clean_phone.is_empty() {
            return Err(TrustError::IPCProtocolError {
                reason: "numéro de téléphone vide",
            });
        }

        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>("call", serde_json::json!({ "phone": clean_phone }))
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            app.opener()
                .open_url(format!("tel:{clean_phone}"), None::<&str>)
                .map_err(TrustError::op_failed)
        }
    })
}

#[tauri::command]
pub fn launch_whatsapp<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), TrustError> {
    authorize_and_execute("launch_whatsapp", Capability::HardwareOperations, |_| {
        if !is_url_allowed(&url) {
            eprintln!("[trust_core][deny] launch_whatsapp: URL non autorisée bloquée");
            return Err(TrustError::op_failed(format!("URL non autorisée : {}", url)));
        }
        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>("whatsapp", serde_json::json!({ "url": url }))
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            app.opener().open_url(&url, None::<&str>).map_err(TrustError::op_failed)
        }
    })
}

#[tauri::command]
pub fn launch_print<R: Runtime>(app: AppHandle<R>, title: String, content: String) -> Result<(), TrustError> {
    authorize_and_execute("launch_print", Capability::HardwareOperations, |_| {
        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>("print", serde_json::json!({ "title": title, "content": content }))
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, title, content);
            Err(TrustError::op_failed(
                "Impression native disponible uniquement sur Android",
            ))
        }
    })
}

#[tauri::command]
pub fn launch_print_label<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    image_base64: String,
    width_mm: f64,
    height_mm: f64,
    copies: i32,
) -> Result<(), TrustError> {
    authorize_and_execute("launch_print_label", Capability::HardwareOperations, |_| {
        if image_base64.len() > 16 * 1024 * 1024 {
            return Err(TrustError::IPCProtocolError {
                reason: "image d'étiquette oversized",
            });
        }
        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>(
                    "printLabel",
                    serde_json::json!({
                        "title": title,
                        "imageBase64": image_base64,
                        "widthMm": width_mm,
                        "heightMm": height_mm,
                        "copies": copies,
                    }),
                )
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, title, image_base64, width_mm, height_mm, copies);
            Err(TrustError::op_failed(
                "Impression d'étiquettes native disponible uniquement sur Android",
            ))
        }
    })
}

/// Raw TCP print to a Wi-Fi thermal/label printer (default port 9100).
/// Accepts ESC/POS, TSPL or ZPL bytes as base64 — the printer language is
/// chosen frontend-side from the configured model.
#[tauri::command]
pub fn mobile_wifi_print<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    port: u16,
    data_base64: String,
) -> Result<(), TrustError> {
    authorize_and_execute("mobile_wifi_print", Capability::HardwareOperations, |_| {
        if data_base64.len() > 16 * 1024 * 1024 {
            return Err(TrustError::IPCProtocolError {
                reason: "données d'impression oversized",
            });
        }
        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>(
                    "wifiPrint",
                    serde_json::json!({
                        "host": host,
                        "port": port,
                        "dataBase64": data_base64,
                    }),
                )
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, host, port, data_base64);
            Err(TrustError::op_failed(
                "Impression Wi-Fi disponible uniquement sur Android",
            ))
        }
    })
}

/// Lists Bluetooth printers already paired in Android settings
/// (no location permission needed for bonded devices).
#[tauri::command]
pub fn mobile_bluetooth_printers<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, TrustError> {
    authorize_and_execute(
        "mobile_bluetooth_printers",
        Capability::HardwareOperations,
        |_| {
            #[cfg(target_os = "android")]
            {
                let plugin = app.state::<PhonePlugin<R>>();
                plugin
                    .0
                    .run_mobile_plugin::<serde_json::Value>("bluetoothPrinters", serde_json::json!({}))
                    .map_err(TrustError::op_failed)
            }

            #[cfg(not(target_os = "android"))]
            {
                let _ = app;
                Err(TrustError::op_failed(
                    "Bluetooth disponible uniquement sur Android",
                ))
            }
        },
    )
}

/// Raw SPP/RFCOMM print to a paired Bluetooth printer (ESC/POS, TSPL, ZPL).
#[tauri::command]
pub fn mobile_bluetooth_print<R: Runtime>(
    app: AppHandle<R>,
    mac: String,
    data_base64: String,
) -> Result<(), TrustError> {
    authorize_and_execute("mobile_bluetooth_print", Capability::HardwareOperations, |_| {
        if data_base64.len() > 16 * 1024 * 1024 {
            return Err(TrustError::IPCProtocolError {
                reason: "données d'impression oversized",
            });
        }
        #[cfg(target_os = "android")]
        {
            let plugin = app.state::<PhonePlugin<R>>();
            plugin
                .0
                .run_mobile_plugin::<()>(
                    "bluetoothPrint",
                    serde_json::json!({
                        "mac": mac,
                        "dataBase64": data_base64,
                    }),
                )
                .map_err(TrustError::op_failed)
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, mac, data_base64);
            Err(TrustError::op_failed(
                "Impression Bluetooth disponible uniquement sur Android",
            ))
        }
    })
}

#[tauri::command]
pub fn launch_url(app: tauri::AppHandle, url: String) -> Result<(), TrustError> {
    authorize_and_execute("launch_url", Capability::HardwareOperations, |_| {
        if !is_url_allowed(&url) {
            eprintln!("[trust_core][deny] launch_url: URL non autorisée bloquée");
            return Err(TrustError::op_failed(format!("URL non autorisée : {}", url)));
        }
        app.opener().open_url(&url, None::<&str>).map_err(TrustError::op_failed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_allow_list() {
        assert!(is_url_allowed("tel:+213550123456"));
        assert!(is_url_allowed("mailto:support@mobipos.dz"));
        assert!(is_url_allowed("https://wa.me/213550123456?text=Bonjour"));
        assert!(is_url_allowed("https://api.whatsapp.com/send?phone=213550123456"));
        // Disallowed URLs
        assert!(!is_url_allowed("http://malicious.com"));
        assert!(!is_url_allowed("https://attacker.com/?token=secret"));
        assert!(!is_url_allowed("javascript:alert(1)"));
        assert!(!is_url_allowed("file:///etc/passwd"));
    }

    #[test]
    fn direct_call_cleans_phone_input() {
        assert_eq!(normalize_phone_for_call("+213 550-12-34-56"), "+213550123456");
    }
}


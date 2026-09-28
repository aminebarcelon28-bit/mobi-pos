//! Native PO invoice document scanner (Android ML Kit / iOS VisionKit).
//!
//! Android runtime binding for the Kotlin `DocumentScannerPlugin`
//! (`com.tauri.plugins.scanner`): GMS document capture + on-device text
//! recognition, emitting normalized OCR boxes for `geometry.rs` via
//! `po_process_raw_scan`.
//!
//! Exposes both `scanner::plugin()` and the direct Tauri command
//! `mobile_scan_document` to avoid ACL capability permission blocks.

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{Builder as PluginBuilder, PluginApi, TauriPlugin},
    AppHandle, Runtime,
};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

#[cfg(target_os = "android")]
const SCANNER_PLUGIN_IDENTIFIER: &str = "com.tauri.plugins.scanner";

#[cfg(any(target_os = "android", target_os = "ios"))]
struct ScannerPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    {
        match api.register_android_plugin(SCANNER_PLUGIN_IDENTIFIER, "DocumentScannerPlugin") {
            Ok(handle) => {
                app.manage(ScannerPlugin(handle));
            }
            Err(e) => {
                eprintln!("[scanner] Android DocumentScannerPlugin registration error: {}", e);
            }
        }
    }
    #[cfg(target_os = "ios")]
    {
        match api.register_ios_plugin("DocumentScannerPlugin") {
            Ok(handle) => {
                app.manage(ScannerPlugin(handle));
            }
            Err(e) => {
                eprintln!("[scanner] iOS DocumentScannerPlugin registration error: {}", e);
            }
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = (app, api);
    Ok(())
}

/// Invokes the native Document Scanner UI on mobile (Android GMS / iOS VisionKit)
/// and returns OCR bounding boxes.
#[tauri::command]
pub async fn mobile_scan_document<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        if let Some(plugin) = app.try_state::<ScannerPlugin<R>>() {
            plugin
                .0
                .run_mobile_plugin::<serde_json::Value>("scanDocument", serde_json::json!({}))
                .map_err(|error| error.to_string())
        } else {
            Err("Module Android DocumentScannerPlugin non disponible sur ce build.".to_string())
        }
    }
    #[cfg(target_os = "ios")]
    {
        if let Some(plugin) = app.try_state::<ScannerPlugin<R>>() {
            plugin
                .0
                .run_mobile_plugin::<serde_json::Value>("scanDocument", serde_json::json!({}))
                .map_err(|error| error.to_string())
        } else {
            Err("Module iOS DocumentScannerPlugin non disponible sur cet appareil.".to_string())
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err("Le scanner caméra ML Kit est uniquement disponible sur smartphone Android ou iPhone.".to_string())
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R, ()>::new("scanner")
        .setup(init)
        .build()
}

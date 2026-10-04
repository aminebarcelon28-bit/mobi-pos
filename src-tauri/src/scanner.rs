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

use crate::trust_core::{
    capability_policy::Capability,
    ipc_authorizer::{require_capability, TrustError},
};

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
///
/// Phase 1: authorized via an entry check (async entry points cannot hold the
/// kernel read guard across `.await`). The scan itself is read-only device
/// capture; downstream stock writes re-authorize through `po_commit_*`.
#[tauri::command]
pub async fn mobile_scan_document<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, TrustError> {
    // Entry authorization first: an unauthorized caller never reaches the
    // platform plugin. No mutating commit happens in this handler.
    let _auth = require_capability("mobile_scan_document", Capability::HardwareOperations)?;
    #[cfg(target_os = "android")]
    {
        if let Some(plugin) = app.try_state::<ScannerPlugin<R>>() {
            plugin
                .0
                .run_mobile_plugin::<serde_json::Value>("scanDocument", serde_json::json!({}))
                .map_err(TrustError::op_failed)
        } else {
            Err(TrustError::op_failed("Module Android DocumentScannerPlugin non disponible sur ce build."))
        }
    }
    #[cfg(target_os = "ios")]
    {
        if let Some(plugin) = app.try_state::<ScannerPlugin<R>>() {
            plugin
                .0
                .run_mobile_plugin::<serde_json::Value>("scanDocument", serde_json::json!({}))
                .map_err(TrustError::op_failed)
        } else {
            Err(TrustError::op_failed("Module iOS DocumentScannerPlugin non disponible sur cet appareil."))
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(TrustError::op_failed("Le scanner caméra ML Kit est uniquement disponible sur smartphone Android ou iPhone."))
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R, ()>::new("scanner")
        .setup(init)
        .build()
}

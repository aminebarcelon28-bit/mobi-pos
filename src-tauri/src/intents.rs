// Native Intent & URL Opener Module — Bug Fix F-01 (v1.7.0)
// Gated with an allow-list for tel:, mailto:, and WhatsApp URLs to prevent arbitrary protocol execution.

use serde::de::DeserializeOwned;
use tauri::{plugin::{Builder as PluginBuilder, PluginApi, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri_plugin_opener::OpenerExt;

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
pub fn launch_dialer(app: tauri::AppHandle, phone: String) -> Result<(), String> {
    let clean_phone = normalize_phone_for_call(&phone);
    if clean_phone.is_empty() {
        return Err("Numéro de téléphone vide".to_string());
    }
    let tel_url = format!("tel:{}", clean_phone);
    app.opener().open_url(&tel_url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launch_call<R: Runtime>(app: AppHandle<R>, phone: String) -> Result<(), String> {
    let clean_phone = normalize_phone_for_call(&phone);
    if clean_phone.is_empty() {
        return Err("Numéro de téléphone vide".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<PhonePlugin<R>>();
        plugin
            .0
            .run_mobile_plugin::<()>("call", serde_json::json!({ "phone": clean_phone }))
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        app.opener()
            .open_url(format!("tel:{clean_phone}"), None::<&str>)
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn launch_whatsapp<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !is_url_allowed(&url) {
        return Err(format!("URL non autorisée : {}", url));
    }
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<PhonePlugin<R>>();
        plugin
            .0
            .run_mobile_plugin::<()>("whatsapp", serde_json::json!({ "url": url }))
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn launch_print<R: Runtime>(app: AppHandle<R>, title: String, content: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<PhonePlugin<R>>();
        plugin
            .0
            .run_mobile_plugin::<()>("print", serde_json::json!({ "title": title, "content": content }))
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, title, content);
        Err("Impression native disponible uniquement sur Android".to_string())
    }
}

#[tauri::command]
pub fn launch_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_url_allowed(&url) {
        return Err(format!("URL non autorisée : {}", url));
    }
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
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


fn main() {
    // The embedded WebDriver plugin is an optional dependency of the `e2e`
    // feature. Its ACL permission lives in capabilities/e2e/, which is only
    // globbed when that feature is on — a production build that referenced
    // `wdio-webdriver:default` without the plugin would fail ACL validation
    // (and, before this split, production granted the permission outright).
    let pattern = if std::env::var_os("CARGO_FEATURE_E2E").is_some() {
        "./capabilities/**/*.json"
    } else {
        "./capabilities/*.json"
    };
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern))
        .expect("tauri-build failed");
}

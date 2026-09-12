// Thin passthrough — ALL logic lives in lib.rs (required for Tauri mobile).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mobi_pos_lib::run();
}

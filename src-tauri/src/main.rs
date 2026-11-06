#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod splitter;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct AppState {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

#[tauri::command]
async fn scan_videos(paths: Vec<String>, recursive: bool) -> Result<Vec<splitter::VideoEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || splitter::scan(&paths, recursive))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn split_video(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    threshold_mib: f64,
    chunk_mib: f64,
    out_dir: Option<String>,
) -> Result<splitter::SplitResult, String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("Đang có một video được xử lý".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let opts = splitter::SplitOptions { path, threshold_mib, chunk_mib, out_dir };

    let result = tauri::async_runtime::spawn_blocking(move || {
        splitter::split(&opts, &cancel, |p| {
            let _ = app.emit("split-progress", p);
        })
    })
    .await;

    state.busy.store(false, Ordering::SeqCst);
    result.map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_split(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![scan_videos, split_video, cancel_split])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

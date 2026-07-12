pub mod error;
pub mod files;
pub mod filters;
pub mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(files::AppState::default())
        .invoke_handler(tauri::generate_handler![
            files::open_files,
            files::reload_file,
            files::close_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Parquet Viewer");
}

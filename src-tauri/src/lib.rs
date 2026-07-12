pub mod error;
pub mod files;
pub mod filters;
pub mod models;
pub mod query;

#[derive(Default)]
pub struct AppState {
    pub files: files::FileRegistry,
    pub queries: query::QueryService,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            files::open_files,
            files::reload_file,
            files::close_file,
            query::start_query,
            query::fetch_query_batch,
            query::cancel_query
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Parquet Viewer");
}

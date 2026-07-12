pub mod error;
pub mod files;
pub mod filters;
pub mod models;
pub mod query;
pub mod session;

use std::path::PathBuf;

use tauri::Manager;

pub struct AppState {
    pub files: files::FileRegistry,
    pub queries: query::QueryService,
    pub sessions: session::SessionStore,
}

impl AppState {
    fn with_session_path(path: PathBuf) -> Self {
        Self {
            files: files::FileRegistry::default(),
            queries: query::QueryService::default(),
            sessions: session::SessionStore::new(path),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::with_session_path(std::env::temp_dir().join(format!(
            "parquet-viewer-test-session-{}.json",
            uuid::Uuid::new_v4()
        )))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let session_path = app.path().app_config_dir()?.join("session.json");
            app.manage(AppState::with_session_path(session_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::open_files,
            files::reload_file,
            files::close_file,
            query::start_query,
            query::start_filter_query,
            query::fetch_query_batch,
            query::cancel_query,
            session::load_session,
            session::save_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Parquet Viewer");
}

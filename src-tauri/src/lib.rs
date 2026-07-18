pub mod error;
pub mod export;
pub mod files;
pub mod filters;
pub mod models;
pub mod query;
pub mod session;
pub mod settings;

use std::path::PathBuf;

use tauri::Manager;

pub struct AppState {
    pub exports: export::ExportService,
    pub files: files::FileRegistry,
    pub queries: query::QueryService,
    pub settings: settings::SettingsStore,
    pub sessions: session::SessionStore,
}

impl AppState {
    fn with_config_paths(session_path: PathBuf, settings_path: PathBuf) -> Self {
        let settings = settings::SettingsStore::new(settings_path);
        let runtime = settings.load().runtime();
        let exports = export::ExportService::default();
        exports.update_settings(runtime.clone());
        let queries = query::QueryService::default();
        queries.update_settings(runtime);
        Self {
            exports,
            files: files::FileRegistry::default(),
            queries,
            settings,
            sessions: session::SessionStore::new(session_path),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        let id = uuid::Uuid::new_v4();
        let base = std::env::temp_dir();
        Self::with_config_paths(
            base.join(format!("parquet-viewer-test-session-{id}.json")),
            base.join(format!("parquet-viewer-test-settings-{id}.json")),
        )
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::with_config_paths(
                config_dir.join("session.json"),
                config_dir.join("settings.json"),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::open_files,
            files::reload_file,
            files::check_file_changed,
            files::close_file,
            query::start_query,
            query::start_filter_query,
            query::fetch_query_batch,
            query::cancel_query,
            query::cancel_file_queries,
            export::inspect_export,
            export::start_export,
            export::cancel_export,
            settings::load_settings,
            settings::save_settings,
            session::load_session,
            session::save_session
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Parquet Viewer");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<AppState>();
            state.queries.cancel_all();
            state.exports.cancel_all();
        }
    });
}

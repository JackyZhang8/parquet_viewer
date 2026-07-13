use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

use duckdb::InterruptHandle;
use parking_lot::{Condvar, Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::files::{FileRegistry, QuerySource};
use crate::filters::{BoundValue, compile_filter_export_query};
use crate::models::{ExportProgress, ExportRequest, ExportSource, ExportStarted, ExportStatus};
use crate::query::validate_user_sql;
use crate::query::worker::{
    bound_to_duck_value, create_data_view, open_configured_connection, quote_sql_string,
    restrict_external_access_to_paths, safe_sql_error,
};

const MAX_SQL_BYTES: usize = 256 * 1024;
const MAX_COMPLETED_EXPORTS: usize = 64;

struct ExportTask {
    file_id: String,
    cancelled: Arc<AtomicBool>,
    interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
}

#[derive(Default)]
struct ExportState {
    active: HashMap<String, ExportTask>,
    completed: HashMap<String, ExportProgress>,
    completion_order: Vec<String>,
}

#[derive(Clone, Default)]
pub struct ExportService {
    state: Arc<Mutex<ExportState>>,
    changed: Arc<Condvar>,
    runtime_settings: Arc<RwLock<crate::settings::RuntimeSettings>>,
}

struct ExportPlan {
    export_id: String,
    source: QuerySource,
    sql: String,
    params: Vec<BoundValue>,
    destination: PathBuf,
    temporary: PathBuf,
    overwrite: bool,
    runtime_settings: crate::settings::RuntimeSettings,
}

impl ExportService {
    pub(crate) fn update_settings(&self, settings: crate::settings::RuntimeSettings) {
        *self.runtime_settings.write() = settings;
    }

    pub fn start_export<F>(
        &self,
        request: ExportRequest,
        files: &FileRegistry,
        notify: F,
    ) -> Result<ExportStarted, AppError>
    where
        F: Fn(ExportProgress) + Send + Sync + 'static,
    {
        let destination = validate_destination(&request.destination, request.overwrite)?;
        let source = files.resolve_query_source(&request.file_id)?;
        let metadata = files
            .get(&request.file_id)
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        let (sql, params) = match request.source {
            ExportSource::Sql { sql } => {
                if sql.len() > MAX_SQL_BYTES {
                    return Err(AppError::InvalidArgument(
                        "SQL must not exceed 262144 UTF-8 bytes".into(),
                    ));
                }
                (validate_user_sql(&sql)?, Vec::new())
            }
            ExportSource::Filter { query } => {
                let path = source
                    .duckdb_path
                    .to_str()
                    .ok_or_else(|| AppError::InvalidPath("File path is not valid UTF-8".into()))?;
                let compiled = compile_filter_export_query(path, &metadata.columns, &query)?;
                (compiled.sql, compiled.params)
            }
        };
        let export_id = Uuid::new_v4().to_string();
        let temporary = temporary_sibling(&destination, &export_id)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let interrupt = Arc::new(Mutex::new(None));
        self.state.lock().active.insert(
            export_id.clone(),
            ExportTask {
                file_id: request.file_id,
                cancelled: cancelled.clone(),
                interrupt: interrupt.clone(),
            },
        );
        let plan = ExportPlan {
            export_id: export_id.clone(),
            source,
            sql,
            params,
            destination,
            temporary,
            overwrite: request.overwrite,
            runtime_settings: self.runtime_settings.read().clone(),
        };
        let service = self.clone();
        let files = files.clone();
        let notify = Arc::new(notify);
        let spawn = thread::Builder::new()
            .name(format!("parquet-export-{export_id}"))
            .spawn(move || {
                service.run_export(plan, files, cancelled, interrupt, notify);
            });
        if let Err(error) = spawn {
            self.state.lock().active.remove(&export_id);
            return Err(AppError::Internal(format!(
                "failed to start export worker: {error}"
            )));
        }
        Ok(ExportStarted { export_id })
    }

    fn run_export(
        &self,
        plan: ExportPlan,
        files: FileRegistry,
        cancelled: Arc<AtomicBool>,
        interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
        notify: Arc<dyn Fn(ExportProgress) + Send + Sync>,
    ) {
        notify(ExportProgress {
            export_id: plan.export_id.clone(),
            status: ExportStatus::Running,
            rows_written: 0,
            error: None,
        });
        let result = run_export_inner(&plan, &files, &cancelled, &interrupt);
        *interrupt.lock() = None;
        if result.is_err() {
            let _ = fs::remove_file(&plan.temporary);
        }
        let terminal = match result {
            Ok(rows_written) => ExportProgress {
                export_id: plan.export_id.clone(),
                status: ExportStatus::Completed,
                rows_written,
                error: None,
            },
            Err(AppError::Cancelled(message)) => ExportProgress {
                export_id: plan.export_id.clone(),
                status: ExportStatus::Cancelled,
                rows_written: 0,
                error: Some(AppError::Cancelled(message)),
            },
            Err(error) if cancelled.load(Ordering::Acquire) => ExportProgress {
                export_id: plan.export_id.clone(),
                status: ExportStatus::Cancelled,
                rows_written: 0,
                error: Some(AppError::Cancelled("The export was cancelled".into())),
            },
            Err(error) => ExportProgress {
                export_id: plan.export_id.clone(),
                status: ExportStatus::Error,
                rows_written: 0,
                error: Some(error),
            },
        };
        self.finish(terminal.clone());
        notify(terminal);
    }

    fn finish(&self, terminal: ExportProgress) {
        let mut state = self.state.lock();
        state.active.remove(&terminal.export_id);
        state.completion_order.push(terminal.export_id.clone());
        state.completed.insert(terminal.export_id.clone(), terminal);
        while state.completion_order.len() > MAX_COMPLETED_EXPORTS {
            let oldest = state.completion_order.remove(0);
            state.completed.remove(&oldest);
        }
        self.changed.notify_all();
    }

    pub fn cancel_export(&self, export_id: &str) -> Result<(), AppError> {
        let state = self.state.lock();
        let task = state
            .active
            .get(export_id)
            .ok_or_else(|| AppError::InvalidArgument("Unknown export ID".into()))?;
        task.cancelled.store(true, Ordering::Release);
        if let Some(interrupt) = task.interrupt.lock().as_ref() {
            interrupt.interrupt();
        }
        Ok(())
    }

    pub fn close_file(&self, file_id: &str) {
        let ids = self
            .state
            .lock()
            .active
            .iter()
            .filter(|(_, task)| task.file_id == file_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.cancel_export(&id);
        }
    }

    pub fn cancel_all(&self) {
        let ids = self.state.lock().active.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let _ = self.cancel_export(&id);
        }
    }

    #[cfg(test)]
    fn wait_for_terminal_for_test(
        &self,
        export_id: &str,
        timeout: Duration,
    ) -> Option<ExportProgress> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock();
        loop {
            if let Some(progress) = state.completed.get(export_id) {
                return Some(progress.clone());
            }
            let remaining = deadline.checked_duration_since(Instant::now())?;
            if self.changed.wait_for(&mut state, remaining).timed_out() {
                return state.completed.get(export_id).cloned();
            }
        }
    }

    #[cfg(test)]
    fn active_count_for_test(&self) -> usize {
        self.state.lock().active.len()
    }
}

fn run_export_inner(
    plan: &ExportPlan,
    files: &FileRegistry,
    cancelled: &AtomicBool,
    interrupt: &Mutex<Option<Arc<InterruptHandle>>>,
) -> Result<u64, AppError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled("The export was cancelled".into()));
    }
    let connection = open_configured_connection(
        &format!("export-{}", plan.export_id),
        &plan.runtime_settings,
    )?;
    *interrupt.lock() = Some(connection.interrupt_handle());
    files.revalidate_query_source(&plan.source)?;
    create_data_view(&connection, &plan.source)?;
    restrict_external_access_to_paths(
        &connection,
        &[plan.source.duckdb_path.as_path(), plan.temporary.as_path()],
    )?;
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled("The export was cancelled".into()));
    }
    let destination = quote_sql_string(&plan.temporary)?;
    let copy_sql = format!(
        "COPY ({}) TO {destination} (FORMAT CSV, HEADER, NULL '')",
        plan.sql
    );
    let values = plan
        .params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut statement = connection.prepare(&copy_sql).map_err(export_sql_error)?;
    let rows_written = statement
        .query_row(duckdb::params_from_iter(values.iter()), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(export_sql_error)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled("The export was cancelled".into()));
    }
    commit_temporary(&plan.temporary, &plan.destination, plan.overwrite)?;
    u64::try_from(rows_written)
        .map_err(|_| AppError::Internal("DuckDB returned a negative export row count".into()))
}

fn export_sql_error(error: duckdb::Error) -> AppError {
    safe_sql_error(error)
}

fn validate_destination(destination: &str, overwrite: bool) -> Result<PathBuf, AppError> {
    if destination.is_empty() || destination.contains('\0') {
        return Err(AppError::InvalidPath(
            "Export destination is invalid".into(),
        ));
    }
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() {
        return Err(AppError::InvalidPath(
            "Export destination must be an absolute path".into(),
        ));
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            AppError::InvalidPath("Export destination has no parent directory".into())
        })?;
    if !parent.is_dir() {
        return Err(AppError::InvalidPath(
            "Export destination directory does not exist".into(),
        ));
    }
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() {
            return Err(AppError::InvalidPath(
                "Export destination must not be a symbolic link".into(),
            ));
        }
        if metadata.is_dir() {
            return Err(AppError::InvalidPath(
                "Export destination must be a file path".into(),
            ));
        }
        if !overwrite {
            return Err(AppError::InvalidArgument(
                "Export destination already exists".into(),
            ));
        }
    }
    Ok(destination)
}

fn temporary_sibling(destination: &Path, export_id: &str) -> Result<PathBuf, AppError> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidPath("Export file name is not valid UTF-8".into()))?;
    Ok(destination.with_file_name(format!(".{name}.{export_id}.part")))
}

fn commit_temporary(temporary: &Path, destination: &Path, overwrite: bool) -> Result<(), AppError> {
    if !overwrite && destination.exists() {
        return Err(AppError::InvalidArgument(
            "Export destination already exists".into(),
        ));
    }
    #[cfg(not(windows))]
    {
        fs::rename(temporary, destination)
            .map_err(|error| AppError::Internal(format!("commit CSV export: {error}")))
    }
    #[cfg(windows)]
    {
        if overwrite && destination.exists() {
            fs::remove_file(destination)
                .map_err(|error| AppError::Internal(format!("replace CSV export: {error}")))?;
        }
        fs::rename(temporary, destination)
            .map_err(|error| AppError::Internal(format!("commit CSV export: {error}")))
    }
}

#[tauri::command]
pub async fn start_export(
    request: ExportRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ExportStarted, AppError> {
    state
        .exports
        .start_export(request, &state.files, move |progress| {
            let _ = app.emit("export-progress", progress);
        })
}

#[tauri::command]
pub async fn cancel_export(export_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.exports.cancel_export(&export_id)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use duckdb::Connection;

    use super::{ExportRequest, ExportService, ExportSource, ExportStatus};
    use crate::files::FileRegistry;
    use crate::models::FilterQueryRequest;

    fn fixture(rows: u32) -> (tempfile::TempDir, FileRegistry, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.parquet");
        let quoted = path.to_string_lossy().replace('\'', "''");
        Connection::open_in_memory()
            .unwrap()
            .execute_batch(&format!(
                "COPY (SELECT range AS id, CASE range WHEN 0 THEN 'comma,value' WHEN 1 THEN 'quote\"value' WHEN 2 THEN 'line' || chr(10) || 'break' ELSE NULL END AS note FROM range({rows})) TO '{quoted}' (FORMAT PARQUET)"
            ))
            .unwrap();
        let registry = FileRegistry::default();
        let file_id = registry.open_paths(vec![path]).remove(0).unwrap().file_id;
        (directory, registry, file_id)
    }

    fn wait(service: &ExportService, export_id: &str) -> crate::models::ExportProgress {
        service
            .wait_for_terminal_for_test(export_id, Duration::from_secs(10))
            .unwrap()
    }

    #[test]
    fn sql_export_writes_all_rows_with_csv_escaping_and_nulls() {
        let (directory, registry, file_id) = fixture(12);
        let destination = directory.path().join("all.csv");
        let service = ExportService::default();

        let started = service
            .start_export(
                ExportRequest {
                    file_id,
                    destination: destination.to_string_lossy().into_owned(),
                    overwrite: false,
                    source: ExportSource::Sql {
                        sql: "SELECT * FROM data ORDER BY id".into(),
                    },
                },
                &registry,
                |_| {},
            )
            .unwrap();
        let terminal = wait(&service, &started.export_id);

        assert_eq!(terminal.status, ExportStatus::Completed, "{terminal:?}");
        assert_eq!(terminal.rows_written, 12);
        let csv = fs::read_to_string(destination).unwrap();
        assert!(csv.starts_with("id,note\n"));
        assert!(csv.contains("0,\"comma,value\""));
        assert!(csv.contains("1,\"quote\"\"value\""));
        assert!(csv.contains("2,\"line\nbreak\""));
        assert!(csv.lines().any(|line| line == "3,"));
    }

    #[test]
    fn filter_export_ignores_preview_limit_and_exports_complete_result() {
        let (directory, registry, file_id) = fixture(10);
        let destination = directory.path().join("filtered.csv");
        let service = ExportService::default();

        let started = service
            .start_export(
                ExportRequest {
                    file_id,
                    destination: destination.to_string_lossy().into_owned(),
                    overwrite: false,
                    source: ExportSource::Filter {
                        query: FilterQueryRequest {
                            selected_columns: vec!["id".into()],
                            filters: vec![],
                            sorts: vec![],
                            preview_limit: 2,
                        },
                    },
                },
                &registry,
                |_| {},
            )
            .unwrap();
        let terminal = wait(&service, &started.export_id);

        assert_eq!(terminal.status, ExportStatus::Completed, "{terminal:?}");
        assert_eq!(terminal.rows_written, 10);
        assert_eq!(fs::read_to_string(destination).unwrap().lines().count(), 11);
    }

    #[test]
    fn export_rejects_existing_destination_without_overwrite() {
        let (directory, registry, file_id) = fixture(1);
        let destination = directory.path().join("existing.csv");
        fs::write(&destination, "keep me").unwrap();
        let service = ExportService::default();

        let result = service.start_export(
            ExportRequest {
                file_id,
                destination: destination.to_string_lossy().into_owned(),
                overwrite: false,
                source: ExportSource::Sql {
                    sql: "SELECT * FROM data".into(),
                },
            },
            &registry,
            |_| {},
        );

        assert!(matches!(
            result,
            Err(crate::error::AppError::InvalidArgument(_))
        ));
        assert_eq!(fs::read_to_string(destination).unwrap(), "keep me");
        assert_eq!(service.active_count_for_test(), 0);
    }

    #[test]
    fn cancelled_export_removes_partial_file_and_preserves_destination() {
        let (directory, registry, file_id) = fixture(2_000);
        let destination = directory.path().join("cancelled.csv");
        fs::write(&destination, "previous").unwrap();
        let service = ExportService::default();

        let started = service
            .start_export(
                ExportRequest {
                    file_id,
                    destination: destination.to_string_lossy().into_owned(),
                    overwrite: true,
                    source: ExportSource::Sql {
                        sql: "SELECT * FROM data a CROSS JOIN data b".into(),
                    },
                },
                &registry,
                |_| {},
            )
            .unwrap();
        service.cancel_export(&started.export_id).unwrap();
        let terminal = wait(&service, &started.export_id);

        assert_eq!(terminal.status, ExportStatus::Cancelled);
        assert_eq!(fs::read_to_string(&destination).unwrap(), "previous");
        let partials = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".part"))
            .count();
        assert_eq!(partials, 0);
    }

    #[test]
    fn cancel_all_cleans_export_on_application_shutdown() {
        let (directory, registry, file_id) = fixture(2_000);
        let destination = directory.path().join("closed.csv");
        let service = ExportService::default();
        let started = service
            .start_export(
                ExportRequest {
                    file_id: file_id.clone(),
                    destination: destination.to_string_lossy().into_owned(),
                    overwrite: false,
                    source: ExportSource::Sql {
                        sql: "SELECT * FROM data a CROSS JOIN data b".into(),
                    },
                },
                &registry,
                |_| {},
            )
            .unwrap();

        service.cancel_all();
        let terminal = wait(&service, &started.export_id);

        assert_eq!(terminal.status, ExportStatus::Cancelled);
        assert!(!destination.exists());
    }
}

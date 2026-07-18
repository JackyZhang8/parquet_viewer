use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

use duckdb::InterruptHandle;
use duckdb::arrow::array::Array;
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::arrow::util::display::array_value_to_string;
use parking_lot::{Condvar, Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::files::{FileRegistry, QuerySource};
use crate::filters::{BoundValue, compile_filter_export_query};
use crate::models::{
    ExportInspection, ExportInspectionRequest, ExportProgress, ExportRequest, ExportSource,
    ExportStarted, ExportStatus,
};
use crate::query::validate_user_sql;
use crate::query::worker::{
    bound_to_duck_value, create_data_view, open_configured_connection, query_temp_directory,
    restrict_external_access_to_paths, safe_sql_error,
};

const MAX_SQL_BYTES: usize = 256 * 1024;
const MAX_COMPLETED_EXPORTS: usize = 64;
const LARGE_EXPORT_WARNING_ROWS: u64 = 100_000;
const PROGRESS_REPORT_ROWS: u64 = 100_000;

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

    pub fn inspect_export(
        &self,
        request: ExportInspectionRequest,
        files: &FileRegistry,
    ) -> Result<ExportInspection, AppError> {
        let (source, sql, params) = build_export_query(&request.file_id, request.source, files)?;
        let estimated_rows =
            count_export_rows(&source, &sql, &params, files, &self.runtime_settings.read())?;
        Ok(ExportInspection {
            estimated_rows,
            requires_confirmation: estimated_rows >= LARGE_EXPORT_WARNING_ROWS,
        })
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
        let ExportRequest {
            file_id,
            destination,
            overwrite,
            source: export_source,
        } = request;
        let destination = validate_destination(&destination, overwrite)?;
        let (source, sql, params) = build_export_query(&file_id, export_source, files)?;
        let export_id = Uuid::new_v4().to_string();
        let temporary = temporary_sibling(&destination, &export_id)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let interrupt = Arc::new(Mutex::new(None));
        self.state.lock().active.insert(
            export_id.clone(),
            ExportTask {
                file_id,
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
            overwrite,
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
        let report_progress = |rows_written| {
            notify(ExportProgress {
                export_id: plan.export_id.clone(),
                status: ExportStatus::Running,
                rows_written,
                error: None,
            });
        };
        let result = run_export_inner(&plan, &files, &cancelled, &interrupt, &report_progress);
        *interrupt.lock() = None;
        let _ = fs::remove_dir_all(query_temp_directory(
            &plan.runtime_settings,
            &format!("export-{}", plan.export_id),
        ));
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

fn build_export_query(
    file_id: &str,
    export_source: ExportSource,
    files: &FileRegistry,
) -> Result<(QuerySource, String, Vec<BoundValue>), AppError> {
    let source = files.resolve_query_source(file_id)?;
    let metadata = files
        .get(file_id)
        .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
    let (sql, params) = match export_source {
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
    Ok((source, sql, params))
}

fn count_export_rows(
    source: &QuerySource,
    sql: &str,
    params: &[BoundValue],
    files: &FileRegistry,
    settings: &crate::settings::RuntimeSettings,
) -> Result<u64, AppError> {
    let inspection_id = format!("export-inspection-{}", Uuid::new_v4());
    let result = (|| {
        let connection = open_configured_connection(&inspection_id, settings)?;
        files.revalidate_query_source(source)?;
        create_data_view(&connection, source)?;
        restrict_external_access_to_paths(&connection, &[source.duckdb_path.as_path()])?;
        let values = params.iter().map(bound_to_duck_value).collect::<Vec<_>>();
        let count_sql = format!("SELECT COUNT(*) FROM ({sql}) AS __export_count");
        let count = connection
            .query_row(&count_sql, duckdb::params_from_iter(values.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(export_sql_error)?;
        u64::try_from(count)
            .map_err(|_| AppError::Internal("DuckDB returned a negative export row count".into()))
    })();
    let _ = fs::remove_dir_all(query_temp_directory(settings, &inspection_id));
    result
}

fn run_export_inner(
    plan: &ExportPlan,
    files: &FileRegistry,
    cancelled: &AtomicBool,
    interrupt: &Mutex<Option<Arc<InterruptHandle>>>,
    report_progress: &dyn Fn(u64),
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
    restrict_external_access_to_paths(&connection, &[plan.source.duckdb_path.as_path()])?;
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled("The export was cancelled".into()));
    }
    let values = plan
        .params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut statement = connection.prepare(&plan.sql).map_err(export_sql_error)?;
    let schema = statement
        .query_arrow(duckdb::params_from_iter(values.iter()))
        .map_err(export_sql_error)?;
    let schema = schema.get_schema();
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&plan.temporary)
        .map_err(export_write_error)?;
    let mut writer = BufWriter::new(file);
    write_csv_header(&mut writer, &schema)?;
    let stream = statement
        .stream_arrow(duckdb::params_from_iter(values.iter()), schema)
        .map_err(export_sql_error)?;
    let mut rows_written = 0_u64;
    let mut last_reported_rows = 0_u64;
    for batch in stream {
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::Cancelled("The export was cancelled".into()));
        }
        write_csv_batch(&mut writer, &batch)?;
        rows_written = rows_written
            .checked_add(u64::try_from(batch.num_rows()).map_err(|_| {
                AppError::ResourceExhausted("The export result has too many rows".into())
            })?)
            .ok_or_else(|| {
                AppError::ResourceExhausted("The export result has too many rows".into())
            })?;
        if last_reported_rows == 0
            || rows_written.saturating_sub(last_reported_rows) >= PROGRESS_REPORT_ROWS
        {
            report_progress(rows_written);
            last_reported_rows = rows_written;
        }
    }
    if rows_written > last_reported_rows {
        report_progress(rows_written);
    }
    writer.flush().map_err(export_write_error)?;
    writer.get_ref().sync_all().map_err(export_write_error)?;
    drop(writer);
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled("The export was cancelled".into()));
    }
    commit_temporary(&plan.temporary, &plan.destination, plan.overwrite)?;
    Ok(rows_written)
}

fn write_csv_header(
    writer: &mut BufWriter<std::fs::File>,
    schema: &duckdb::arrow::datatypes::SchemaRef,
) -> Result<(), AppError> {
    for (index, field) in schema.fields().iter().enumerate() {
        if index > 0 {
            writer.write_all(b",").map_err(export_write_error)?;
        }
        write_csv_value(writer, field.name())?;
    }
    writer.write_all(b"\n").map_err(export_write_error)
}

fn write_csv_batch(
    writer: &mut BufWriter<std::fs::File>,
    batch: &RecordBatch,
) -> Result<(), AppError> {
    for row in 0..batch.num_rows() {
        for (index, column) in batch.columns().iter().enumerate() {
            if index > 0 {
                writer.write_all(b",").map_err(export_write_error)?;
            }
            if column.is_null(row) {
                continue;
            }
            let value = array_value_to_string(column.as_ref(), row)
                .map_err(|_| AppError::Internal("format CSV export value".into()))?;
            write_csv_value(writer, &value)?;
        }
        writer.write_all(b"\n").map_err(export_write_error)?;
    }
    Ok(())
}

fn write_csv_value(writer: &mut BufWriter<std::fs::File>, value: &str) -> Result<(), AppError> {
    let quoted = value.contains([',', '"', '\n', '\r']);
    if quoted {
        writer.write_all(b"\"").map_err(export_write_error)?;
    }
    for (index, segment) in value.split('"').enumerate() {
        if index > 0 {
            writer.write_all(b"\"\"").map_err(export_write_error)?;
        }
        writer
            .write_all(segment.as_bytes())
            .map_err(export_write_error)?;
    }
    if quoted {
        writer.write_all(b"\"").map_err(export_write_error)?;
    }
    Ok(())
}

fn export_write_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::PermissionDenied("Unable to write CSV export".into())
    } else {
        AppError::Internal(format!("write CSV export: {error}"))
    }
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
pub async fn inspect_export(
    request: ExportInspectionRequest,
    state: State<'_, AppState>,
) -> Result<ExportInspection, AppError> {
    let exports = state.exports.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || exports.inspect_export(request, &files))
        .await
        .map_err(|error| AppError::Internal(format!("inspect export task failed: {error}")))?
}

#[tauri::command]
pub async fn cancel_export(export_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.exports.cancel_export(&export_id)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::time::Duration;

    use duckdb::Connection;
    use parking_lot::Mutex;

    use super::{ExportRequest, ExportService, ExportSource, ExportStatus};
    use crate::files::FileRegistry;
    use crate::models::{ExportInspectionRequest, ExportProgress, FilterQueryRequest};
    use crate::query::worker::query_temp_directory;
    use crate::settings::{AppSettings, Language, Theme};

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
    fn export_reports_written_rows_before_completion() {
        let (directory, registry, file_id) = fixture(3_000);
        let destination = directory.path().join("progress.csv");
        let service = ExportService::default();
        let progress = Arc::new(Mutex::new(Vec::<ExportProgress>::new()));
        let reported = progress.clone();

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
                move |event| reported.lock().push(event),
            )
            .unwrap();
        let terminal = wait(&service, &started.export_id);
        let events = progress.lock();

        assert_eq!(terminal.status, ExportStatus::Completed, "{terminal:?}");
        assert!(
            events
                .iter()
                .any(|event| { event.status == ExportStatus::Running && event.rows_written > 0 })
        );
    }

    #[test]
    fn export_throttles_progress_events_for_large_results() {
        let (directory, registry, file_id) = fixture(250_000);
        let destination = directory.path().join("throttled.csv");
        let service = ExportService::default();
        let progress = Arc::new(Mutex::new(Vec::<ExportProgress>::new()));
        let reported = progress.clone();

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
                move |event| reported.lock().push(event),
            )
            .unwrap();
        let terminal = wait(&service, &started.export_id);
        let running_updates = progress
            .lock()
            .iter()
            .filter(|event| event.status == ExportStatus::Running)
            .count();

        assert_eq!(terminal.status, ExportStatus::Completed, "{terminal:?}");
        assert!(
            running_updates <= 5,
            "received {running_updates} progress events"
        );
    }

    #[test]
    fn inspection_reports_exact_rows_and_large_export_confirmation() {
        let (_directory, registry, file_id) = fixture(100_000);

        let inspection = ExportService::default()
            .inspect_export(
                ExportInspectionRequest {
                    file_id,
                    source: ExportSource::Sql {
                        sql: "SELECT * FROM data".into(),
                    },
                },
                &registry,
            )
            .unwrap();

        assert_eq!(inspection.estimated_rows, 100_000);
        assert!(inspection.requires_confirmation);
    }

    #[test]
    fn completed_export_removes_its_duckdb_temp_directory() {
        let (directory, registry, file_id) = fixture(1);
        let destination = directory.path().join("one.csv");
        let runtime = AppSettings {
            language: Language::En,
            theme: Theme::System,
            batch_size: 500,
            preview_limit: 10_000,
            memory_limit_mb: 256,
            temp_directory: Some(
                directory
                    .path()
                    .join("scratch")
                    .to_string_lossy()
                    .into_owned(),
            ),
            temp_disk_warning_mb: 64,
            concurrency: 2,
            restore_tabs: true,
        }
        .runtime();
        let service = ExportService::default();
        service.update_settings(runtime.clone());

        let started = service
            .start_export(
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
            )
            .unwrap();
        let terminal = wait(&service, &started.export_id);

        assert_eq!(terminal.status, ExportStatus::Completed, "{terminal:?}");
        assert!(!query_temp_directory(&runtime, &format!("export-{}", started.export_id)).exists());
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

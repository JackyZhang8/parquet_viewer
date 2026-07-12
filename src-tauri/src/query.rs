mod sql_policy;
mod values;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Instant;

use crossbeam_channel::{Receiver, Sender, bounded};
use duckdb::{Config, Connection, InterruptHandle};
use parking_lot::Mutex;
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::files::{FileRegistry, QuerySource};
use crate::models::{CellValue, ColumnSchema, QueryBatch, QueryRequest, QueryStarted};
use sql_policy::validate_user_sql;
use values::cell_from_array;

const MAX_BATCH_SIZE: u32 = 5_000;
const MAX_PREVIEW_LIMIT: u32 = 100_000;
const WORKER_COUNT: usize = 2;
const JOB_QUEUE_CAPACITY: usize = 2;
const BATCH_QUEUE_CAPACITY: usize = 2;

type BatchResult = Result<QueryBatch, AppError>;
type ReadyResult = Result<Vec<ColumnSchema>, AppError>;

struct Cursor {
    file_id: String,
    batches: Receiver<BatchResult>,
    cancelled: Arc<AtomicBool>,
    interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
}

struct QueryJob {
    query_id: String,
    file_id: String,
    files: FileRegistry,
    source: QuerySource,
    normalized_sql: String,
    batch_size: usize,
    preview_limit: u32,
    batches: Sender<BatchResult>,
    ready: Sender<ReadyResult>,
    cancelled: Arc<AtomicBool>,
    interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
}

#[derive(Clone)]
pub struct QueryService {
    cursors: Arc<Mutex<HashMap<String, Cursor>>>,
    jobs: Sender<QueryJob>,
}

impl Default for QueryService {
    fn default() -> Self {
        let (jobs, receiver) = bounded::<QueryJob>(JOB_QUEUE_CAPACITY);
        for index in 0..WORKER_COUNT {
            let receiver = receiver.clone();
            thread::Builder::new()
                .name(format!("parquet-query-{index}"))
                .spawn(move || worker_loop(receiver))
                .expect("failed to start query worker");
        }
        Self {
            cursors: Arc::new(Mutex::new(HashMap::new())),
            jobs,
        }
    }
}

impl QueryService {
    pub fn start_query(
        &self,
        request: QueryRequest,
        files: &FileRegistry,
    ) -> Result<QueryStarted, AppError> {
        if !(1..=MAX_BATCH_SIZE).contains(&request.batch_size) {
            return Err(AppError::InvalidArgument(
                "Batch size must be between 1 and 5000".into(),
            ));
        }
        if !(1..=MAX_PREVIEW_LIMIT).contains(&request.preview_limit) {
            return Err(AppError::InvalidArgument(
                "Preview limit must be between 1 and 100000".into(),
            ));
        }
        let normalized_sql = validate_user_sql(&request.sql)?;
        let source = files.resolve_query_source(&request.file_id)?;

        let replaced = self
            .cursors
            .lock()
            .iter()
            .filter(|(_, cursor)| cursor.file_id == request.file_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for query_id in replaced {
            let _ = self.cancel_query(&query_id);
        }

        let query_id = Uuid::new_v4().to_string();
        let (batch_sender, batch_receiver) = bounded(BATCH_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let interrupt = Arc::new(Mutex::new(None));
        self.cursors.lock().insert(
            query_id.clone(),
            Cursor {
                file_id: request.file_id.clone(),
                batches: batch_receiver,
                cancelled: cancelled.clone(),
                interrupt: interrupt.clone(),
            },
        );
        let job = QueryJob {
            query_id: query_id.clone(),
            file_id: request.file_id,
            files: files.clone(),
            source,
            normalized_sql,
            batch_size: request.batch_size as usize,
            preview_limit: request.preview_limit,
            batches: batch_sender,
            ready: ready_sender,
            cancelled,
            interrupt,
        };
        if self.jobs.send(job).is_err() {
            self.cursors.lock().remove(&query_id);
            return Err(AppError::Internal("query worker pool stopped".into()));
        }
        match ready_receiver.recv() {
            Ok(Ok(columns)) => Ok(QueryStarted { query_id, columns }),
            Ok(Err(error)) => {
                self.cursors.lock().remove(&query_id);
                Err(error)
            }
            Err(_) => {
                self.cursors.lock().remove(&query_id);
                Err(AppError::Internal("query worker did not start".into()))
            }
        }
    }

    pub fn fetch_query_batch(&self, query_id: &str) -> Result<QueryBatch, AppError> {
        let receiver = self
            .cursors
            .lock()
            .get(query_id)
            .map(|cursor| cursor.batches.clone())
            .ok_or_else(|| AppError::InvalidArgument("Unknown query ID".into()))?;
        let result = receiver
            .recv()
            .unwrap_or_else(|_| Err(AppError::Cancelled("The query was cancelled".into())));
        if !matches!(&result, Ok(batch) if !batch.done) {
            self.cursors.lock().remove(query_id);
        }
        result
    }

    /// Cancelling removes the cursor immediately; later fetches return `INVALID_ARGUMENT`.
    pub fn cancel_query(&self, query_id: &str) -> Result<(), AppError> {
        let cursor = self
            .cursors
            .lock()
            .remove(query_id)
            .ok_or_else(|| AppError::InvalidArgument("Unknown query ID".into()))?;
        cursor.cancelled.store(true, Ordering::Release);
        if let Some(interrupt) = cursor.interrupt.lock().as_ref() {
            interrupt.interrupt();
        }
        Ok(())
    }

    pub fn close_file(&self, file_id: &str) {
        let query_ids = self
            .cursors
            .lock()
            .iter()
            .filter(|(_, cursor)| cursor.file_id == file_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for query_id in query_ids {
            let _ = self.cancel_query(&query_id);
        }
    }

    pub fn active_cursor_count(&self) -> usize {
        self.cursors.lock().len()
    }
}

fn worker_loop(jobs: Receiver<QueryJob>) {
    while let Ok(job) = jobs.recv() {
        run_job(job);
    }
}

fn run_job(job: QueryJob) {
    if job.cancelled.load(Ordering::Acquire) {
        let _ = job
            .ready
            .send(Err(AppError::Cancelled("The query was cancelled".into())));
        return;
    }
    let started = Instant::now();
    let mut ready_sent = false;
    let result = run_job_inner(&job, started, &mut ready_sent);
    *job.interrupt.lock() = None;
    let _ = fs::remove_dir_all(query_temp_directory(&job.query_id));
    if let Err(error) = result {
        if ready_sent {
            let _ = job.batches.send(Err(error));
        } else {
            let _ = job.ready.send(Err(error));
        }
    }
}

fn run_job_inner(job: &QueryJob, started: Instant, ready_sent: &mut bool) -> Result<(), AppError> {
    let connection = open_configured_connection(&job.query_id)?;
    *job.interrupt.lock() = Some(connection.interrupt_handle());
    if job.cancelled.load(Ordering::Acquire) {
        let _ = job
            .ready
            .send(Err(AppError::Cancelled("The query was cancelled".into())));
        return Ok(());
    }
    let source = job.files.resolve_query_source(&job.file_id)?;
    if source.fingerprint_token != job.source.fingerprint_token
        || source.canonical_path != job.source.canonical_path
    {
        return Err(AppError::StaleFile(
            "The file changed before the query started".into(),
        ));
    }
    create_data_view(&connection, &source)?;
    let wrapped = format!(
        "SELECT * FROM ({}) AS __preview LIMIT ?",
        job.normalized_sql
    );
    let schema_sql = format!(
        "SELECT * FROM ({}) AS __preview_schema LIMIT 0",
        job.normalized_sql
    );
    let mut schema_statement = connection.prepare(&schema_sql).map_err(safe_sql_error)?;
    let schema = schema_statement
        .query_arrow([])
        .map_err(safe_sql_error)?
        .get_schema();
    let columns = schema
        .fields()
        .iter()
        .map(|field| ColumnSchema {
            name: field.name().clone(),
            logical_type: format!("{:?}", field.data_type()),
            nullable: field.is_nullable(),
        })
        .collect();
    let mut statement = connection.prepare(&wrapped).map_err(safe_sql_error)?;
    if job.ready.send(Ok(columns)).is_err() {
        return Ok(());
    }
    *ready_sent = true;

    let mut returned_rows = 0_u64;
    let mut batch = Vec::with_capacity(job.batch_size);
    let stream = statement
        .stream_arrow([job.preview_limit], schema)
        .map_err(safe_sql_error)?;
    for record_batch in stream {
        if job.cancelled.load(Ordering::Acquire) {
            return Err(AppError::Cancelled("The query was cancelled".into()));
        }
        for row in 0..record_batch.num_rows() {
            if job.cancelled.load(Ordering::Acquire) {
                return Err(AppError::Cancelled("The query was cancelled".into()));
            }
            batch.push(
                record_batch
                    .columns()
                    .iter()
                    .map(|column| cell_from_array(column.as_ref(), row))
                    .collect::<Vec<CellValue>>(),
            );
            returned_rows += 1;
            if batch.len() == job.batch_size {
                send_batch(job, &mut batch, false, returned_rows, started)?;
            }
        }
    }
    send_batch(job, &mut batch, true, returned_rows, started)
}

fn send_batch(
    job: &QueryJob,
    rows: &mut Vec<Vec<CellValue>>,
    done: bool,
    returned_rows: u64,
    started: Instant,
) -> Result<(), AppError> {
    let payload = QueryBatch {
        query_id: job.query_id.clone(),
        rows: std::mem::take(rows),
        done,
        returned_rows,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    };
    job.batches
        .send(Ok(payload))
        .map_err(|_| AppError::Cancelled("The query was cancelled".into()))
}

fn open_configured_connection(query_id: &str) -> Result<Connection, AppError> {
    let temp_directory = query_temp_directory(query_id);
    fs::create_dir_all(&temp_directory)
        .map_err(|error| AppError::Internal(format!("create query temp directory: {error}")))?;
    let temp = temp_directory.to_string_lossy();
    let config = Config::default()
        .enable_autoload_extension(false)
        .and_then(|config| config.max_memory("512MB"))
        .and_then(|config| config.threads(2))
        .and_then(|config| config.with("preserve_insertion_order", "false"))
        .and_then(|config| config.with("allow_unsigned_extensions", "false"))
        .and_then(|config| config.with("temp_directory", temp.as_ref()))
        .map_err(internal_duckdb)?;
    Connection::open_in_memory_with_flags(config).map_err(internal_duckdb)
}

fn query_temp_directory(query_id: &str) -> PathBuf {
    std::env::temp_dir().join("parquet-viewer").join(query_id)
}

fn create_data_view(connection: &Connection, source: &QuerySource) -> Result<(), AppError> {
    let _fingerprint = &source.fingerprint_token;
    let path = quote_sql_string(&source.canonical_path);
    connection
        .execute_batch(&format!(
            "CREATE TEMP VIEW data AS SELECT * FROM read_parquet({path})"
        ))
        .map_err(|_| AppError::InvalidParquet("The Parquet file could not be queried".into()))
}

fn quote_sql_string(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn safe_sql_error(_: duckdb::Error) -> AppError {
    AppError::Sql("The query could not be prepared or executed".into())
}

fn internal_duckdb(error: duckdb::Error) -> AppError {
    AppError::Internal(format!("DuckDB operation failed: {error}"))
}

#[tauri::command]
pub async fn start_query(
    request: QueryRequest,
    state: State<'_, AppState>,
) -> Result<QueryStarted, AppError> {
    let queries = state.queries.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || queries.start_query(request, &files))
        .await
        .map_err(|error| AppError::Internal(format!("start query task failed: {error}")))?
}

#[tauri::command]
pub async fn fetch_query_batch(
    query_id: String,
    state: State<'_, AppState>,
) -> Result<QueryBatch, AppError> {
    let queries = state.queries.clone();
    tauri::async_runtime::spawn_blocking(move || queries.fetch_query_batch(&query_id))
        .await
        .map_err(|error| AppError::Internal(format!("fetch query task failed: {error}")))?
}

#[tauri::command]
pub async fn cancel_query(query_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.queries.cancel_query(&query_id)
}

#[cfg(test)]
mod tests;

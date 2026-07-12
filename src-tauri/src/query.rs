mod sql_policy;
mod values;
mod worker;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crossbeam_channel::{Receiver, Sender, bounded};
use duckdb::InterruptHandle;
use parking_lot::Mutex;
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::files::{FileRegistry, QuerySource};
use crate::filters::{BoundValue, compile_filter_query};
use crate::models::{
    ColumnSchema, FilterQueryStartRequest, QueryBatch, QueryRequest, QueryStarted,
};
use sql_policy::validate_user_sql;
use worker::worker_loop;

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

pub(super) struct QueryJob {
    query_id: String,
    file_id: String,
    files: FileRegistry,
    source: QuerySource,
    execution_sql: String,
    execution_params: Vec<BoundValue>,
    schema_sql: String,
    schema_params: Vec<BoundValue>,
    batch_size: usize,
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
        let execution_sql = format!("SELECT * FROM ({normalized_sql}) AS __preview LIMIT ?");
        let schema_sql = format!("SELECT * FROM ({normalized_sql}) AS __preview_schema LIMIT 0");
        self.enqueue_query(
            request.file_id,
            request.batch_size,
            files,
            source,
            execution_sql,
            vec![BoundValue::UnsignedInteger(u64::from(
                request.preview_limit,
            ))],
            schema_sql,
            Vec::new(),
        )
    }

    pub fn start_filter_query(
        &self,
        request: FilterQueryStartRequest,
        files: &FileRegistry,
    ) -> Result<QueryStarted, AppError> {
        if !(1..=MAX_BATCH_SIZE).contains(&request.batch_size) {
            return Err(AppError::InvalidArgument(
                "Batch size must be between 1 and 5000".into(),
            ));
        }
        let source = files.resolve_query_source(&request.file_id)?;
        let metadata = files
            .get(&request.file_id)
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        let path = source
            .canonical_path
            .to_str()
            .ok_or_else(|| AppError::InvalidPath("File path is not valid UTF-8".into()))?;
        let compiled = compile_filter_query(path, &metadata.columns, &request.query)?;
        let schema_sql = format!(
            "SELECT * FROM ({}) AS __preview_schema LIMIT 0",
            compiled.sql
        );
        self.enqueue_query(
            request.file_id,
            request.batch_size,
            files,
            source,
            compiled.sql,
            compiled.params.clone(),
            schema_sql,
            compiled.params,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue_query(
        &self,
        file_id: String,
        batch_size: u32,
        files: &FileRegistry,
        source: QuerySource,
        execution_sql: String,
        execution_params: Vec<BoundValue>,
        schema_sql: String,
        schema_params: Vec<BoundValue>,
    ) -> Result<QueryStarted, AppError> {
        let replaced = self
            .cursors
            .lock()
            .iter()
            .filter(|(_, cursor)| cursor.file_id == file_id)
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
                file_id: file_id.clone(),
                batches: batch_receiver,
                cancelled: cancelled.clone(),
                interrupt: interrupt.clone(),
            },
        );
        let job = QueryJob {
            query_id: query_id.clone(),
            file_id,
            files: files.clone(),
            source,
            execution_sql,
            execution_params,
            schema_sql,
            schema_params,
            batch_size: batch_size as usize,
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
pub async fn start_filter_query(
    request: FilterQueryStartRequest,
    state: State<'_, AppState>,
) -> Result<QueryStarted, AppError> {
    let queries = state.queries.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || queries.start_filter_query(request, &files))
        .await
        .map_err(|error| AppError::Internal(format!("start filter query task failed: {error}")))?
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

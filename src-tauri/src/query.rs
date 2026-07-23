mod admission;
mod sql_policy;
mod values;
pub(crate) mod worker;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;

use crossbeam_channel::{Receiver, Sender, bounded};
use duckdb::InterruptHandle;
use parking_lot::{Mutex, RwLock};
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::files::{FileRegistry, QuerySource};
use crate::filters::{BoundValue, compile_filter_query};
use crate::models::{
    ColumnSchema, FilterQueryStartRequest, QueryBatch, QueryRequest, QueryStarted,
};
use crate::settings::RuntimeSettings;
use admission::{Admission, AdmissionPermit, ExecutionGate, ExecutionPermit};
pub(crate) use sql_policy::validate_user_sql;
use worker::worker_loop;

const MAX_BATCH_SIZE: u32 = 5_000;
const MAX_PREVIEW_LIMIT: u32 = 100_000;
const MAX_SQL_BYTES: usize = 256 * 1024;
const WORKER_COUNT: usize = 4;
const JOB_QUEUE_CAPACITY: usize = 4;
const REPLACEMENT_QUEUE_CAPACITY: usize = 1;
const BATCH_QUEUE_CAPACITY: usize = 2;

type BatchResult = Result<QueryBatch, AppError>;
type ReadyResult = Result<Vec<ColumnSchema>, AppError>;

struct Cursor {
    file_id: String,
    batches: Receiver<BatchResult>,
    cancelled: Arc<AtomicBool>,
    interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
    _permit: Arc<AdmissionPermit>,
    execution: Option<Weak<ExecutionPermit>>,
}

pub(super) struct QueryJob {
    query_id: String,
    files: FileRegistry,
    source: QuerySource,
    execution_sql: String,
    execution_params: Vec<BoundValue>,
    schema_sql: String,
    schema_params: Vec<BoundValue>,
    initial_batch_size: usize,
    batch_size: usize,
    preview_limit: usize,
    batches: Sender<BatchResult>,
    ready: Sender<ReadyResult>,
    cancelled: Arc<AtomicBool>,
    interrupt: Arc<Mutex<Option<Arc<InterruptHandle>>>>,
    _permit: Arc<AdmissionPermit>,
    _execution: Arc<ExecutionPermit>,
    panic_for_test: bool,
    counters: Arc<WorkerCounters>,
    runtime_settings: RuntimeSettings,
}

#[derive(Default)]
pub(super) struct WorkerCounters {
    queued: AtomicUsize,
    running: AtomicUsize,
}

#[derive(Clone)]
pub struct QueryService {
    cursors: Arc<Mutex<HashMap<String, Cursor>>>,
    replacement_gate: Arc<Mutex<()>>,
    jobs: Sender<QueryJob>,
    replacement_jobs: Sender<QueryJob>,
    admission: Arc<Admission>,
    counters: Arc<WorkerCounters>,
    execution_gate: Arc<ExecutionGate>,
    runtime_settings: Arc<RwLock<RuntimeSettings>>,
}

impl Default for QueryService {
    fn default() -> Self {
        let (jobs, receiver) = bounded::<QueryJob>(JOB_QUEUE_CAPACITY);
        let (replacement_jobs, replacement_receiver) =
            bounded::<QueryJob>(REPLACEMENT_QUEUE_CAPACITY);
        let execution_gate = Arc::new(ExecutionGate::new(2));
        for index in 0..WORKER_COUNT {
            let receiver = receiver.clone();
            let replacement_receiver = replacement_receiver.clone();
            thread::Builder::new()
                .name(format!("parquet-query-{index}"))
                .spawn(move || worker_loop(receiver, replacement_receiver))
                .expect("failed to start query worker");
        }
        Self {
            cursors: Arc::new(Mutex::new(HashMap::new())),
            replacement_gate: Arc::new(Mutex::new(())),
            jobs,
            replacement_jobs,
            admission: Arc::new(Admission::default()),
            counters: Arc::new(WorkerCounters::default()),
            execution_gate,
            runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
        }
    }
}

impl QueryService {
    pub(crate) fn update_settings(&self, settings: RuntimeSettings) {
        self.execution_gate.set_limit(settings.concurrency);
        *self.runtime_settings.write() = settings;
    }

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
        if request.sql.len() > MAX_SQL_BYTES {
            return Err(AppError::InvalidArgument(
                "SQL must not exceed 262144 UTF-8 bytes".into(),
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
                request.preview_limit + 1,
            ))],
            schema_sql,
            Vec::new(),
            request.preview_limit,
            false,
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
            .duckdb_path
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
            request.query.preview_limit,
            false,
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
        preview_limit: u32,
        panic_for_test: bool,
    ) -> Result<QueryStarted, AppError> {
        let query_id = Uuid::new_v4().to_string();
        let (batch_sender, batch_receiver) = bounded(BATCH_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let interrupt = Arc::new(Mutex::new(None));
        let replacement = {
            let cursors = self.cursors.lock();
            cursors
                .iter()
                .find(|(_, cursor)| cursor.file_id == file_id)
                .map(|(id, cursor)| {
                    (
                        id.clone(),
                        cursor._permit.clone(),
                        cursor.execution.as_ref().and_then(Weak::upgrade),
                    )
                })
        };
        let _replacement_guard = if replacement.is_some() {
            Some(self.replacement_gate.try_lock().ok_or_else(|| {
                AppError::ResourceExhausted("The replacement query queue is busy".into())
            })?)
        } else {
            None
        };
        let replacement = if let Some((expected_id, _, _)) = replacement {
            let cursors = self.cursors.lock();
            cursors
                .get(&expected_id)
                .filter(|cursor| cursor.file_id == file_id)
                .map(|cursor| {
                    (
                        expected_id,
                        cursor._permit.clone(),
                        cursor.execution.as_ref().and_then(Weak::upgrade),
                    )
                })
        } else {
            None
        };
        let permit = if let Some((_, permit, _)) = &replacement {
            permit.clone()
        } else {
            self.admission.try_acquire().ok_or_else(|| {
                AppError::ResourceExhausted("Too many queries are already running or queued".into())
            })?
        };
        if replacement.is_none() {
            let mut cursors = self.cursors.lock();
            if cursors.values().any(|cursor| cursor.file_id == file_id) {
                return Err(AppError::ResourceExhausted(
                    "A replacement query is already being admitted".into(),
                ));
            }
            cursors.insert(
                query_id.clone(),
                Cursor {
                    file_id: file_id.clone(),
                    batches: batch_receiver.clone(),
                    cancelled: cancelled.clone(),
                    interrupt: interrupt.clone(),
                    _permit: permit.clone(),
                    execution: None,
                },
            );
        }
        let execution = if let Some((_, _, Some(execution))) = &replacement {
            execution.clone()
        } else {
            match self.execution_gate.acquire(&cancelled) {
                Some(execution) => execution,
                None => {
                    if let Some(cursor) = self.cursors.lock().remove(&query_id) {
                        cancel_cursor(cursor);
                    }
                    return Err(AppError::Cancelled("The query was cancelled".into()));
                }
            }
        };
        if replacement.is_none() {
            let mut cursors = self.cursors.lock();
            let Some(cursor) = cursors.get_mut(&query_id) else {
                return Err(AppError::Cancelled("The query was cancelled".into()));
            };
            cursor.execution = Some(Arc::downgrade(&execution));
        }
        let job = QueryJob {
            query_id: query_id.clone(),
            files: files.clone(),
            source,
            execution_sql,
            execution_params,
            schema_sql,
            schema_params,
            initial_batch_size: (batch_size as usize).min(100),
            batch_size: batch_size as usize,
            preview_limit: preview_limit as usize,
            batches: batch_sender,
            ready: ready_sender,
            cancelled: cancelled.clone(),
            interrupt: interrupt.clone(),
            _permit: permit.clone(),
            _execution: execution.clone(),
            panic_for_test,
            counters: self.counters.clone(),
            runtime_settings: self.runtime_settings.read().clone(),
        };
        self.counters.queued.fetch_add(1, Ordering::AcqRel);
        let sender = if replacement.is_some() {
            &self.replacement_jobs
        } else {
            &self.jobs
        };
        if let Err(error) = sender.try_send(job) {
            self.counters.queued.fetch_sub(1, Ordering::AcqRel);
            if let Some(cursor) = self.cursors.lock().remove(&query_id) {
                cancel_cursor(cursor);
            }
            return match error {
                crossbeam_channel::TrySendError::Full(_) => Err(AppError::ResourceExhausted(
                    "The query queue is full".into(),
                )),
                crossbeam_channel::TrySendError::Disconnected(_) => {
                    Err(AppError::Internal("query worker pool stopped".into()))
                }
            };
        }
        if let Some((expected_id, _, _)) = replacement {
            let displaced = {
                let mut cursors = self.cursors.lock();
                if !matches!(cursors.get(&expected_id), Some(cursor) if cursor.file_id == file_id) {
                    cancelled.store(true, Ordering::Release);
                    return Err(AppError::ResourceExhausted(
                        "The query being replaced is no longer current".into(),
                    ));
                }
                let displaced = cursors.remove(&expected_id).expect("cursor was checked");
                cursors.insert(
                    query_id.clone(),
                    Cursor {
                        file_id,
                        batches: batch_receiver,
                        cancelled: cancelled.clone(),
                        interrupt: interrupt.clone(),
                        _permit: permit,
                        execution: Some(Arc::downgrade(&execution)),
                    },
                );
                displaced
            };
            cancel_cursor(displaced);
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
        cancel_cursor(cursor);
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

    pub fn cancel_all(&self) {
        let query_ids = self.cursors.lock().keys().cloned().collect::<Vec<_>>();
        for query_id in query_ids {
            let _ = self.cancel_query(&query_id);
        }
    }

    pub fn active_cursor_count(&self) -> usize {
        self.cursors.lock().len()
    }

    #[cfg(test)]
    pub fn admitted_count_for_test(&self) -> usize {
        self.admission.count()
    }

    #[cfg(test)]
    pub fn queued_count_for_test(&self) -> usize {
        self.counters.queued.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn running_count_for_test(&self) -> usize {
        self.counters.running.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn wait_for_admitted_for_test(&self, expected: usize) {
        self.admission.wait_for(expected);
    }

    #[cfg(test)]
    pub fn hold_replacement_gate_for_test(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.replacement_gate.lock()
    }

    #[cfg(test)]
    pub fn start_injected_panic_for_test(
        &self,
        file_id: String,
        files: &FileRegistry,
    ) -> Result<QueryStarted, AppError> {
        let source = files.resolve_query_source(&file_id)?;
        self.enqueue_query(
            file_id,
            1,
            files,
            source,
            "SELECT * FROM data".into(),
            Vec::new(),
            "SELECT * FROM data LIMIT 0".into(),
            Vec::new(),
            1,
            true,
        )
    }
}

fn cancel_cursor(cursor: Cursor) {
    cursor.cancelled.store(true, Ordering::Release);
    if let Some(interrupt) = cursor.interrupt.lock().as_ref() {
        interrupt.interrupt();
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

#[tauri::command]
pub async fn cancel_file_queries(
    file_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.queries.close_file(&file_id);
    Ok(())
}

#[cfg(test)]
mod tests;

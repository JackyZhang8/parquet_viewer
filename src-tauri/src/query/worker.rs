use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use crossbeam_channel::Receiver;
use duckdb::types::Value;
use duckdb::{Config, Connection};

use super::values::cell_from_array;
use super::{QueryJob, WorkerCounters};
use crate::error::AppError;
use crate::files::QuerySource;
use crate::filters::BoundValue;
use crate::models::{CellValue, ColumnSchema, QueryBatch};

const MAX_RESULT_COLUMNS: usize = 512;
const MAX_BATCH_ENCODED_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn worker_loop(jobs: Receiver<QueryJob>, replacements: Receiver<QueryJob>) {
    loop {
        let job = crossbeam_channel::select_biased! {
            recv(replacements) -> job => match job { Ok(job) => job, Err(_) => break },
            recv(jobs) -> job => match job { Ok(job) => job, Err(_) => break },
        };
        job.counters.queued.fetch_sub(1, Ordering::AcqRel);
        job.counters.running.fetch_add(1, Ordering::AcqRel);
        let _running = RunningGuard(job.counters.clone());
        run_job(job);
    }
}

struct RunningGuard(Arc<WorkerCounters>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, Ordering::AcqRel);
    }
}

fn run_job(job: QueryJob) {
    let _cleanup = JobCleanup(&job);
    if job.cancelled.load(Ordering::Acquire) {
        let _ = job
            .ready
            .send(Err(AppError::Cancelled("The query was cancelled".into())));
        return;
    }
    let started = Instant::now();
    let mut ready_sent = false;
    let result = catch_unwind(AssertUnwindSafe(|| {
        run_job_inner(&job, started, &mut ready_sent)
    }))
    .unwrap_or_else(|_| Err(AppError::Internal("query worker panicked".into())));
    if let Err(error) = result {
        if ready_sent {
            let _ = job.batches.send(Err(error));
        } else {
            let _ = job.ready.send(Err(error));
        }
    }
}

struct JobCleanup<'a>(&'a QueryJob);

impl Drop for JobCleanup<'_> {
    fn drop(&mut self) {
        *self.0.interrupt.lock() = None;
        let _ = fs::remove_dir_all(query_temp_directory(&self.0.query_id));
    }
}

fn run_job_inner(job: &QueryJob, started: Instant, ready_sent: &mut bool) -> Result<(), AppError> {
    if job.panic_for_test {
        panic!("injected query worker panic");
    }
    let connection = open_configured_connection(&job.query_id)?;
    *job.interrupt.lock() = Some(connection.interrupt_handle());
    if job.cancelled.load(Ordering::Acquire) {
        let _ = job
            .ready
            .send(Err(AppError::Cancelled("The query was cancelled".into())));
        return Ok(());
    }
    job.files.revalidate_query_source(&job.source)?;
    create_data_view(&connection, &job.source)?;
    restrict_external_access(&connection, &job.source.duckdb_path)?;
    let schema_values = job
        .schema_params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut schema_statement = connection
        .prepare(&job.schema_sql)
        .map_err(safe_sql_error)?;
    let execution_values = job
        .execution_params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut statement = connection
        .prepare(&job.execution_sql)
        .map_err(safe_sql_error)?;
    let schema = schema_statement
        .query_arrow(duckdb::params_from_iter(schema_values.iter()))
        .map_err(safe_sql_error)?
        .get_schema();
    if schema.fields().len() > MAX_RESULT_COLUMNS {
        return Err(AppError::ResourceExhausted(
            "The query result has too many columns".into(),
        ));
    }
    let columns = schema
        .fields()
        .iter()
        .map(|field| ColumnSchema {
            name: field.name().clone(),
            logical_type: format!("{:?}", field.data_type()),
            nullable: field.is_nullable(),
        })
        .collect();
    if job.ready.send(Ok(columns)).is_err() {
        return Ok(());
    }
    *ready_sent = true;

    let mut returned_rows = 0_u64;
    let mut batch = Vec::with_capacity(job.batch_size);
    let mut batch_bytes = 0_usize;
    let stream = statement
        .stream_arrow(duckdb::params_from_iter(execution_values.iter()), schema)
        .map_err(safe_sql_error)?;
    for record_batch in stream {
        if job.cancelled.load(Ordering::Acquire) {
            return Err(AppError::Cancelled("The query was cancelled".into()));
        }
        for row in 0..record_batch.num_rows() {
            if job.cancelled.load(Ordering::Acquire) {
                return Err(AppError::Cancelled("The query was cancelled".into()));
            }
            let mut converted = Vec::with_capacity(record_batch.num_columns());
            let mut row_bytes = 2_usize;
            for column in record_batch.columns() {
                let cell = cell_from_array(column.as_ref(), row)?;
                row_bytes = row_bytes
                    .checked_add(cell.encoded_bytes + 1)
                    .filter(|size| *size <= MAX_BATCH_ENCODED_BYTES)
                    .ok_or_else(|| {
                        AppError::ResourceExhausted(
                            "A query row exceeds the batch memory limit".into(),
                        )
                    })?;
                converted.push(cell);
            }
            if !batch.is_empty() && batch_bytes + row_bytes > MAX_BATCH_ENCODED_BYTES {
                send_batch(job, &mut batch, false, returned_rows, started)?;
                batch_bytes = 0;
            }
            batch.push(
                converted
                    .into_iter()
                    .map(|cell| cell.value)
                    .collect::<Vec<CellValue>>(),
            );
            batch_bytes += row_bytes;
            returned_rows += 1;
            if batch.len() == job.batch_size {
                send_batch(job, &mut batch, false, returned_rows, started)?;
                batch_bytes = 0;
            }
        }
    }
    send_batch(job, &mut batch, true, returned_rows, started)
}

fn bound_to_duck_value(value: &BoundValue) -> Value {
    match value {
        BoundValue::Bool(value) => Value::Boolean(*value),
        BoundValue::SignedInteger(value) => Value::BigInt(*value),
        BoundValue::UnsignedInteger(value) => Value::UBigInt(*value),
        BoundValue::Float(value) => Value::Double(*value),
        BoundValue::Decimal(value) | BoundValue::String(value) => Value::Text(value.clone()),
    }
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
    let temp = temp_directory
        .to_str()
        .ok_or_else(|| AppError::InvalidPath("Query temp path is not valid UTF-8".into()))?;
    let config = Config::default()
        .enable_autoload_extension(false)
        .and_then(|config| config.max_memory("512MB"))
        .and_then(|config| config.threads(2))
        .and_then(|config| config.with("preserve_insertion_order", "false"))
        .and_then(|config| config.with("allow_unsigned_extensions", "false"))
        .and_then(|config| config.with("max_temp_directory_size", "1GB"))
        .and_then(|config| config.with("temp_directory", temp))
        .map_err(internal_duckdb)?;
    Connection::open_in_memory_with_flags(config).map_err(internal_duckdb)
}

fn query_temp_directory(query_id: &str) -> PathBuf {
    std::env::temp_dir().join("parquet-viewer").join(query_id)
}

fn create_data_view(connection: &Connection, source: &QuerySource) -> Result<(), AppError> {
    let _fingerprint = &source.fingerprint_token;
    let path = quote_sql_string(&source.duckdb_path)?;
    connection
        .execute_batch(&format!(
            "CREATE TEMP VIEW data AS SELECT * FROM read_parquet({path})"
        ))
        .map_err(|_| AppError::InvalidParquet("The Parquet file could not be queried".into()))
}

fn restrict_external_access(connection: &Connection, allowed_path: &Path) -> Result<(), AppError> {
    let allowed = quote_sql_string(allowed_path)?;
    connection
        .execute_batch(&format!(
            "SET allowed_paths=[{allowed}]; SET enable_external_access=false"
        ))
        .map_err(internal_duckdb)
}

fn quote_sql_string(path: &Path) -> Result<String, AppError> {
    let path = path
        .to_str()
        .ok_or_else(|| AppError::InvalidPath("Query source path is not valid UTF-8".into()))?;
    Ok(format!("'{}'", path.replace('\'', "''")))
}

fn safe_sql_error(error: duckdb::Error) -> AppError {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("out of memory")
        || message.contains("memory limit")
        || message.contains("temp_directory")
        || message.contains("maximum temp")
    {
        AppError::ResourceExhausted("The query exceeded its resource limit".into())
    } else {
        AppError::Sql("The query could not be prepared or executed".into())
    }
}

fn internal_duckdb(error: duckdb::Error) -> AppError {
    AppError::Internal(format!("DuckDB operation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{open_configured_connection, restrict_external_access};

    #[test]
    fn config_sets_temp_limit_and_external_access_can_be_disabled() {
        let query_id = uuid::Uuid::new_v4().to_string();
        let connection = open_configured_connection(&query_id).unwrap();
        let temp_limit: String = connection
            .query_row(
                "SELECT current_setting('max_temp_directory_size')::VARCHAR",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!temp_limit.is_empty());
        let directory = tempfile::tempdir().unwrap();
        let allowed = directory.path().join("allowed.csv");
        fs::write(&allowed, "id\n1\n").unwrap();
        restrict_external_access(&connection, &allowed).unwrap();
        let value: i64 = connection
            .query_row(
                &format!(
                    "SELECT id FROM read_csv_auto('{}')",
                    allowed.to_str().unwrap().replace('\'', "''")
                ),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, 1);
        assert!(
            connection
                .prepare("SELECT * FROM read_csv_auto('/tmp/blocked.csv')")
                .is_err()
        );
    }
}

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Instant;

use crossbeam_channel::Receiver;
use duckdb::types::Value;
use duckdb::{Config, Connection};

use super::QueryJob;
use super::values::cell_from_array;
use crate::error::AppError;
use crate::files::QuerySource;
use crate::filters::BoundValue;
use crate::models::{CellValue, ColumnSchema, QueryBatch};

pub(super) fn worker_loop(jobs: Receiver<QueryJob>) {
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
    let schema_values = job
        .schema_params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut schema_statement = connection
        .prepare(&job.schema_sql)
        .map_err(safe_sql_error)?;
    let schema = schema_statement
        .query_arrow(duckdb::params_from_iter(schema_values.iter()))
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
    let execution_values = job
        .execution_params
        .iter()
        .map(bound_to_duck_value)
        .collect::<Vec<_>>();
    let mut statement = connection
        .prepare(&job.execution_sql)
        .map_err(safe_sql_error)?;
    if job.ready.send(Ok(columns)).is_err() {
        return Ok(());
    }
    *ready_sent = true;

    let mut returned_rows = 0_u64;
    let mut batch = Vec::with_capacity(job.batch_size);
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

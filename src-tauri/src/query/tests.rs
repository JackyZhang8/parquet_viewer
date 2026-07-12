use super::QueryService;
use super::sql_policy::validate_user_sql;
use crate::files::FileRegistry;
use crate::filters::{BoundValue, compile_filter_query};
use crate::models::CellValue;
use crate::models::{
    ColumnSchema, FilterCondition, FilterOperator, FilterQueryRequest, FilterQueryStartRequest,
    QueryRequest, SessionScalar,
};
use arrow_array::{Date32Array, Decimal128Array, RecordBatch, StringArray, UInt64Array};
use arrow_schema::{DataType, Field, Schema};
use duckdb::Connection;
use duckdb::types::Value;
use parquet::arrow::ArrowWriter;
use std::fs::File;
use std::io::Write;
use std::sync::Arc;
use tempfile::TempDir;

#[test]
fn accepts_select_and_cte_over_data() {
    for sql in [
        "SELECT * FROM data",
        "WITH filtered AS (SELECT * FROM data WHERE id > 1) SELECT * FROM filtered",
    ] {
        assert!(validate_user_sql(sql).is_ok(), "{sql}");
    }
}

#[test]
fn rejects_non_select_query_bodies_and_offset_at_any_depth() {
    for sql in [
        "VALUES (1)",
        "TABLE data",
        "SELECT * FROM data UNION SELECT * FROM data",
        "SELECT * FROM data OFFSET 1",
        "SELECT * FROM (SELECT * FROM data OFFSET 1) nested",
        "WITH nested AS (SELECT * FROM data OFFSET 1) SELECT * FROM nested",
    ] {
        assert!(
            validate_user_sql(sql).is_err(),
            "accepted forbidden SQL: {sql}"
        );
    }
    assert!(
        validate_user_sql("WITH filtered AS (SELECT * FROM data) SELECT * FROM filtered").is_ok()
    );
}

#[test]
fn rejects_non_query_multiple_statement_and_external_sources() {
    let rejected = [
        "DELETE FROM data",
        "SELECT * FROM data; SELECT * FROM data",
        "SELECT * FROM main.data",
        "SELECT * FROM read_parquet('/private/secret.parquet')",
        "WITH x AS (SELECT * FROM read_csv_auto('https://example.test/x')) SELECT * FROM x",
        "SELECT * FROM other_table",
    ];
    for sql in rejected {
        assert!(
            validate_user_sql(sql).is_err(),
            "accepted unsafe SQL: {sql}"
        );
    }
}

#[test]
fn deny_list_covers_file_network_and_extension_scans() {
    for function in super::sql_policy::DENIED_EXTERNAL_FUNCTIONS {
        let sql = format!("SELECT {function}('payload') FROM data");
        assert!(validate_user_sql(&sql).is_err(), "accepted {function}");
    }
}

#[test]
fn cte_cannot_smuggle_an_external_table() {
    assert!(
        validate_user_sql("WITH data AS (SELECT * FROM secret.catalog) SELECT * FROM data")
            .is_err()
    );
}

fn registered_fixture(rows: u32) -> (TempDir, FileRegistry, String) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rows.parquet");
    let connection = Connection::open_in_memory().unwrap();
    let quoted = path.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!(
            "COPY (SELECT range AS id, 'row-' || range AS name FROM range({rows})) TO '{quoted}' (FORMAT PARQUET)"
        ))
        .unwrap();
    let registry = FileRegistry::default();
    let metadata = registry.open_paths(vec![path]).remove(0).unwrap();
    (directory, registry, metadata.file_id)
}

fn add_fixture(directory: &TempDir, registry: &FileRegistry, name: &str, rows: u32) -> String {
    let path = directory.path().join(name);
    let connection = Connection::open_in_memory().unwrap();
    let quoted = path.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!(
            "COPY (SELECT range AS id FROM range({rows})) TO '{quoted}' (FORMAT PARQUET)"
        ))
        .unwrap();
    registry.open_paths(vec![path]).remove(0).unwrap().file_id
}

fn request(file_id: String, sql: &str, batch_size: u32, preview_limit: u32) -> QueryRequest {
    QueryRequest {
        file_id,
        sql: sql.into(),
        batch_size,
        preview_limit,
    }
}

#[test]
fn streams_ten_rows_in_bounded_batches_and_removes_final_cursor() {
    let (_directory, registry, file_id) = registered_fixture(10);
    let service = QueryService::default();
    let started = service
        .start_query(request(file_id, "SELECT * FROM data", 3, 100), &registry)
        .unwrap();
    assert_eq!(started.columns.len(), 2);

    let mut sizes = Vec::new();
    let final_batch = loop {
        let batch = service.fetch_query_batch(&started.query_id).unwrap();
        sizes.push(batch.rows.len());
        if batch.done {
            break batch;
        }
    };
    assert_eq!(sizes, vec![3, 3, 3, 1]);
    assert_eq!(final_batch.returned_rows, 10);
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn empty_query_returns_one_final_empty_batch() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    let started = service
        .start_query(
            request(file_id, "SELECT * FROM data WHERE false", 3, 100),
            &registry,
        )
        .unwrap();
    let batch = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(batch.done);
    assert!(batch.rows.is_empty());
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn validates_batch_and_preview_bounds_before_starting() {
    let registry = FileRegistry::default();
    let service = QueryService::default();
    for (batch_size, preview_limit) in [(0, 1), (5001, 1), (1, 0), (1, 100_001)] {
        assert!(
            service
                .start_query(
                    request(
                        "missing".into(),
                        "SELECT * FROM data",
                        batch_size,
                        preview_limit
                    ),
                    &registry,
                )
                .is_err()
        );
        assert_eq!(service.active_cursor_count(), 0);
    }
}

#[test]
fn converts_integer_extremes_decimal_blob_date_and_null_without_precision_loss() {
    use super::values::cell_from_value;
    assert_eq!(
        cell_from_value(Value::HugeInt(i128::MAX)),
        CellValue::String(i128::MAX.to_string())
    );
    assert_eq!(
        cell_from_value(Value::UBigInt(u64::MAX)),
        CellValue::Unsigned(u64::MAX)
    );
    assert_eq!(
        cell_from_value(Value::Decimal("12345678901234567890.1234".parse().unwrap())),
        CellValue::String("12345678901234567890.1234".into())
    );
    assert_eq!(cell_from_value(Value::Null), CellValue::Null);
    assert_eq!(
        cell_from_value(Value::Date32(1)),
        CellValue::String("date-days:1".into())
    );
    let blob = cell_from_value(Value::Blob(vec![0, 0xff, 0x10]));
    assert_eq!(serde_json::to_value(blob).unwrap()["value"], "00ff10");
}

#[test]
fn syntax_error_leaves_no_cursor() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    assert!(
        service
            .start_query(request(file_id, "SELECT FROM", 3, 100), &registry)
            .is_err()
    );
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn duckdb_preparation_error_leaves_no_cursor() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    assert!(matches!(
        service.start_query(
            request(file_id, "SELECT missing_column FROM data", 3, 100),
            &registry,
        ),
        Err(crate::error::AppError::Sql(_))
    ));
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn cancel_removes_cursor_and_later_fetch_is_unknown() {
    let (_directory, registry, file_id) = registered_fixture(100);
    let service = QueryService::default();
    let started = service
        .start_query(
            request(
                file_id,
                "SELECT count(*) FROM data a CROSS JOIN data b CROSS JOIN data c",
                1,
                100,
            ),
            &registry,
        )
        .unwrap();
    service.cancel_query(&started.query_id).unwrap();
    assert_eq!(service.active_cursor_count(), 0);
    assert!(matches!(
        service.fetch_query_batch(&started.query_id),
        Err(crate::error::AppError::InvalidArgument(_))
    ));
}

#[test]
fn new_query_replaces_previous_query_for_file() {
    let (_directory, registry, file_id) = registered_fixture(20);
    let service = QueryService::default();
    let first = service
        .start_query(
            request(file_id.clone(), "SELECT * FROM data", 1, 100),
            &registry,
        )
        .unwrap();
    let second = service
        .start_query(request(file_id, "SELECT id FROM data", 2, 100), &registry)
        .unwrap();
    assert!(service.fetch_query_batch(&first.query_id).is_err());
    assert_eq!(service.active_cursor_count(), 1);
    service.cancel_query(&second.query_id).unwrap();
}

#[test]
fn close_file_cancels_all_related_queries() {
    let (_directory, registry, file_id) = registered_fixture(10);
    let service = QueryService::default();
    service
        .start_query(
            request(file_id.clone(), "SELECT * FROM data", 1, 100),
            &registry,
        )
        .unwrap();
    service.close_file(&file_id);
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn stale_file_is_rejected_before_cursor_creation() {
    let (directory, registry, file_id) = registered_fixture(2);
    let path = directory.path().join("rows.parquet");
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    let service = QueryService::default();
    assert!(matches!(
        service.start_query(request(file_id, "SELECT * FROM data", 2, 100), &registry),
        Err(crate::error::AppError::StaleFile(_))
    ));
    assert_eq!(service.active_cursor_count(), 0);
}

fn duck_value(value: &BoundValue) -> Value {
    match value {
        BoundValue::Bool(value) => Value::Boolean(*value),
        BoundValue::SignedInteger(value) => Value::BigInt(*value),
        BoundValue::UnsignedInteger(value) => Value::UBigInt(*value),
        BoundValue::Float(value) => Value::Double(*value),
        BoundValue::Decimal(value) | BoundValue::String(value) => Value::Text(value.clone()),
    }
}

#[test]
fn task4_compiled_filters_execute_with_exact_bound_values() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("typed.parquet");
    let quoted = path.to_string_lossy().replace('\'', "''");
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(&format!(
        "COPY (SELECT 18446744073709551615::UBIGINT AS u, 12345678901234567890.1234::DECIMAL(24,4) AS d, DATE '2026-07-12' AS day, 'prefix-middle-suffix'::VARCHAR AS text) TO '{quoted}' (FORMAT PARQUET)"
    )).unwrap();
    let schema = vec![
        ColumnSchema {
            name: "u".into(),
            logical_type: "UINT64".into(),
            nullable: false,
        },
        ColumnSchema {
            name: "d".into(),
            logical_type: "DECIMAL(24,4)".into(),
            nullable: false,
        },
        ColumnSchema {
            name: "day".into(),
            logical_type: "DATE".into(),
            nullable: false,
        },
        ColumnSchema {
            name: "text".into(),
            logical_type: "VARCHAR".into(),
            nullable: false,
        },
    ];
    let condition = |column: &str, operator, value| FilterCondition {
        column: column.into(),
        operator,
        value: Some(value),
    };
    let request = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![
            condition(
                "u",
                FilterOperator::Eq,
                SessionScalar::Integer(u64::MAX.to_string()),
            ),
            condition(
                "d",
                FilterOperator::Eq,
                SessionScalar::Decimal("12345678901234567890.1234".into()),
            ),
            condition(
                "day",
                FilterOperator::Eq,
                SessionScalar::String("2026-07-12".into()),
            ),
            condition(
                "text",
                FilterOperator::Contains,
                SessionScalar::String("middle".into()),
            ),
            condition(
                "text",
                FilterOperator::StartsWith,
                SessionScalar::String("prefix".into()),
            ),
            condition(
                "text",
                FilterOperator::EndsWith,
                SessionScalar::String("suffix".into()),
            ),
        ],
        sorts: vec![],
        preview_limit: 10,
    };
    let compiled = compile_filter_query(path.to_str().unwrap(), &schema, &request).unwrap();
    let params = compiled.params.iter().map(duck_value).collect::<Vec<_>>();
    let mut statement = connection.prepare(&compiled.sql).unwrap();
    let mut rows = statement
        .query(duckdb::params_from_iter(params.iter()))
        .unwrap();
    assert!(rows.next().unwrap().is_some());
    assert!(rows.next().unwrap().is_none());

    let attack = "' OR 1=1 --";
    let request = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![condition(
            "text",
            FilterOperator::Eq,
            SessionScalar::String(attack.into()),
        )],
        sorts: vec![],
        preview_limit: 10,
    };
    let compiled = compile_filter_query(path.to_str().unwrap(), &schema, &request).unwrap();
    assert!(!compiled.sql.contains(attack));
    let params = compiled.params.iter().map(duck_value).collect::<Vec<_>>();
    let mut statement = connection.prepare(&compiled.sql).unwrap();
    let mut rows = statement
        .query(duckdb::params_from_iter(params.iter()))
        .unwrap();
    assert!(rows.next().unwrap().is_none());
}

fn filter_start(file_id: String, query: FilterQueryRequest) -> FilterQueryStartRequest {
    FilterQueryStartRequest {
        file_id,
        query,
        batch_size: 2,
    }
}

#[test]
fn filter_query_runs_through_service_with_exact_typed_values_and_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("typed-service.parquet");
    let schema = Arc::new(Schema::new(vec![
        Field::new("u", DataType::UInt64, false),
        Field::new("d", DataType::Decimal128(24, 4), false),
        Field::new("day", DataType::Date32, false),
        Field::new("text", DataType::Utf8, false),
    ]));
    let decimal = Decimal128Array::from(vec!["123456789012345678901234".parse::<i128>().unwrap()])
        .with_precision_and_scale(24, 4)
        .unwrap();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(UInt64Array::from(vec![u64::MAX])),
            Arc::new(decimal),
            Arc::new(Date32Array::from(vec![20_646])),
            Arc::new(StringArray::from(vec!["prefix-middle-suffix"])),
        ],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    let registry = FileRegistry::default();
    let metadata = registry.open_paths(vec![path]).remove(0).unwrap();
    let condition = |column: &str, operator, value| FilterCondition {
        column: column.into(),
        operator,
        value: Some(value),
    };
    let query = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![
            condition(
                "u",
                FilterOperator::Eq,
                SessionScalar::Integer(u64::MAX.to_string()),
            ),
            condition(
                "d",
                FilterOperator::Eq,
                SessionScalar::Decimal("12345678901234567890.1234".into()),
            ),
            condition(
                "day",
                FilterOperator::Eq,
                SessionScalar::String("2026-07-12".into()),
            ),
            condition(
                "text",
                FilterOperator::Contains,
                SessionScalar::String("middle".into()),
            ),
            condition(
                "text",
                FilterOperator::StartsWith,
                SessionScalar::String("prefix".into()),
            ),
            condition(
                "text",
                FilterOperator::EndsWith,
                SessionScalar::String("suffix".into()),
            ),
        ],
        sorts: vec![],
        preview_limit: 10,
    };
    let service = QueryService::default();
    let started = service
        .start_filter_query(filter_start(metadata.file_id.clone(), query), &registry)
        .unwrap();
    let batch = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(batch.done);
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(service.active_cursor_count(), 0);

    let attack = "' OR 1=1 --";
    let malicious = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![condition(
            "text",
            FilterOperator::Eq,
            SessionScalar::String(attack.into()),
        )],
        sorts: vec![],
        preview_limit: 10,
    };
    let started = service
        .start_filter_query(filter_start(metadata.file_id, malicious), &registry)
        .unwrap();
    let batch = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(batch.done);
    assert!(batch.rows.is_empty());
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn filter_query_service_binds_authoritative_unsigned_schema() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("unsigned.parquet");
    let schema = Arc::new(Schema::new(vec![Field::new("u", DataType::UInt64, false)]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![Arc::new(UInt64Array::from(vec![u64::MAX]))],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    let registry = FileRegistry::default();
    let metadata = registry.open_paths(vec![path]).remove(0).unwrap();
    let query = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![FilterCondition {
            column: "u".into(),
            operator: FilterOperator::Eq,
            value: Some(SessionScalar::Integer(u64::MAX.to_string())),
        }],
        sorts: vec![],
        preview_limit: 10,
    };
    let service = QueryService::default();
    let started = service
        .start_filter_query(filter_start(metadata.file_id, query), &registry)
        .unwrap();
    let batch = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(batch.done);
    assert_eq!(batch.rows.len(), 1);
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn filter_query_uses_same_replacement_close_and_stale_lifecycle() {
    let (directory, registry, file_id) = registered_fixture(20);
    let service = QueryService::default();
    let filter = FilterQueryRequest {
        selected_columns: vec![],
        filters: vec![],
        sorts: vec![],
        preview_limit: 20,
    };
    let cancelled = service
        .start_filter_query(filter_start(file_id.clone(), filter.clone()), &registry)
        .unwrap();
    service.cancel_query(&cancelled.query_id).unwrap();
    assert_eq!(service.active_cursor_count(), 0);
    let first = service
        .start_filter_query(filter_start(file_id.clone(), filter.clone()), &registry)
        .unwrap();
    let replacement = service
        .start_query(
            request(file_id.clone(), "SELECT * FROM data", 1, 20),
            &registry,
        )
        .unwrap();
    assert!(service.fetch_query_batch(&first.query_id).is_err());
    service.cancel_query(&replacement.query_id).unwrap();
    service
        .start_filter_query(filter_start(file_id.clone(), filter.clone()), &registry)
        .unwrap();
    service.close_file(&file_id);
    assert_eq!(service.active_cursor_count(), 0);

    let path = directory.path().join("rows.parquet");
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    assert!(matches!(
        service.start_filter_query(filter_start(file_id, filter), &registry),
        Err(crate::error::AppError::StaleFile(_))
    ));
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn third_query_queues_on_fixed_pool_and_close_cancels_it() {
    let directory = tempfile::tempdir().unwrap();
    let registry = FileRegistry::default();
    let file1 = add_fixture(&directory, &registry, "one.parquet", 20);
    let file2 = add_fixture(&directory, &registry, "two.parquet", 20);
    let file3 = add_fixture(&directory, &registry, "three.parquet", 20);
    let service = QueryService::default();
    let first = service
        .start_query(request(file1, "SELECT * FROM data", 1, 100), &registry)
        .unwrap();
    let second = service
        .start_query(request(file2, "SELECT * FROM data", 1, 100), &registry)
        .unwrap();
    let queued_service = service.clone();
    let queued_registry = registry.clone();
    let queued_file = file3.clone();
    let queued = std::thread::spawn(move || {
        queued_service.start_query(
            request(queued_file, "SELECT * FROM data", 1, 100),
            &queued_registry,
        )
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while service.active_cursor_count() != 3 && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(service.active_cursor_count(), 3);
    service.close_file(&file3);
    service.cancel_query(&first.query_id).unwrap();
    service.cancel_query(&second.query_id).unwrap();
    assert!(queued.join().unwrap().is_err());
    assert_eq!(service.active_cursor_count(), 0);
}

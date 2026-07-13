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

#[test]
fn nested_cte_alias_does_not_leak_to_outer_query_scope() {
    assert!(validate_user_sql(
        "SELECT * FROM (WITH leaked AS (SELECT * FROM data) SELECT * FROM leaked) nested JOIN leaked ON true"
    ).is_err());
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
fn preview_limit_reports_exact_truncation_at_row_boundaries() {
    for (source_rows, expected_truncated) in [(4, false), (5, false), (6, true)] {
        let (_directory, registry, file_id) = registered_fixture(source_rows);
        let service = QueryService::default();
        let started = service
            .start_query(request(file_id, "SELECT * FROM data", 2, 5), &registry)
            .unwrap();
        let mut rows = 0;
        let final_batch = loop {
            let batch = service.fetch_query_batch(&started.query_id).unwrap();
            rows += batch.rows.len();
            if batch.done {
                break batch;
            }
        };
        assert_eq!(rows, source_rows.min(5) as usize);
        assert_eq!(final_batch.returned_rows, u64::from(source_rows.min(5)));
        assert_eq!(final_batch.truncated, expected_truncated);
    }
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
fn raw_sql_length_is_bounded_before_query_admission() {
    const MAX_SQL_BYTES: usize = 256 * 1024;
    let (_directory, registry, file_id) = registered_fixture(1);
    let service = QueryService::default();
    let exact = format!("SELECT 1{}", " ".repeat(MAX_SQL_BYTES - "SELECT 1".len()));
    let started = service
        .start_query(request(file_id.clone(), &exact, 1, 1), &registry)
        .unwrap();
    while !service.fetch_query_batch(&started.query_id).unwrap().done {}
    let over = format!("{exact} ");
    assert!(matches!(
        service.start_query(request(file_id, &over, 1, 1), &registry),
        Err(crate::error::AppError::InvalidArgument(_))
    ));
    service.wait_for_admitted_for_test(0);
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
    assert_eq!(serde_json::to_value(blob).unwrap()["value"], "AP8Q");
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
fn syntax_error_serializes_a_safe_location_without_sql_or_engine_text() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    let error = service
        .start_query(request(file_id, "SELECT 1 IS a", 3, 100), &registry)
        .unwrap_err();
    let wire = serde_json::to_value(error).unwrap();
    assert_eq!(wire["code"], "SQL_ERROR");
    assert_eq!(wire["message"], "The query has invalid SQL syntax");
    let detail = wire["detail"].as_str().unwrap();
    assert!(detail.contains("Parser Error:"));
    assert!(detail.lines().last().unwrap().starts_with("line "));
    let serialized = wire.to_string();
    assert!(!serialized.contains("SELECT 1"));
    assert!(!serialized.contains("sql parser"));
    assert!(!serialized.contains("parquet"));
}

#[test]
fn duckdb_preparation_error_leaves_no_cursor() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    let error = service
        .start_query(
            request(file_id, "SELECT missing_column FROM data", 3, 100),
            &registry,
        )
        .unwrap_err();
    assert!(matches!(
        &error,
        crate::error::AppError::Sql(_) | crate::error::AppError::SqlLocated { .. }
    ));
    let wire = serde_json::to_value(error).unwrap();
    assert_eq!(
        wire["message"],
        "The query could not be prepared or executed"
    );
    assert!(wire["detail"].as_str().is_some_and(|detail| {
        detail.contains("Binder Error:")
            && detail
                .lines()
                .last()
                .is_some_and(|line| line.starts_with("line "))
    }));
    assert!(!wire.to_string().contains("missing_column"));
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn cancel_removes_cursor_and_later_fetch_is_unknown() {
    let (_directory, registry, file_id) = registered_fixture(100);
    let service = QueryService::default();
    let started = service
        .start_query(
            request(
                file_id.clone(),
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
fn rejected_replacement_leaves_existing_cursor_usable() {
    let (_directory, registry, file_id) = registered_fixture(20);
    let service = QueryService::default();
    let first = service
        .start_query(
            request(file_id.clone(), "SELECT * FROM data", 1, 100),
            &registry,
        )
        .unwrap();
    let _replacement_guard = service.hold_replacement_gate_for_test();

    assert!(matches!(
        service.start_query(request(file_id, "SELECT id FROM data", 2, 100), &registry,),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));
    assert_eq!(service.active_cursor_count(), 1);
    assert!(service.fetch_query_batch(&first.query_id).is_ok());
    service.cancel_query(&first.query_id).unwrap();
}

#[test]
fn escaped_cell_is_rejected_by_serialized_json_size() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("escaped.parquet");
    let schema = Arc::new(Schema::new(vec![Field::new("text", DataType::Utf8, false)]));
    let value = "\n".repeat(600_000);
    assert!(value.len() < super::values::MAX_CELL_ENCODED_BYTES);
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![Arc::new(StringArray::from(vec![value]))],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    let registry = FileRegistry::default();
    let file_id = registry.open_paths(vec![path]).remove(0).unwrap().file_id;
    let service = QueryService::default();
    let started = service
        .start_query(request(file_id, "SELECT * FROM data", 1, 1), &registry)
        .unwrap();

    assert!(matches!(
        service.fetch_query_batch(&started.query_id),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));
    service.wait_for_admitted_for_test(0);
}

#[test]
fn batches_include_json_envelope_in_encoded_size_limit() {
    const MAX_BATCH_ENCODED_BYTES: usize = 8 * 1024 * 1024;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-batch.parquet");
    let schema = Arc::new(Schema::new(vec![Field::new("text", DataType::Utf8, false)]));
    let value = "x".repeat(super::values::MAX_CELL_ENCODED_BYTES - 2);
    let values = vec![value.as_str(); 8];
    let batch =
        RecordBatch::try_new(schema.clone(), vec![Arc::new(StringArray::from(values))]).unwrap();
    let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    let registry = FileRegistry::default();
    let file_id = registry.open_paths(vec![path]).remove(0).unwrap().file_id;
    let service = QueryService::default();
    let started = service
        .start_query(request(file_id, "SELECT * FROM data", 8, 8), &registry)
        .unwrap();

    let first = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(!first.done);
    assert!(first.rows.len() < 8);
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_BATCH_ENCODED_BYTES);
    let second = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(serde_json::to_vec(&second).unwrap().len() <= MAX_BATCH_ENCODED_BYTES);
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

#[test]
fn admission_rejects_fifth_outstanding_query_without_publishing_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let registry = FileRegistry::default();
    let files = (0..5)
        .map(|index| add_fixture(&directory, &registry, &format!("{index}.parquet"), 20))
        .collect::<Vec<_>>();
    let service = QueryService::default();
    let first = service
        .start_query(
            request(files[0].clone(), "SELECT * FROM data", 1, 20),
            &registry,
        )
        .unwrap();
    let second = service
        .start_query(
            request(files[1].clone(), "SELECT * FROM data", 1, 20),
            &registry,
        )
        .unwrap();
    let queued = files[2..4]
        .iter()
        .map(|file_id| {
            let file_id = file_id.clone();
            let service = service.clone();
            let registry = registry.clone();
            std::thread::spawn(move || {
                service.start_query(request(file_id, "SELECT * FROM data", 1, 20), &registry)
            })
        })
        .collect::<Vec<_>>();
    service.wait_for_admitted_for_test(4);
    assert_eq!(service.admitted_count_for_test(), 4);
    assert!(service.running_count_for_test() <= 2);
    assert!(service.queued_count_for_test() <= 2);
    let replacement = service
        .start_query(
            request(files[0].clone(), "SELECT id FROM data", 1, 20),
            &registry,
        )
        .unwrap();
    assert_eq!(service.admitted_count_for_test(), 4);
    assert_eq!(service.active_cursor_count(), 4);
    assert!(matches!(
        service.start_query(
            request(files[4].clone(), "SELECT * FROM data", 1, 20),
            &registry
        ),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));
    assert!(service.active_cursor_count() <= 4);
    assert!(service.cancel_query(&first.query_id).is_err());
    service.cancel_query(&replacement.query_id).unwrap();
    service.cancel_query(&second.query_id).unwrap();
    for handle in queued {
        let started = handle.join().unwrap().unwrap();
        service.cancel_query(&started.query_id).unwrap();
    }
    service.wait_for_admitted_for_test(0);
}

#[test]
fn rapid_same_file_replacements_share_one_bounded_admission() {
    let (_directory, registry, file_id) = registered_fixture(20);
    let service = QueryService::default();
    let mut current = service
        .start_query(
            request(file_id.clone(), "SELECT * FROM data", 1, 20),
            &registry,
        )
        .unwrap();
    for _ in 0..12 {
        current = service
            .start_query(
                request(file_id.clone(), "SELECT id FROM data", 1, 20),
                &registry,
            )
            .unwrap();
        assert_eq!(service.active_cursor_count(), 1);
        assert_eq!(service.admitted_count_for_test(), 1);
        assert!(service.running_count_for_test() <= 2);
        assert!(service.queued_count_for_test() <= 3);
    }
    service.cancel_query(&current.query_id).unwrap();
    service.wait_for_admitted_for_test(0);
    assert_eq!(service.active_cursor_count(), 0);
}

#[test]
fn simultaneous_same_file_starts_publish_exactly_one_current_cursor() {
    let (_directory, registry, file_id) = registered_fixture(20);
    let service = QueryService::default();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let starts = (0..2)
        .map(|_| {
            let service = service.clone();
            let registry = registry.clone();
            let file_id = file_id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                service.start_query(request(file_id, "SELECT * FROM data", 1, 20), &registry)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = starts
        .into_iter()
        .map(|start| start.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(service.active_cursor_count(), 1);
    assert!(service.admitted_count_for_test() <= 2);
    assert!(results.iter().any(Result::is_ok));
    for started in results.into_iter().flatten() {
        let _ = service.cancel_query(&started.query_id);
    }
    service.wait_for_admitted_for_test(0);
}

#[test]
fn resource_limits_reject_wide_schema_and_oversized_cells_with_cleanup() {
    let (_directory, registry, file_id) = registered_fixture(10);
    let service = QueryService::default();
    let projection = (0..513)
        .map(|index| format!("{index} AS c{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    assert!(matches!(
        service.start_query(
            request(file_id.clone(), &format!("SELECT {projection}"), 1, 1),
            &registry
        ),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));
    assert_eq!(service.active_cursor_count(), 0);

    let started = service
        .start_query(
            request(
                file_id.clone(),
                "SELECT repeat('x', 1048577) AS huge FROM data",
                1,
                1,
            ),
            &registry,
        )
        .unwrap();
    assert!(matches!(
        service.fetch_query_batch(&started.query_id),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));
    assert_eq!(service.active_cursor_count(), 0);

    let started = service
        .start_query(
            request(
                file_id.clone(),
                "SELECT from_hex(repeat('aa', 800000)) AS huge_blob FROM data",
                1,
                1,
            ),
            &registry,
        )
        .unwrap();
    assert!(matches!(
        service.fetch_query_batch(&started.query_id),
        Err(crate::error::AppError::ResourceExhausted(_))
    ));

    let started = service
        .start_query(
            request(
                file_id,
                "SELECT repeat('x', 900000) AS payload FROM data",
                20,
                10,
            ),
            &registry,
        )
        .unwrap();
    let first = service.fetch_query_batch(&started.query_id).unwrap();
    let second = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(!first.done && second.done);
    assert_eq!(first.rows.len() + second.rows.len(), 10);
}

#[test]
fn injected_worker_panic_releases_admission_and_worker_survives() {
    let (_directory, registry, file_id) = registered_fixture(2);
    let service = QueryService::default();
    assert!(
        service
            .start_injected_panic_for_test(file_id.clone(), &registry)
            .is_err()
    );
    service.wait_for_admitted_for_test(0);
    let started = service
        .start_query(request(file_id, "SELECT * FROM data", 2, 2), &registry)
        .unwrap();
    while !service.fetch_query_batch(&started.query_id).unwrap().done {}
}

#[test]
fn nested_parquet_values_are_structured_cells_in_service_batches() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("nested-query.parquet");
    let quoted = path.to_string_lossy().replace('\'', "''");
    Connection::open_in_memory()
        .unwrap()
        .execute_batch(&format!(
            "COPY (SELECT [1, NULL, 3]::INTEGER[] AS items, {{'name': 'Ada', 'active': true}} AS profile, map(['score'], [42]) AS attributes) TO '{quoted}' (FORMAT PARQUET)"
        ))
        .unwrap();
    let registry = FileRegistry::default();
    let file_id = registry.open_paths(vec![path]).remove(0).unwrap().file_id;
    let service = QueryService::default();
    let started = service
        .start_query(request(file_id, "SELECT * FROM data", 1, 1), &registry)
        .unwrap();
    let batch = service.fetch_query_batch(&started.query_id).unwrap();
    assert!(matches!(batch.rows[0][0], CellValue::Array(_)));
    assert!(matches!(batch.rows[0][1], CellValue::Object(_)));
    assert!(matches!(batch.rows[0][2], CellValue::Array(_)));
}

#[cfg(unix)]
#[test]
fn guarded_fd_source_survives_replacement_of_original_path() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guarded.parquet");
    let connection = Connection::open_in_memory().unwrap();
    let quoted = path.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!(
            "COPY (SELECT 1 AS id) TO '{quoted}' (FORMAT PARQUET)"
        ))
        .unwrap();
    let registry = FileRegistry::default();
    let file_id = registry
        .open_paths(vec![path.clone()])
        .remove(0)
        .unwrap()
        .file_id;
    let source = registry.resolve_query_source(&file_id).unwrap();
    let replacement = directory.path().join("replacement.parquet");
    let quoted_replacement = replacement.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!(
            "COPY (SELECT 2 AS id) TO '{quoted_replacement}' (FORMAT PARQUET)"
        ))
        .unwrap();
    std::fs::rename(replacement, path).unwrap();
    let guarded = source.duckdb_path.to_str().unwrap().replace('\'', "''");
    let id: i64 = connection
        .query_row(
            &format!("SELECT id FROM read_parquet('{guarded}')"),
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(id, 1);
}

#[cfg(windows)]
#[test]
fn windows_query_source_blocks_replacement_until_guard_is_dropped() {
    let (directory, registry, file_id) = registered_fixture(1);
    let path = directory.path().join("rows.parquet");
    let source = registry.resolve_query_source(&file_id).unwrap();
    let guarded = source.duckdb_path.to_str().unwrap().replace('\'', "''");
    let connection = Connection::open_in_memory().unwrap();
    let id: i64 = connection
        .query_row(
            &format!("SELECT id FROM read_parquet('{guarded}')"),
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(id, 0);
    assert!(std::fs::remove_file(&path).is_err());
    drop(source);
    std::fs::remove_file(&path).unwrap();
}

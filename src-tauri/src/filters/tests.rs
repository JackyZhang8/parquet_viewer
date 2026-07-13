use super::{BoundValue, ColumnType, MAX_FILTERS, MAX_SELECTED_COLUMNS, compile_filter_query};
use crate::error::AppError;
use crate::models::{
    ColumnSchema, FilterCondition, FilterOperator, FilterQueryRequest, SessionScalar,
    SortDirection, SortSpec,
};
use serde_json::json;

fn column(name: &str, logical_type: &str) -> ColumnSchema {
    ColumnSchema {
        name: name.into(),
        logical_type: logical_type.into(),
        nullable: true,
    }
}

fn request() -> FilterQueryRequest {
    FilterQueryRequest {
        selected_columns: Vec::new(),
        filters: Vec::new(),
        sorts: Vec::new(),
        preview_limit: 100,
    }
}

fn filter(column: &str, operator: FilterOperator, value: SessionScalar) -> FilterCondition {
    FilterCondition {
        column: column.into(),
        operator,
        value: Some(value),
    }
}

#[test]
fn compiles_empty_request_and_binds_path_then_limit() {
    let compiled = compile_filter_query("/private/data.parquet", &[], &request()).unwrap();
    assert_eq!(compiled.sql, "SELECT * FROM read_parquet(?) LIMIT ?");
    assert_eq!(
        compiled.params,
        vec![
            BoundValue::String("/private/data.parquet".into()),
            BoundValue::UnsignedInteger(100),
        ]
    );
}

#[test]
fn compiles_typed_predicates_and_preserves_parameter_order() {
    let schema = [
        column("status", "UTF8"),
        column("amount", "INT64"),
        column("active", "BOOLEAN"),
    ];
    let mut request = request();
    request.filters = vec![
        filter(
            "status",
            FilterOperator::Eq,
            SessionScalar::String("paid".into()),
        ),
        filter(
            "amount",
            FilterOperator::Gte,
            SessionScalar::Integer(i64::MIN.to_string()),
        ),
        filter("active", FilterOperator::Eq, SessionScalar::Boolean(true)),
    ];

    let compiled = compile_filter_query("file.parquet", &schema, &request).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT * FROM read_parquet(?) WHERE \"status\" = ? AND \"amount\" >= ? AND \"active\" = ? LIMIT ?"
    );
    assert_eq!(
        compiled.params,
        vec![
            BoundValue::String("file.parquet".into()),
            BoundValue::String("paid".into()),
            BoundValue::SignedInteger(i64::MIN),
            BoundValue::Bool(true),
            BoundValue::UnsignedInteger(100),
        ]
    );
}

#[test]
fn compiles_null_and_text_function_predicates() {
    let schema = [column("note", "STRING")];
    let mut request = request();
    request.filters = vec![
        FilterCondition {
            column: "note".into(),
            operator: FilterOperator::IsNull,
            value: None,
        },
        filter(
            "note",
            FilterOperator::Contains,
            SessionScalar::String("%_".into()),
        ),
        filter(
            "note",
            FilterOperator::StartsWith,
            SessionScalar::String("a".into()),
        ),
        filter(
            "note",
            FilterOperator::EndsWith,
            SessionScalar::String("z".into()),
        ),
    ];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT * FROM read_parquet(?) WHERE \"note\" IS NULL AND contains(\"note\", ?) AND starts_with(\"note\", ?) AND ends_with(\"note\", ?) LIMIT ?"
    );
    assert_eq!(compiled.params.len(), 5);
}

#[test]
fn quotes_special_identifiers_and_compiles_three_sorts() {
    let schema = [
        column("order value", "DOUBLE"),
        column("say\"what", "VARCHAR"),
        column("created_at", "TIMESTAMP"),
    ];
    let mut request = request();
    request.selected_columns = vec!["order value".into(), "say\"what".into()];
    request.sorts = vec![
        SortSpec {
            column: "created_at".into(),
            direction: SortDirection::Desc,
        },
        SortSpec {
            column: "order value".into(),
            direction: SortDirection::Asc,
        },
        SortSpec {
            column: "say\"what".into(),
            direction: SortDirection::Desc,
        },
    ];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT \"order value\", \"say\"\"what\" FROM read_parquet(?) ORDER BY \"created_at\" DESC, \"order value\" ASC, \"say\"\"what\" DESC LIMIT ?"
    );
}

#[test]
fn rejects_unknown_and_duplicate_columns_and_fourth_sort() {
    let schema = [column("a", "INT32"), column("b", "INT32")];
    let mut unknown = request();
    unknown.selected_columns = vec!["missing".into()];
    assert!(
        matches!(compile_filter_query("secret", &schema, &unknown), Err(AppError::InvalidArgument(message)) if !message.contains("secret"))
    );

    let mut duplicate = request();
    duplicate.selected_columns = vec!["a".into(), "a".into()];
    assert!(compile_filter_query("file", &schema, &duplicate).is_err());

    let mut duplicate_sort = request();
    duplicate_sort.sorts = vec![
        SortSpec {
            column: "a".into(),
            direction: SortDirection::Asc,
        },
        SortSpec {
            column: "a".into(),
            direction: SortDirection::Desc,
        },
    ];
    assert!(compile_filter_query("file", &schema, &duplicate_sort).is_err());

    let mut too_many = request();
    too_many.sorts = (0..4)
        .map(|_| SortSpec {
            column: "a".into(),
            direction: SortDirection::Asc,
        })
        .collect();
    assert!(compile_filter_query("file", &schema, &too_many).is_err());
}

#[test]
fn rejects_operator_type_and_value_mismatches() {
    let schema = [
        column("flag", "BOOLEAN"),
        column("count", "UINT64"),
        column("text", "UTF8"),
    ];
    let cases = [
        filter(
            "flag",
            FilterOperator::Contains,
            SessionScalar::String("x".into()),
        ),
        filter(
            "count",
            FilterOperator::Eq,
            SessionScalar::String("1".into()),
        ),
        filter("text", FilterOperator::Eq, SessionScalar::Boolean(true)),
        filter(
            "count",
            FilterOperator::Eq,
            SessionScalar::Integer("-1".into()),
        ),
        filter(
            "count",
            FilterOperator::Eq,
            SessionScalar::Integer("18446744073709551616".into()),
        ),
    ];
    for condition in cases {
        let mut request = request();
        request.filters.push(condition);
        assert!(compile_filter_query("file", &schema, &request).is_err());
    }
}

#[test]
fn rewrites_explicit_null_equality_and_rejects_values_on_null_predicates() {
    let schema = [column("a", "INT64")];
    let mut request = request();
    request.filters = vec![
        filter("a", FilterOperator::Eq, SessionScalar::Null),
        filter("a", FilterOperator::NotEq, SessionScalar::Null),
    ];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT * FROM read_parquet(?) WHERE \"a\" IS NULL AND \"a\" IS NOT NULL LIMIT ?"
    );
    assert_eq!(compiled.params.len(), 2);

    request.filters = vec![filter("a", FilterOperator::IsNull, SessionScalar::Null)];
    assert!(compile_filter_query("file", &schema, &request).is_err());
}

#[test]
fn malicious_value_is_only_a_bound_parameter() {
    let schema = [column("status", "VARCHAR")];
    let attack = "' OR 1=1 --";
    let mut request = request();
    request.filters = vec![filter(
        "status",
        FilterOperator::Eq,
        SessionScalar::String(attack.into()),
    )];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert!(!compiled.sql.contains(attack));
    assert_eq!(compiled.params[1], BoundValue::String(attack.into()));
}

#[test]
fn rejects_preview_limits_outside_documented_bounds() {
    for preview_limit in [0, 100_001] {
        let mut request = request();
        request.preview_limit = preview_limit;
        assert!(compile_filter_query("file", &[], &request).is_err());
    }
}

#[test]
fn public_dtos_have_strict_camel_case_serde_shapes() {
    let condition = FilterCondition {
        column: "created_at".into(),
        operator: FilterOperator::StartsWith,
        value: Some(SessionScalar::String("2026".into())),
    };
    assert_eq!(
        serde_json::to_value(condition).unwrap(),
        json!({
            "column": "created_at", "operator": "startsWith", "value": { "type": "string", "value": "2026" }
        })
    );
    assert_eq!(
        serde_json::to_value(SortDirection::Desc).unwrap(),
        json!("desc")
    );
    let request = FilterQueryRequest {
        selected_columns: vec!["created_at".into()],
        filters: vec![],
        sorts: vec![SortSpec {
            column: "created_at".into(),
            direction: SortDirection::Desc,
        }],
        preview_limit: 50,
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "selectedColumns": ["created_at"],
            "filters": [],
            "sorts": [{ "column": "created_at", "direction": "desc" }],
            "previewLimit": 50
        })
    );
    assert!(serde_json::from_value::<FilterOperator>(json!("raw sql")).is_err());
}

#[test]
fn binds_unsigned_logical_integer_and_decimal_u64_boundary() {
    let schema = [
        column("unsigned", "INTEGER { BIT_WIDTH: 64, IS_SIGNED: FALSE }"),
        column("decimal", "DECIMAL(20,0)"),
    ];
    let mut request = request();
    request.filters = vec![
        filter(
            "unsigned",
            FilterOperator::Eq,
            SessionScalar::Integer(u64::MAX.to_string()),
        ),
        filter(
            "decimal",
            FilterOperator::Eq,
            SessionScalar::Integer(u64::MAX.to_string()),
        ),
    ];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert_eq!(compiled.params[1], BoundValue::UnsignedInteger(u64::MAX));
    assert_eq!(
        compiled.params[2],
        BoundValue::Decimal(u64::MAX.to_string())
    );
}

#[test]
fn classifies_emitted_logical_types_exactly_and_treats_int96_as_temporal() {
    let schema = [
        column("legacy_time", "INT96"),
        column("signed32", "INT32"),
        column("signed64", "INT64"),
        column("unsigned", "UINT64"),
        column(
            "unsigned_debug",
            "INTEGER { BIT_WIDTH: 64, IS_SIGNED: FALSE }",
        ),
        column("signed_debug", "INTEGER { BIT_WIDTH: 32, IS_SIGNED: TRUE }"),
        column("timestamp", "TIMESTAMP_MILLIS"),
        column("binary", "BINARY"),
        column("nested", "STRUCT"),
    ];
    let mut request = request();
    request.filters = vec![filter(
        "legacy_time",
        FilterOperator::Gte,
        SessionScalar::String("2026-01-01".into()),
    )];
    assert!(compile_filter_query("file", &schema, &request).is_ok());

    request.filters = vec![filter(
        "legacy_time",
        FilterOperator::Eq,
        SessionScalar::Integer("1".into()),
    )];
    assert!(compile_filter_query("file", &schema, &request).is_err());

    for name in ["binary", "nested"] {
        request.filters = vec![filter(
            name,
            FilterOperator::Eq,
            SessionScalar::String("x".into()),
        )];
        assert!(compile_filter_query("file", &schema, &request).is_err());
    }
}

#[test]
fn parses_only_supported_emitted_column_type_shapes() {
    let cases = [
        ("BOOLEAN", ColumnType::Boolean),
        ("BOOL", ColumnType::Boolean),
        ("STRING", ColumnType::Text),
        ("INT96", ColumnType::Temporal),
        ("INT32", ColumnType::SignedInteger),
        ("INT64", ColumnType::SignedInteger),
        ("UINT64", ColumnType::UnsignedInteger),
        (
            "INTEGER { BIT_WIDTH: 64, IS_SIGNED: FALSE }",
            ColumnType::UnsignedInteger,
        ),
        (
            "INTEGER { BIT_WIDTH: 32, IS_SIGNED: TRUE }",
            ColumnType::SignedInteger,
        ),
        ("TIMESTAMP_MILLIS", ColumnType::Temporal),
        (
            "TIME { IS_ADJUSTED_TO_U_T_C: FALSE, UNIT: MICROS }",
            ColumnType::Temporal,
        ),
        ("FLOAT", ColumnType::Float),
        ("DOUBLE", ColumnType::Float),
        (
            "DECIMAL(38,4)",
            ColumnType::Decimal {
                precision: 38,
                scale: 4,
            },
        ),
        ("BINARY", ColumnType::Unsupported),
        ("FIXED_BINARY", ColumnType::Unsupported),
        ("STRUCT", ColumnType::Unsupported),
        ("INT96 OR VARCHAR", ColumnType::Unsupported),
        ("DECIMAL(39,0)", ColumnType::Unsupported),
    ];
    for (logical_type, expected) in cases {
        assert_eq!(ColumnType::parse(logical_type), expected);
    }
}

#[test]
fn compiles_exact_decimals_with_validated_casts_and_bounds() {
    let schema = [
        column("amount", "DECIMAL(38,4)"),
        column("whole", "DECIMAL(38,0)"),
    ];
    let mut request = request();
    request.filters = vec![
        filter(
            "amount",
            FilterOperator::Gte,
            SessionScalar::Decimal("-9999999999999999999999999999999999.9999".into()),
        ),
        filter(
            "whole",
            FilterOperator::Eq,
            SessionScalar::Decimal("99999999999999999999999999999999999999".into()),
        ),
    ];
    let compiled = compile_filter_query("file", &schema, &request).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT * FROM read_parquet(?) WHERE \"amount\" >= CAST(? AS DECIMAL(38, 4)) AND \"whole\" = CAST(? AS DECIMAL(38, 0)) LIMIT ?"
    );
    assert_eq!(
        compiled.params[1],
        BoundValue::Decimal("-9999999999999999999999999999999999.9999".into())
    );
    assert_eq!(
        compiled.params[2],
        BoundValue::Decimal("99999999999999999999999999999999999999".into())
    );
}

#[test]
fn rejects_decimal_precision_scale_and_number_mismatches() {
    let cases = [
        (
            "DECIMAL(38,4)",
            SessionScalar::Decimal("10000000000000000000000000000000000.0000".into()),
        ),
        ("DECIMAL(38,4)", SessionScalar::Decimal("1.00000".into())),
        ("DECIMAL(38,0)", SessionScalar::Decimal("1.1".into())),
        ("DECIMAL(39,0)", SessionScalar::Decimal("1".into())),
        ("DECIMAL(10,11)", SessionScalar::Decimal("1".into())),
        ("DECIMAL(10,2)", SessionScalar::Number(1.5)),
        (
            "DECIMAL(38,0)",
            SessionScalar::Integer("99999999999999999999999999999999999999".into()),
        ),
    ];
    for (logical_type, value) in cases {
        let schema = [column("amount", logical_type)];
        let mut request = request();
        request.filters = vec![filter("amount", FilterOperator::Eq, value)];
        assert!(matches!(
            compile_filter_query("file", &schema, &request),
            Err(AppError::InvalidArgument(_))
        ));
    }
}

#[test]
fn enforces_filter_and_selection_caps_at_boundaries() {
    let schema = (0..=MAX_SELECTED_COLUMNS)
        .map(|index| column(&format!("c{index}"), "INT32"))
        .collect::<Vec<_>>();
    let mut request = request();
    request.selected_columns = (0..MAX_SELECTED_COLUMNS)
        .map(|index| format!("c{index}"))
        .collect();
    request.filters = (0..MAX_FILTERS)
        .map(|_| filter("c0", FilterOperator::Eq, SessionScalar::Integer("1".into())))
        .collect();
    assert!(compile_filter_query("file", &schema, &request).is_ok());

    request
        .selected_columns
        .push(format!("c{MAX_SELECTED_COLUMNS}"));
    assert!(matches!(
        compile_filter_query("file", &schema, &request),
        Err(AppError::InvalidArgument(_))
    ));
    request.selected_columns.pop();
    request.filters.push(filter(
        "c0",
        FilterOperator::Eq,
        SessionScalar::Integer("1".into()),
    ));
    assert!(matches!(
        compile_filter_query("file", &schema, &request),
        Err(AppError::InvalidArgument(_))
    ));
}

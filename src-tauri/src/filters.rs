use std::collections::{HashMap, HashSet};

use crate::error::AppError;
use crate::models::{
    ColumnSchema, FilterCondition, FilterOperator, FilterQueryRequest, SessionScalar, SortDirection,
};

pub const MAX_PREVIEW_LIMIT: u32 = 100_000;
const MAX_SORTS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum BoundValue {
    Null,
    Bool(bool),
    SignedInteger(i64),
    UnsignedInteger(u64),
    Float(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledQuery {
    pub sql: String,
    pub params: Vec<BoundValue>,
}

pub fn compile_filter_query(
    file_path: &str,
    schema: &[ColumnSchema],
    request: &FilterQueryRequest,
) -> Result<CompiledQuery, AppError> {
    if !(1..=MAX_PREVIEW_LIMIT).contains(&request.preview_limit) {
        return invalid("Preview limit must be between 1 and 100000");
    }
    if request.sorts.len() > MAX_SORTS {
        return invalid("At most three sort columns are allowed");
    }

    let columns: HashMap<&str, &ColumnSchema> = schema
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let projection = compile_projection(&columns, &request.selected_columns)?;
    let mut params = vec![BoundValue::String(file_path.to_owned())];
    let predicates = request
        .filters
        .iter()
        .map(|condition| compile_condition(&columns, condition, &mut params))
        .collect::<Result<Vec<_>, _>>()?;
    let order_by = compile_sorts(&columns, request)?;

    let mut sql = format!("SELECT {projection} FROM read_parquet(?)");
    if !predicates.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&predicates.join(" AND "));
    }
    if !order_by.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&order_by.join(", "));
    }
    sql.push_str(" LIMIT ?");
    params.push(BoundValue::UnsignedInteger(u64::from(
        request.preview_limit,
    )));
    Ok(CompiledQuery { sql, params })
}

fn compile_projection(
    schema: &HashMap<&str, &ColumnSchema>,
    selected: &[String],
) -> Result<String, AppError> {
    if selected.is_empty() {
        return Ok("*".into());
    }
    let mut seen = HashSet::new();
    selected
        .iter()
        .map(|name| {
            require_column(schema, name)?;
            if !seen.insert(name.as_str()) {
                return invalid("Selected columns must not contain duplicates");
            }
            Ok(quote_identifier(name))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|columns| columns.join(", "))
}

fn compile_sorts(
    schema: &HashMap<&str, &ColumnSchema>,
    request: &FilterQueryRequest,
) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    request
        .sorts
        .iter()
        .map(|sort| {
            require_column(schema, &sort.column)?;
            if !seen.insert(sort.column.as_str()) {
                return invalid("Sort columns must not contain duplicates");
            }
            let direction = match sort.direction {
                SortDirection::Asc => "ASC",
                SortDirection::Desc => "DESC",
            };
            Ok(format!("{} {direction}", quote_identifier(&sort.column)))
        })
        .collect()
}

fn compile_condition(
    schema: &HashMap<&str, &ColumnSchema>,
    condition: &FilterCondition,
    params: &mut Vec<BoundValue>,
) -> Result<String, AppError> {
    let column = require_column(schema, &condition.column)?;
    let identifier = quote_identifier(&condition.column);
    match condition.operator {
        FilterOperator::IsNull | FilterOperator::IsNotNull => {
            if condition.value.is_some() {
                return invalid("Null predicates must not include a value");
            }
            let operator = if condition.operator == FilterOperator::IsNull {
                "IS NULL"
            } else {
                "IS NOT NULL"
            };
            Ok(format!("{identifier} {operator}"))
        }
        operator => {
            let value = condition
                .value
                .as_ref()
                .ok_or_else(|| sql_error("Filter predicate requires a value"))?;
            if matches!(value, SessionScalar::Null) {
                return match operator {
                    FilterOperator::Eq => Ok(format!("{identifier} IS NULL")),
                    FilterOperator::NotEq => Ok(format!("{identifier} IS NOT NULL")),
                    _ => invalid("Null is only valid with equality operators"),
                };
            }
            validate_operator(column, operator)?;
            let bound = bind_value(column, value)?;
            let predicate = match operator {
                FilterOperator::Eq => format!("{identifier} = ?"),
                FilterOperator::NotEq => format!("{identifier} != ?"),
                FilterOperator::Lt => format!("{identifier} < ?"),
                FilterOperator::Lte => format!("{identifier} <= ?"),
                FilterOperator::Gt => format!("{identifier} > ?"),
                FilterOperator::Gte => format!("{identifier} >= ?"),
                FilterOperator::Contains => format!("contains({identifier}, ?)"),
                FilterOperator::StartsWith => format!("starts_with({identifier}, ?)"),
                FilterOperator::EndsWith => format!("ends_with({identifier}, ?)"),
                FilterOperator::IsNull | FilterOperator::IsNotNull => unreachable!(),
            };
            params.push(bound);
            Ok(predicate)
        }
    }
}

fn validate_operator(column: &ColumnSchema, operator: FilterOperator) -> Result<(), AppError> {
    let kind = logical_kind(&column.logical_type);
    let valid = match operator {
        FilterOperator::Contains | FilterOperator::StartsWith | FilterOperator::EndsWith => {
            kind == LogicalKind::Text
        }
        FilterOperator::Lt | FilterOperator::Lte | FilterOperator::Gt | FilterOperator::Gte => {
            matches!(
                kind,
                LogicalKind::Signed
                    | LogicalKind::Unsigned
                    | LogicalKind::Float
                    | LogicalKind::Text
                    | LogicalKind::Temporal
            )
        }
        FilterOperator::Eq | FilterOperator::NotEq => kind != LogicalKind::Unsupported,
        FilterOperator::IsNull | FilterOperator::IsNotNull => true,
    };
    if valid {
        Ok(())
    } else {
        invalid("Filter operator is incompatible with the column type")
    }
}

fn bind_value(column: &ColumnSchema, value: &SessionScalar) -> Result<BoundValue, AppError> {
    match (logical_kind(&column.logical_type), value) {
        (LogicalKind::Bool, SessionScalar::Boolean(value)) => Ok(BoundValue::Bool(*value)),
        (LogicalKind::Signed, SessionScalar::Integer(value)) => value
            .parse::<i64>()
            .map(BoundValue::SignedInteger)
            .map_err(|_| sql_error("Integer value is outside the supported signed range")),
        (LogicalKind::Unsigned, SessionScalar::Integer(value)) => value
            .parse::<u64>()
            .map(BoundValue::UnsignedInteger)
            .map_err(|_| sql_error("Integer value is outside the supported unsigned range")),
        (LogicalKind::Float, SessionScalar::Integer(value)) => {
            if value.starts_with('-') {
                value
                    .parse::<i64>()
                    .map(BoundValue::SignedInteger)
                    .map_err(|_| sql_error("Integer value is outside the supported signed range"))
            } else {
                value
                    .parse::<u64>()
                    .map(BoundValue::UnsignedInteger)
                    .map_err(|_| sql_error("Integer value is outside the supported unsigned range"))
            }
        }
        (LogicalKind::Float, SessionScalar::Number(value)) if value.is_finite() => {
            Ok(BoundValue::Float(*value))
        }
        (LogicalKind::Text | LogicalKind::Temporal, SessionScalar::String(value)) => {
            Ok(BoundValue::String(value.to_string()))
        }
        _ => invalid("Filter value is incompatible with the column type"),
    }
}

fn require_column<'a>(
    schema: &'a HashMap<&str, &'a ColumnSchema>,
    name: &str,
) -> Result<&'a ColumnSchema, AppError> {
    schema
        .get(name)
        .copied()
        .ok_or_else(|| sql_error("Filter query references an unknown column"))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogicalKind {
    Bool,
    Signed,
    Unsigned,
    Float,
    Text,
    Temporal,
    Unsupported,
}

fn logical_kind(logical_type: &str) -> LogicalKind {
    let upper = logical_type.to_ascii_uppercase();
    if upper.contains("BOOL") {
        LogicalKind::Bool
    } else if upper.contains("UTF8")
        || upper.contains("STRING")
        || upper.contains("VARCHAR")
        || upper.contains("CHAR")
    {
        LogicalKind::Text
    } else if upper.contains("TIMESTAMP") || upper.contains("DATE") || upper.contains("TIME") {
        LogicalKind::Temporal
    } else if upper.contains("FLOAT") || upper.contains("DOUBLE") || upper.contains("DECIMAL") {
        LogicalKind::Float
    } else if upper.contains("UINT")
        || upper.contains("UNSIGNED")
        || (upper.contains("INTEGER") && upper.contains("IS_SIGNED: FALSE"))
    {
        LogicalKind::Unsigned
    } else if upper.contains("INT") {
        LogicalKind::Signed
    } else {
        LogicalKind::Unsupported
    }
}

fn invalid<T>(message: &str) -> Result<T, AppError> {
    Err(sql_error(message))
}
fn sql_error(message: &str) -> AppError {
    AppError::Sql(message.into())
}

#[cfg(test)]
mod tests {
    use super::{BoundValue, compile_filter_query};
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
            matches!(compile_filter_query("secret", &schema, &unknown), Err(AppError::Sql(message)) if !message.contains("secret"))
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
        assert_eq!(compiled.params[2], BoundValue::UnsignedInteger(u64::MAX));
    }
}

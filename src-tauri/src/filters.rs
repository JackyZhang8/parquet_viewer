use std::collections::{HashMap, HashSet};

use crate::error::AppError;
use crate::models::{
    ColumnSchema, FilterCondition, FilterOperator, FilterQueryRequest, SessionScalar,
    SortDirection, is_canonical_decimal,
};

pub const MAX_PREVIEW_LIMIT: u32 = 100_000;
pub const MAX_FILTERS: usize = 100;
pub const MAX_SELECTED_COLUMNS: usize = 512;
const MAX_SORTS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum BoundValue {
    Bool(bool),
    SignedInteger(i64),
    UnsignedInteger(u64),
    Float(f64),
    Decimal(String),
    String(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledQuery {
    pub sql: String,
    pub params: Vec<BoundValue>,
}

// TODO(Task 5): exercise every BoundValue and generated DECIMAL cast against DuckDB execution.

pub fn compile_filter_query(
    file_path: &str,
    schema: &[ColumnSchema],
    request: &FilterQueryRequest,
) -> Result<CompiledQuery, AppError> {
    if !(1..=MAX_PREVIEW_LIMIT).contains(&request.preview_limit) {
        return invalid("Preview limit must be between 1 and 100000");
    }
    if request.filters.len() > MAX_FILTERS {
        return invalid("At most 100 filter conditions are allowed");
    }
    if request.selected_columns.len() > MAX_SELECTED_COLUMNS {
        return invalid("At most 512 selected columns are allowed");
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
    let column_type = ColumnType::parse(&column.logical_type);
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
                .ok_or_else(|| argument_error("Filter predicate requires a value"))?;
            if matches!(value, SessionScalar::Null) {
                return match operator {
                    FilterOperator::Eq => Ok(format!("{identifier} IS NULL")),
                    FilterOperator::NotEq => Ok(format!("{identifier} IS NOT NULL")),
                    _ => invalid("Null is only valid with equality operators"),
                };
            }
            validate_operator(column_type, operator)?;
            let bound = bind_value(column_type, value)?;
            let placeholder = match column_type {
                ColumnType::Decimal { precision, scale } => {
                    format!("CAST(? AS DECIMAL({precision}, {scale}))")
                }
                _ => "?".into(),
            };
            let predicate = match operator {
                FilterOperator::Eq => format!("{identifier} = {placeholder}"),
                FilterOperator::NotEq => format!("{identifier} != {placeholder}"),
                FilterOperator::Lt => format!("{identifier} < {placeholder}"),
                FilterOperator::Lte => format!("{identifier} <= {placeholder}"),
                FilterOperator::Gt => format!("{identifier} > {placeholder}"),
                FilterOperator::Gte => format!("{identifier} >= {placeholder}"),
                FilterOperator::Contains => format!("contains({identifier}, {placeholder})"),
                FilterOperator::StartsWith => {
                    format!("starts_with({identifier}, {placeholder})")
                }
                FilterOperator::EndsWith => format!("ends_with({identifier}, {placeholder})"),
                FilterOperator::IsNull | FilterOperator::IsNotNull => unreachable!(),
            };
            params.push(bound);
            Ok(predicate)
        }
    }
}

fn validate_operator(kind: ColumnType, operator: FilterOperator) -> Result<(), AppError> {
    let valid = match operator {
        FilterOperator::Contains | FilterOperator::StartsWith | FilterOperator::EndsWith => {
            kind == ColumnType::Text
        }
        FilterOperator::Lt | FilterOperator::Lte | FilterOperator::Gt | FilterOperator::Gte => {
            matches!(
                kind,
                ColumnType::SignedInteger
                    | ColumnType::UnsignedInteger
                    | ColumnType::Float
                    | ColumnType::Decimal { .. }
                    | ColumnType::Text
                    | ColumnType::Temporal
            )
        }
        FilterOperator::Eq | FilterOperator::NotEq => kind != ColumnType::Unsupported,
        FilterOperator::IsNull | FilterOperator::IsNotNull => true,
    };
    if valid {
        Ok(())
    } else {
        invalid("Filter operator is incompatible with the column type")
    }
}

fn bind_value(column_type: ColumnType, value: &SessionScalar) -> Result<BoundValue, AppError> {
    match (column_type, value) {
        (ColumnType::Boolean, SessionScalar::Boolean(value)) => Ok(BoundValue::Bool(*value)),
        (ColumnType::SignedInteger, SessionScalar::Integer(value)) => value
            .parse::<i64>()
            .map(BoundValue::SignedInteger)
            .map_err(|_| argument_error("Integer value is outside the supported signed range")),
        (ColumnType::UnsignedInteger, SessionScalar::Integer(value)) => value
            .parse::<u64>()
            .map(BoundValue::UnsignedInteger)
            .map_err(|_| argument_error("Integer value is outside the supported unsigned range")),
        (ColumnType::Float, SessionScalar::Integer(value)) => {
            if value.starts_with('-') {
                value
                    .parse::<i64>()
                    .map(BoundValue::SignedInteger)
                    .map_err(|_| {
                        argument_error("Integer value is outside the supported signed range")
                    })
            } else {
                value
                    .parse::<u64>()
                    .map(BoundValue::UnsignedInteger)
                    .map_err(|_| {
                        argument_error("Integer value is outside the supported unsigned range")
                    })
            }
        }
        (ColumnType::Float, SessionScalar::Number(value)) if value.is_finite() => {
            Ok(BoundValue::Float(*value))
        }
        (ColumnType::Decimal { precision, scale }, SessionScalar::Decimal(value)) => {
            validate_decimal(value, precision, scale)?;
            Ok(BoundValue::Decimal(value.clone()))
        }
        (ColumnType::Decimal { precision, scale }, SessionScalar::Integer(value)) => {
            validate_integer_scalar(value)?;
            validate_decimal(value, precision, scale)?;
            Ok(BoundValue::Decimal(value.clone()))
        }
        (ColumnType::Text | ColumnType::Temporal, SessionScalar::String(value)) => {
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
        .ok_or_else(|| argument_error("Filter query references an unknown column"))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColumnType {
    Boolean,
    SignedInteger,
    UnsignedInteger,
    Float,
    Decimal { precision: u8, scale: u8 },
    Text,
    Temporal,
    Unsupported,
}

impl ColumnType {
    fn parse(logical_type: &str) -> Self {
        match logical_type {
            "BOOLEAN" => Self::Boolean,
            "STRING" | "UTF8" | "VARCHAR" | "CHAR" => Self::Text,
            "DATE" | "TIME_MILLIS" | "TIME_MICROS" | "TIME_NANOS" | "TIMESTAMP_MILLIS"
            | "TIMESTAMP_MICROS" | "TIMESTAMP_NANOS" | "INT96" => Self::Temporal,
            "INT8" | "INT16" | "INT32" | "INT64" => Self::SignedInteger,
            "UINT8" | "UINT16" | "UINT32" | "UINT64" => Self::UnsignedInteger,
            "FLOAT" | "DOUBLE" => Self::Float,
            _ => parse_decimal_type(logical_type)
                .or_else(|| parse_integer_type(logical_type))
                .or_else(|| parse_time_type(logical_type))
                .unwrap_or(Self::Unsupported),
        }
    }
}

fn parse_decimal_type(logical_type: &str) -> Option<ColumnType> {
    let values = logical_type.strip_prefix("DECIMAL(")?.strip_suffix(')')?;
    let (precision, scale) = values.split_once(',')?;
    let precision = precision.parse::<u8>().ok()?;
    let scale = scale.parse::<u8>().ok()?;
    (precision > 0 && precision <= 38 && scale <= precision)
        .then_some(ColumnType::Decimal { precision, scale })
}

fn parse_integer_type(logical_type: &str) -> Option<ColumnType> {
    let values = logical_type
        .strip_prefix("INTEGER { BIT_WIDTH: ")?
        .strip_suffix(" }")?;
    let (bit_width, signed) = values.split_once(", IS_SIGNED: ")?;
    let bit_width = bit_width.parse::<u8>().ok()?;
    if !matches!(bit_width, 8 | 16 | 32 | 64) {
        return None;
    }
    match signed {
        "TRUE" => Some(ColumnType::SignedInteger),
        "FALSE" => Some(ColumnType::UnsignedInteger),
        _ => None,
    }
}

fn parse_time_type(logical_type: &str) -> Option<ColumnType> {
    let values = logical_type
        .strip_prefix("TIME { IS_ADJUSTED_TO_U_T_C: ")?
        .strip_suffix(" }")?;
    let (adjusted, unit) = values.split_once(", UNIT: ")?;
    if matches!(adjusted, "TRUE" | "FALSE") && matches!(unit, "MILLIS" | "MICROS" | "NANOS") {
        Some(ColumnType::Temporal)
    } else {
        None
    }
}

fn validate_decimal(value: &str, precision: u8, scale: u8) -> Result<(), AppError> {
    if !is_canonical_decimal(value) {
        return invalid("Decimal value must use canonical decimal syntax");
    }
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let (integer, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, ""), |(integer, fraction)| (integer, fraction));
    let integer_digits = if integer == "0" { 0 } else { integer.len() };
    let fraction_digits = fraction.len();
    if integer_digits > usize::from(precision - scale)
        || fraction_digits > usize::from(scale)
        || integer_digits + fraction_digits > usize::from(precision)
    {
        return invalid("Decimal value exceeds the column precision or scale");
    }
    Ok(())
}

fn validate_integer_scalar(value: &str) -> Result<(), AppError> {
    let valid = if value.starts_with('-') {
        value.parse::<i64>().is_ok()
    } else {
        value.parse::<u64>().is_ok()
    };
    if valid {
        Ok(())
    } else {
        invalid("Integer value is outside the supported i64/u64 range")
    }
}

fn invalid<T>(message: &str) -> Result<T, AppError> {
    Err(argument_error(message))
}
fn argument_error(message: &str) -> AppError {
    AppError::InvalidArgument(message.into())
}

#[cfg(test)]
#[path = "filters/tests.rs"]
mod tests;

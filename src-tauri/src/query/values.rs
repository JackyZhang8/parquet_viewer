use std::collections::BTreeMap;
use std::fmt::Write;

use duckdb::arrow::array::{Array, BinaryArray, FixedSizeBinaryArray, LargeBinaryArray};
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::util::display::array_value_to_string;
#[cfg(test)]
use duckdb::types::Value;

use crate::models::CellValue;

#[cfg(test)]
pub(super) fn cell_from_value(value: Value) -> CellValue {
    match value {
        Value::Null => CellValue::Null,
        Value::Boolean(value) => CellValue::Bool(value),
        Value::TinyInt(value) => CellValue::Signed(i64::from(value)),
        Value::SmallInt(value) => CellValue::Signed(i64::from(value)),
        Value::Int(value) => CellValue::Signed(i64::from(value)),
        Value::BigInt(value) => CellValue::Signed(value),
        Value::HugeInt(value) => CellValue::String(value.to_string()),
        Value::UTinyInt(value) => CellValue::Unsigned(u64::from(value)),
        Value::USmallInt(value) => CellValue::Unsigned(u64::from(value)),
        Value::UInt(value) => CellValue::Unsigned(u64::from(value)),
        Value::UBigInt(value) => CellValue::Unsigned(value),
        Value::Float(value) => CellValue::Number(f64::from(value)),
        Value::Double(value) => CellValue::Number(value),
        Value::Decimal(value) => CellValue::String(value.to_string()),
        Value::Timestamp(unit, value) => CellValue::String(format!("timestamp:{unit:?}:{value}")),
        Value::Text(value) => CellValue::String(value),
        Value::Blob(value) => blob_cell(&value),
        Value::Date32(value) => CellValue::String(format!("date-days:{value}")),
        Value::Time64(unit, value) => CellValue::String(format!("time:{unit:?}:{value}")),
        Value::Interval {
            months,
            days,
            nanos,
        } => CellValue::String(format!("interval:{months}:{days}:{nanos}")),
        Value::List(values) | Value::Array(values) => {
            CellValue::Array(values.into_iter().map(cell_from_value).collect())
        }
        Value::Enum(value) => CellValue::String(value),
        Value::Struct(values) => CellValue::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), cell_from_value(value.clone())))
                .collect(),
        ),
        Value::Map(values) => CellValue::Array(
            values
                .iter()
                .map(|(key, value)| {
                    let mut entry = BTreeMap::new();
                    entry.insert("key".into(), cell_from_value(key.clone()));
                    entry.insert("value".into(), cell_from_value(value.clone()));
                    CellValue::Object(entry)
                })
                .collect(),
        ),
        Value::Union(value) => cell_from_value(*value),
    }
}

pub(super) fn cell_from_array(array: &dyn Array, row: usize) -> CellValue {
    if array.is_null(row) {
        return CellValue::Null;
    }
    let text = || array_value_to_string(array, row).unwrap_or_else(|_| "<unsupported>".into());
    match array.data_type() {
        DataType::Boolean => text()
            .parse()
            .map(CellValue::Bool)
            .unwrap_or_else(|_| CellValue::String(text())),
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => text()
            .parse()
            .map(CellValue::Signed)
            .unwrap_or_else(|_| CellValue::String(text())),
        DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64 => text()
            .parse()
            .map(CellValue::Unsigned)
            .unwrap_or_else(|_| CellValue::String(text())),
        DataType::Float16 | DataType::Float32 | DataType::Float64 => match text().parse::<f64>() {
            Ok(value) if value.is_finite() => CellValue::Number(value),
            _ => CellValue::String(text()),
        },
        DataType::Binary => blob_cell(
            array
                .as_any()
                .downcast_ref::<BinaryArray>()
                .map(|values| values.value(row))
                .unwrap_or_default(),
        ),
        DataType::LargeBinary => blob_cell(
            array
                .as_any()
                .downcast_ref::<LargeBinaryArray>()
                .map(|values| values.value(row))
                .unwrap_or_default(),
        ),
        DataType::FixedSizeBinary(_) => blob_cell(
            array
                .as_any()
                .downcast_ref::<FixedSizeBinaryArray>()
                .map(|values| values.value(row))
                .unwrap_or_default(),
        ),
        _ => CellValue::String(text()),
    }
}

fn blob_cell(bytes: &[u8]) -> CellValue {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    let mut object = BTreeMap::new();
    object.insert("encoding".into(), CellValue::String("hex".into()));
    object.insert("value".into(), CellValue::String(hex));
    CellValue::Object(object)
}

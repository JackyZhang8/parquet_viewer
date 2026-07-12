use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use duckdb::arrow::array::{
    Array, BinaryArray, FixedSizeBinaryArray, FixedSizeListArray, LargeBinaryArray, LargeListArray,
    LargeStringArray, ListArray, MapArray, StringArray, StructArray,
};
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::util::display::array_value_to_string;
#[cfg(test)]
use duckdb::types::Value;

use crate::error::AppError;
use crate::models::CellValue;

pub(super) const MAX_CELL_ENCODED_BYTES: usize = 1024 * 1024;

pub(super) struct ConvertedCell {
    pub value: CellValue,
    pub encoded_bytes: usize,
}

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
        Value::Blob(value) => blob_cell(&value).unwrap().value,
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

pub(super) fn cell_from_array(array: &dyn Array, row: usize) -> Result<ConvertedCell, AppError> {
    if array.is_null(row) {
        return converted(CellValue::Null, 4);
    }
    let text = || array_value_to_string(array, row).unwrap_or_else(|_| "<unsupported>".into());
    let value = match array.data_type() {
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
        DataType::Utf8 => {
            let value = array
                .as_any()
                .downcast_ref::<StringArray>()
                .map(|values| values.value(row))
                .unwrap_or_default();
            if value.len() + 2 > MAX_CELL_ENCODED_BYTES {
                return Err(resource_exhausted());
            }
            return converted(CellValue::String(value.to_owned()), value.len() + 2);
        }
        DataType::LargeUtf8 => {
            let value = array
                .as_any()
                .downcast_ref::<LargeStringArray>()
                .map(|values| values.value(row))
                .unwrap_or_default();
            if value.len() + 2 > MAX_CELL_ENCODED_BYTES {
                return Err(resource_exhausted());
            }
            return converted(CellValue::String(value.to_owned()), value.len() + 2);
        }
        DataType::Binary => {
            return blob_cell(
                array
                    .as_any()
                    .downcast_ref::<BinaryArray>()
                    .map(|values| values.value(row))
                    .unwrap_or_default(),
            );
        }
        DataType::LargeBinary => {
            return blob_cell(
                array
                    .as_any()
                    .downcast_ref::<LargeBinaryArray>()
                    .map(|values| values.value(row))
                    .unwrap_or_default(),
            );
        }
        DataType::FixedSizeBinary(_) => {
            return blob_cell(
                array
                    .as_any()
                    .downcast_ref::<FixedSizeBinaryArray>()
                    .map(|values| values.value(row))
                    .unwrap_or_default(),
            );
        }
        DataType::List(_) => {
            let values = array
                .as_any()
                .downcast_ref::<ListArray>()
                .unwrap()
                .value(row);
            return array_cell(values.as_ref());
        }
        DataType::LargeList(_) => {
            let values = array
                .as_any()
                .downcast_ref::<LargeListArray>()
                .unwrap()
                .value(row);
            return array_cell(values.as_ref());
        }
        DataType::FixedSizeList(_, _) => {
            let values = array
                .as_any()
                .downcast_ref::<FixedSizeListArray>()
                .unwrap()
                .value(row);
            return array_cell(values.as_ref());
        }
        DataType::Struct(_) => {
            let values = array.as_any().downcast_ref::<StructArray>().unwrap();
            let mut object = BTreeMap::new();
            let mut size = 2;
            for (field, column) in values.fields().iter().zip(values.columns()) {
                let cell = cell_from_array(column.as_ref(), row)?;
                size = checked_add(size, field.name().len() + 3 + cell.encoded_bytes)?;
                object.insert(field.name().clone(), cell.value);
            }
            return converted(CellValue::Object(object), size);
        }
        DataType::Map(_, _) => {
            let entries = array
                .as_any()
                .downcast_ref::<MapArray>()
                .unwrap()
                .value(row);
            let mut result = Vec::with_capacity(entries.len());
            let mut size = 2;
            for index in 0..entries.len() {
                let key = cell_from_array(entries.column(0).as_ref(), index)?;
                let value = cell_from_array(entries.column(1).as_ref(), index)?;
                let mut entry = BTreeMap::new();
                entry.insert("key".into(), key.value);
                entry.insert("value".into(), value.value);
                size = checked_add(size, key.encoded_bytes + value.encoded_bytes + 20)?;
                result.push(CellValue::Object(entry));
            }
            return converted(CellValue::Array(result), size);
        }
        _ => CellValue::String(text()),
    };
    let size = match &value {
        CellValue::Null => 4,
        CellValue::Bool(_) => 5,
        CellValue::Number(_) | CellValue::Signed(_) | CellValue::Unsigned(_) => 32,
        CellValue::String(value) => value.len() + 2,
        CellValue::Array(_) | CellValue::Object(_) => unreachable!(),
    };
    converted(value, size)
}

fn array_cell(values: &dyn Array) -> Result<ConvertedCell, AppError> {
    let mut result = Vec::with_capacity(values.len());
    let mut size = 2;
    for index in 0..values.len() {
        let cell = cell_from_array(values, index)?;
        size = checked_add(size, cell.encoded_bytes + 1)?;
        result.push(cell.value);
    }
    converted(CellValue::Array(result), size)
}

fn blob_cell(bytes: &[u8]) -> Result<ConvertedCell, AppError> {
    let encoded_len = base64::encoded_len(bytes.len(), true).ok_or_else(resource_exhausted)?;
    if encoded_len + 40 > MAX_CELL_ENCODED_BYTES {
        return Err(resource_exhausted());
    }
    let encoded = STANDARD.encode(bytes);
    let mut object = BTreeMap::new();
    object.insert("encoding".into(), CellValue::String("base64".into()));
    object.insert("value".into(), CellValue::String(encoded));
    converted(CellValue::Object(object), encoded_len + 40)
}

fn converted(value: CellValue, encoded_bytes: usize) -> Result<ConvertedCell, AppError> {
    if encoded_bytes > MAX_CELL_ENCODED_BYTES {
        return Err(resource_exhausted());
    }
    Ok(ConvertedCell {
        value,
        encoded_bytes,
    })
}

fn checked_add(left: usize, right: usize) -> Result<usize, AppError> {
    let size = left.checked_add(right).ok_or_else(resource_exhausted)?;
    if size > MAX_CELL_ENCODED_BYTES {
        return Err(resource_exhausted());
    }
    Ok(size)
}

fn resource_exhausted() -> AppError {
    AppError::ResourceExhausted("A query value exceeds the configured memory limit".into())
}

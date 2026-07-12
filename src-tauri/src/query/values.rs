use std::collections::BTreeMap;
use std::io::{self, Write};

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
                size = object_entry_encoded_size(size, field.name(), &cell, !object.is_empty())?;
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
            return collect_map_cells((0..entries.len()).map(|index| {
                Ok((
                    cell_from_array(entries.column(0).as_ref(), index)?,
                    cell_from_array(entries.column(1).as_ref(), index)?,
                ))
            }));
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
    collect_array_cells((0..values.len()).map(|index| cell_from_array(values, index)))
}

fn collect_array_cells<I>(cells: I) -> Result<ConvertedCell, AppError>
where
    I: IntoIterator<Item = Result<ConvertedCell, AppError>>,
{
    let mut result = Vec::new();
    let mut size = 2;
    for cell in cells {
        let cell = cell?;
        size = checked_add(size, usize::from(!result.is_empty()))?;
        size = checked_add(size, cell.encoded_bytes)?;
        result.push(cell.value);
    }
    converted(CellValue::Array(result), size)
}

fn collect_map_cells<I>(entries: I) -> Result<ConvertedCell, AppError>
where
    I: IntoIterator<Item = Result<(ConvertedCell, ConvertedCell), AppError>>,
{
    let mut result = Vec::new();
    let mut size = 2;
    for entry in entries {
        let (key, value) = entry?;
        size = checked_add(size, usize::from(!result.is_empty()))?;
        size = checked_add(size, 17)?;
        size = checked_add(size, key.encoded_bytes)?;
        size = checked_add(size, value.encoded_bytes)?;
        let mut object = BTreeMap::new();
        object.insert("key".into(), key.value);
        object.insert("value".into(), value.value);
        result.push(CellValue::Object(object));
    }
    converted(CellValue::Array(result), size)
}

fn object_entry_encoded_size(
    current_size: usize,
    key: &str,
    cell: &ConvertedCell,
    has_entries: bool,
) -> Result<usize, AppError> {
    let key_bytes = json_encoded_len(&key, MAX_CELL_ENCODED_BYTES)?;
    let size = checked_add(current_size, usize::from(has_entries))?;
    let size = checked_add(size, key_bytes)?;
    let size = checked_add(size, 1)?;
    checked_add(size, cell.encoded_bytes)
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
    let _ = encoded_bytes;
    let encoded_bytes = json_encoded_len(&value, MAX_CELL_ENCODED_BYTES)?;
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

pub(super) fn json_encoded_len<T: serde::Serialize>(
    value: &T,
    limit: usize,
) -> Result<usize, AppError> {
    let mut writer = CountingWriter { count: 0, limit };
    serde_json::to_writer(&mut writer, value).map_err(|_| resource_exhausted())?;
    Ok(writer.count)
}

struct CountingWriter {
    count: usize,
    limit: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .count
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("encoded value too large"))?;
        if next > self.limit {
            return Err(io::Error::other("encoded value too large"));
        }
        self.count = next;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn resource_exhausted() -> AppError {
    AppError::ResourceExhausted("A query value exceeds the configured memory limit".into())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{
        ConvertedCell, MAX_CELL_ENCODED_BYTES, collect_array_cells, collect_map_cells,
        object_entry_encoded_size,
    };
    use crate::models::CellValue;

    fn null_cell() -> ConvertedCell {
        ConvertedCell {
            value: CellValue::Null,
            encoded_bytes: 4,
        }
    }

    #[test]
    fn huge_nested_array_stops_visiting_before_full_input_length() {
        let visited = Cell::new(0_usize);
        let cells = (0..1_000_000).map(|_| {
            visited.set(visited.get() + 1);
            Ok(null_cell())
        });

        assert!(collect_array_cells(cells).is_err());
        assert!(visited.get() > 200_000);
        assert!(visited.get() < 300_000);
    }

    #[test]
    fn huge_nested_map_stops_visiting_before_full_input_length() {
        let visited = Cell::new(0_usize);
        let entries = (0..1_000_000).map(|_| {
            visited.set(visited.get() + 1);
            Ok((null_cell(), null_cell()))
        });

        assert!(collect_map_cells(entries).is_err());
        assert!(visited.get() > 30_000);
        assert!(visited.get() < 100_000);
    }

    #[test]
    fn escaped_struct_keys_are_counted_as_encoded_json() {
        let key = "\"\\\n".repeat(MAX_CELL_ENCODED_BYTES / 4);
        assert!(key.len() < MAX_CELL_ENCODED_BYTES);
        assert!(object_entry_encoded_size(2, &key, &null_cell(), false).is_err());
    }
}

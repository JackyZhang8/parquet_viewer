use std::collections::BTreeMap;
use std::fmt;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::AppError;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

mod u64_decimal {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

/// JSON-compatible query cell. Integers outside JavaScript's safe range serialize as strings.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Signed(i64),
    Unsigned(u64),
    Array(Vec<CellValue>),
    Object(BTreeMap<String, CellValue>),
}

impl Serialize for CellValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value)
                if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER as f64 =>
            {
                serializer.collect_str(value)
            }
            Self::Number(value) => serializer.serialize_f64(*value),
            Self::String(value) => serializer.serialize_str(value),
            Self::Signed(value)
                if (-(MAX_SAFE_INTEGER as i64)..=MAX_SAFE_INTEGER as i64).contains(value) =>
            {
                serializer.serialize_i64(*value)
            }
            Self::Signed(value) => serializer.collect_str(value),
            Self::Unsigned(value) if *value <= MAX_SAFE_INTEGER => serializer.serialize_u64(*value),
            Self::Unsigned(value) => serializer.collect_str(value),
            Self::Array(values) => values.serialize(serializer),
            Self::Object(values) => values.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for CellValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct CellValueVisitor;

        impl<'de> Visitor<'de> for CellValueVisitor {
            type Value = CellValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON-compatible query cell")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(CellValue::Null)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(CellValue::Null)
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(CellValue::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(CellValue::Signed(value))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(CellValue::Unsigned(value))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(CellValue::Number(value))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(CellValue::String(value.into()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(CellValue::String(value))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(CellValue::Array(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry()? {
                    values.insert(key, value);
                }
                Ok(CellValue::Object(values))
            }
        }

        deserializer.deserialize_any(CellValueVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    pub logical_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub file_id: String,
    pub path: String,
    pub name: String,
    #[serde(with = "u64_decimal")]
    pub size_bytes: u64,
    #[serde(with = "u64_decimal")]
    pub row_count: u64,
    pub row_group_count: u32,
    pub columns: Vec<ColumnSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub file_id: String,
    pub sql: String,
    pub batch_size: u32,
    pub preview_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStarted {
    pub query_id: String,
    pub columns: Vec<ColumnSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryBatch {
    pub query_id: String,
    pub rows: Vec<Vec<CellValue>>,
    pub done: bool,
    pub truncated: bool,
    #[serde(with = "u64_decimal")]
    pub returned_rows: u64,
    #[serde(with = "u64_decimal")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExportSource {
    Sql { sql: String },
    Filter { query: super::FilterQueryRequest },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportInspectionRequest {
    pub file_id: String,
    pub source: ExportSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInspection {
    #[serde(with = "u64_decimal")]
    pub estimated_rows: u64,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub file_id: String,
    pub destination: String,
    pub overwrite: bool,
    pub source: ExportSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportStarted {
    pub export_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportStatus {
    Queued,
    Running,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub export_id: String,
    pub status: ExportStatus,
    #[serde(with = "u64_decimal")]
    pub rows_written: u64,
    pub error: Option<AppError>,
}

#[cfg(test)]
mod tests {
    use super::{CellValue, ColumnSchema, FileMetadata, QueryBatch, QueryRequest, QueryStarted};
    use serde_json::json;

    fn column() -> ColumnSchema {
        ColumnSchema {
            name: "user_id".into(),
            logical_type: "BIGINT".into(),
            nullable: true,
        }
    }

    #[test]
    fn column_schema_serializes_with_camel_case_fields() {
        assert_eq!(
            serde_json::to_value(column()).unwrap(),
            json!({ "name": "user_id", "logicalType": "BIGINT", "nullable": true })
        );
    }

    #[test]
    fn file_metadata_serializes_large_counters_as_decimal_strings() {
        let metadata = FileMetadata {
            file_id: "file-1".into(),
            path: "/tmp/users.parquet".into(),
            name: "users.parquet".into(),
            size_bytes: 4_294_967_296,
            row_count: 9_007,
            row_group_count: 3,
            columns: vec![column()],
        };

        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            json!({
                "fileId": "file-1",
                "path": "/tmp/users.parquet",
                "name": "users.parquet",
                "sizeBytes": "4294967296",
                "rowCount": "9007",
                "rowGroupCount": 3,
                "columns": [{ "name": "user_id", "logicalType": "BIGINT", "nullable": true }]
            })
        );
    }

    #[test]
    fn query_contracts_serialize_with_exact_public_shapes() {
        let request = QueryRequest {
            file_id: "file-1".into(),
            sql: "select * from parquet_file".into(),
            batch_size: 500,
            preview_limit: 10_000,
        };
        let started = QueryStarted {
            query_id: "query-1".into(),
            columns: vec![column()],
        };
        let batch = QueryBatch {
            query_id: "query-1".into(),
            rows: vec![vec![
                CellValue::Signed(7),
                CellValue::Null,
                CellValue::String("Ada".into()),
            ]],
            done: false,
            truncated: true,
            returned_rows: 1,
            elapsed_ms: 12,
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "fileId": "file-1",
                "sql": "select * from parquet_file",
                "batchSize": 500,
                "previewLimit": 10_000
            })
        );
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            json!({
                "queryId": "query-1",
                "columns": [{ "name": "user_id", "logicalType": "BIGINT", "nullable": true }]
            })
        );
        assert_eq!(
            serde_json::to_value(batch).unwrap(),
            json!({
                "queryId": "query-1",
                "rows": [[7, null, "Ada"]],
                "done": false,
                "truncated": true,
                "returnedRows": "1",
                "elapsedMs": "12"
            })
        );

        let exact = json!({
            "queryId": "query-1", "rows": [], "done": true, "truncated": false,
            "returnedRows": "0", "elapsedMs": "1"
        });
        assert!(serde_json::from_value::<QueryBatch>(exact.clone()).is_ok());
        let mut missing = exact.clone();
        missing.as_object_mut().unwrap().remove("truncated");
        assert!(serde_json::from_value::<QueryBatch>(missing).is_err());
        let mut extra = exact;
        extra["debug"] = json!("secret");
        assert!(serde_json::from_value::<QueryBatch>(extra).is_err());
    }

    #[test]
    fn cell_values_preserve_integer_precision_at_the_javascript_boundary() {
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
        let cells = vec![
            CellValue::Signed(MAX_SAFE_INTEGER),
            CellValue::Signed(MAX_SAFE_INTEGER + 1),
            CellValue::Signed(i64::MAX),
            CellValue::Unsigned(u64::MAX),
            CellValue::Number(9_007_199_254_740_992.0),
        ];

        assert_eq!(
            serde_json::to_value(cells).unwrap(),
            json!([
                9_007_199_254_740_991_i64,
                "9007199254740992",
                "9223372036854775807",
                "18446744073709551615",
                "9007199254740992"
            ])
        );
    }
}

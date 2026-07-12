use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub size_bytes: u64,
    pub row_count: u64,
    pub row_group_count: u64,
    pub columns: Vec<ColumnSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub file_id: String,
    pub sql: String,
    pub batch_size: u32,
    pub preview_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStarted {
    pub query_id: String,
    pub columns: Vec<ColumnSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryBatch {
    pub query_id: String,
    pub rows: Vec<Vec<Value>>,
    pub done: bool,
    pub returned_rows: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub version: u32,
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: Option<String>,
}

/// Persisted tab state intentionally excludes transient query IDs and result rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub file_id: String,
    pub path: String,
    pub sql_draft: String,
    pub filters: Value,
    pub sorts: Value,
    pub view_state: Value,
}

#[cfg(test)]
mod tests {
    use super::{
        ColumnSchema, FileMetadata, QueryBatch, QueryRequest, QueryStarted, SessionSnapshot,
        SessionTab,
    };
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
    fn file_metadata_serializes_with_camel_case_fields_and_numbers() {
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
                "sizeBytes": 4_294_967_296_u64,
                "rowCount": 9_007,
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
            rows: vec![vec![json!(7), json!(null), json!("Ada")]],
            done: false,
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
                "returnedRows": 1,
                "elapsedMs": 12
            })
        );
    }

    #[test]
    fn session_snapshot_persists_order_and_view_state_but_not_results() {
        let snapshot = SessionSnapshot {
            version: 1,
            tabs: vec![SessionTab {
                id: "tab-1".into(),
                file_id: "file-1".into(),
                path: "/tmp/users.parquet".into(),
                sql_draft: "select * from parquet_file".into(),
                filters: json!([{ "column": "active", "operator": "eq", "value": true }]),
                sorts: json!([{ "column": "user_id", "direction": "asc" }]),
                view_state: json!({ "scrollTop": 240, "selectedColumn": null }),
            }],
            active_tab_id: Some("tab-1".into()),
        };

        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(
            value,
            json!({
                "version": 1,
                "tabs": [{
                    "id": "tab-1",
                    "fileId": "file-1",
                    "path": "/tmp/users.parquet",
                    "sqlDraft": "select * from parquet_file",
                    "filters": [{ "column": "active", "operator": "eq", "value": true }],
                    "sorts": [{ "column": "user_id", "direction": "asc" }],
                    "viewState": { "scrollTop": 240, "selectedColumn": null }
                }],
                "activeTabId": "tab-1"
            })
        );
        assert!(value.get("queryId").is_none());
        assert!(value.get("rows").is_none());
    }

    #[test]
    fn session_snapshot_allows_no_active_tab() {
        let snapshot = SessionSnapshot {
            version: 1,
            tabs: vec![],
            active_tab_id: None,
        };

        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            json!({ "version": 1, "tabs": [], "activeTabId": null })
        );
    }
}

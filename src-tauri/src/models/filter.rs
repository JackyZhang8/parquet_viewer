use serde::{Deserialize, Serialize};

use super::SessionScalar;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    StartsWith,
    EndsWith,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterCondition {
    pub column: String,
    pub operator: FilterOperator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<SessionScalar>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterQueryRequest {
    pub selected_columns: Vec<String>,
    pub filters: Vec<FilterCondition>,
    pub sorts: Vec<SortSpec>,
    pub preview_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterQueryStartRequest {
    pub file_id: String,
    pub query: FilterQueryRequest,
    pub batch_size: u32,
}

#[cfg(test)]
mod tests {
    use super::{FilterCondition, FilterQueryRequest, FilterQueryStartRequest, SortSpec};
    use serde_json::json;

    #[test]
    fn filter_request_rejects_each_omitted_required_collection() {
        let missing_selected = json!({
            "filters": [], "sorts": [], "previewLimit": 100
        });
        let missing_filters = json!({
            "selectedColumns": [], "sorts": [], "previewLimit": 100
        });
        let missing_sorts = json!({
            "selectedColumns": [], "filters": [], "previewLimit": 100
        });

        for value in [missing_selected, missing_filters, missing_sorts] {
            assert!(serde_json::from_value::<FilterQueryRequest>(value).is_err());
        }
    }

    #[test]
    fn public_filter_dtos_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<FilterQueryRequest>(json!({
                "selectedColumns": [], "filters": [], "sorts": [], "previewLimit": 100,
                "sql": "SELECT secret"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<FilterCondition>(json!({
                "column": "a", "operator": "isNull", "raw": "OR 1=1"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<SortSpec>(json!({
                "column": "a", "direction": "asc", "raw": "DESC; DROP TABLE"
            }))
            .is_err()
        );
    }

    #[test]
    fn filter_start_request_is_strict_and_camel_case() {
        let value = json!({
            "fileId": "file-1",
            "query": { "selectedColumns": [], "filters": [], "sorts": [], "previewLimit": 100 },
            "batchSize": 500
        });
        assert!(serde_json::from_value::<FilterQueryStartRequest>(value.clone()).is_ok());
        let mut unknown = value;
        unknown["sql"] = json!("SELECT secret");
        assert!(serde_json::from_value::<FilterQueryStartRequest>(unknown).is_err());
    }
}

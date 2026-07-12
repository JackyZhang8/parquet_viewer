use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshot {
    pub version: u32,
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: Option<String>,
}

/// Persisted tab state intentionally excludes transient query IDs and result rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTab {
    pub id: String,
    pub file_id: String,
    pub path: String,
    pub sql_draft: String,
    pub filters: Vec<SessionFilter>,
    pub sorts: Vec<SessionSort>,
    pub view_state: SessionViewState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFilter {
    pub column: String,
    pub operator: SessionFilterOperator,
    pub value: SessionScalar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionFilterOperator {
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

#[derive(Debug, Clone, PartialEq)]
pub enum SessionScalar {
    Null,
    Boolean(bool),
    Number(f64),
    Integer(String),
    String(String),
}

impl Serialize for SessionScalar {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let field_count = usize::from(!matches!(self, Self::Null)) + 1;
        let mut state = serializer.serialize_struct("SessionScalar", field_count)?;
        match self {
            Self::Null => state.serialize_field("type", "null")?,
            Self::Boolean(value) => {
                state.serialize_field("type", "boolean")?;
                state.serialize_field("value", value)?;
            }
            Self::Number(value) => {
                if !value.is_finite() || value.fract() == 0.0 {
                    return Err(serde::ser::Error::custom(
                        "session scalar numbers must be finite and non-integer",
                    ));
                }
                state.serialize_field("type", "number")?;
                state.serialize_field("value", value)?;
            }
            Self::Integer(value) => {
                if !is_canonical_integer(value) {
                    return Err(serde::ser::Error::custom(
                        "session scalar integer is not canonical or is out of range",
                    ));
                }
                state.serialize_field("type", "integer")?;
                state.serialize_field("value", value)?;
            }
            Self::String(value) => {
                state.serialize_field("type", "string")?;
                state.serialize_field("value", value)?;
            }
        }
        state.end()
    }
}

impl<'de> Deserialize<'de> for SessionScalar {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut object = value
            .as_object()
            .cloned()
            .ok_or_else(|| serde::de::Error::custom("session scalar must be an object"))?;
        let kind = object
            .remove("type")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| serde::de::Error::custom("session scalar requires a string type"))?;

        if kind == "null" {
            return if object.is_empty() {
                Ok(Self::Null)
            } else {
                Err(serde::de::Error::custom(
                    "null session scalar cannot contain other fields",
                ))
            };
        }

        let scalar_value = object
            .remove("value")
            .ok_or_else(|| serde::de::Error::custom("session scalar requires a value"))?;
        if !object.is_empty() {
            return Err(serde::de::Error::custom(
                "session scalar contains unknown fields",
            ));
        }

        match kind.as_str() {
            "boolean" => scalar_value
                .as_bool()
                .map(Self::Boolean)
                .ok_or_else(|| serde::de::Error::custom("boolean scalar requires a boolean value")),
            "number" => {
                let number = scalar_value.as_f64().ok_or_else(|| {
                    serde::de::Error::custom("number scalar requires a numeric value")
                })?;
                if number.is_finite() && number.fract() != 0.0 {
                    Ok(Self::Number(number))
                } else {
                    Err(serde::de::Error::custom(
                        "session scalar numbers must be finite and non-integer",
                    ))
                }
            }
            "integer" => {
                let integer = scalar_value.as_str().ok_or_else(|| {
                    serde::de::Error::custom("integer scalar requires a string value")
                })?;
                if is_canonical_integer(integer) {
                    Ok(Self::Integer(integer.into()))
                } else {
                    Err(serde::de::Error::custom(
                        "session scalar integer is not canonical or is out of range",
                    ))
                }
            }
            "string" => scalar_value
                .as_str()
                .map(|value| Self::String(value.into()))
                .ok_or_else(|| serde::de::Error::custom("string scalar requires a string value")),
            _ => Err(serde::de::Error::custom("unknown session scalar type")),
        }
    }
}

fn is_canonical_integer(value: &str) -> bool {
    if value == "0" {
        return true;
    }

    if let Some(digits) = value.strip_prefix('-') {
        return !digits.is_empty()
            && !digits.starts_with('0')
            && digits.bytes().all(|byte| byte.is_ascii_digit())
            && value.parse::<i64>().is_ok();
    }

    !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSort {
    pub column: String,
    pub direction: SessionSortDirection,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionSortDirection {
    Asc,
    Desc,
}

/// Numeric UI state uses fixed-width integers, keeping every value JavaScript-safe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionViewState {
    pub scroll_top: u32,
    pub scroll_left: u32,
    pub sidebar_width: u16,
    pub editor_height: u16,
}

#[cfg(test)]
mod tests {
    use super::{
        SessionFilter, SessionFilterOperator, SessionScalar, SessionSnapshot, SessionSort,
        SessionSortDirection, SessionTab, SessionViewState,
    };
    use serde_json::json;

    #[test]
    fn session_snapshot_persists_order_and_view_state_but_not_results() {
        let snapshot = SessionSnapshot {
            version: 1,
            tabs: vec![SessionTab {
                id: "tab-1".into(),
                file_id: "file-1".into(),
                path: "/tmp/users.parquet".into(),
                sql_draft: "select * from parquet_file".into(),
                filters: vec![SessionFilter {
                    column: "active".into(),
                    operator: SessionFilterOperator::Eq,
                    value: SessionScalar::Boolean(true),
                }],
                sorts: vec![SessionSort {
                    column: "user_id".into(),
                    direction: SessionSortDirection::Asc,
                }],
                view_state: SessionViewState {
                    scroll_top: 240,
                    scroll_left: 0,
                    sidebar_width: 320,
                    editor_height: 180,
                },
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
                    "filters": [{
                        "column": "active",
                        "operator": "eq",
                        "value": { "type": "boolean", "value": true }
                    }],
                    "sorts": [{ "column": "user_id", "direction": "asc" }],
                    "viewState": {
                        "scrollTop": 240,
                        "scrollLeft": 0,
                        "sidebarWidth": 320,
                        "editorHeight": 180
                    }
                }],
                "activeTabId": "tab-1"
            })
        );
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

    #[test]
    fn session_filters_reject_untyped_or_nested_values() {
        for value in [
            json!({ "queryId": "query-1", "rows": [[1, 2, 3]] }),
            json!([1, 2, 3]),
        ] {
            let filter = json!({ "column": "user_id", "operator": "eq", "value": value });
            assert!(serde_json::from_value::<SessionFilter>(filter).is_err());
        }
    }

    #[test]
    fn session_boundaries_reject_unknown_query_fields() {
        let snapshot = json!({
            "version": 1,
            "tabs": [],
            "activeTabId": null,
            "queryId": "query-1"
        });
        let tab_snapshot = json!({
            "version": 1,
            "tabs": [{
                "id": "tab-1",
                "fileId": "file-1",
                "path": "/tmp/users.parquet",
                "sqlDraft": "select 1",
                "filters": [],
                "sorts": [],
                "viewState": {
                    "scrollTop": 0,
                    "scrollLeft": 0,
                    "sidebarWidth": 320,
                    "editorHeight": 180
                },
                "rows": []
            }],
            "activeTabId": "tab-1"
        });
        let filter = json!({
            "column": "user_id",
            "operator": "eq",
            "value": { "type": "null" },
            "queryId": "query-1"
        });
        let sort = json!({ "column": "user_id", "direction": "asc", "rows": [] });
        let view = json!({
            "scrollTop": 0,
            "scrollLeft": 0,
            "sidebarWidth": 320,
            "editorHeight": 180,
            "queryId": "query-1"
        });

        assert!(serde_json::from_value::<SessionSnapshot>(snapshot).is_err());
        assert!(serde_json::from_value::<SessionSnapshot>(tab_snapshot).is_err());
        assert!(serde_json::from_value::<SessionFilter>(filter).is_err());
        assert!(serde_json::from_value::<SessionSort>(sort).is_err());
        assert!(serde_json::from_value::<SessionViewState>(view).is_err());
    }

    #[test]
    fn session_scalars_use_explicit_lossless_wire_tags() {
        let scalars = vec![
            SessionScalar::Null,
            SessionScalar::Boolean(true),
            SessionScalar::Number(3.5),
            SessionScalar::Integer("9007199254740991".into()),
            SessionScalar::Integer("9007199254740992".into()),
            SessionScalar::Integer(i64::MAX.to_string()),
            SessionScalar::Integer(u64::MAX.to_string()),
            SessionScalar::String("9223372036854775807".into()),
        ];

        assert_eq!(
            serde_json::to_value(scalars).unwrap(),
            json!([
                { "type": "null" },
                { "type": "boolean", "value": true },
                { "type": "number", "value": 3.5 },
                { "type": "integer", "value": "9007199254740991" },
                { "type": "integer", "value": "9007199254740992" },
                { "type": "integer", "value": "9223372036854775807" },
                { "type": "integer", "value": "18446744073709551615" },
                { "type": "string", "value": "9223372036854775807" }
            ])
        );
    }

    #[test]
    fn session_integer_scalar_rejects_noncanonical_or_out_of_range_values() {
        for invalid in [
            " 1",
            "1 ",
            "+1",
            "01",
            "-0",
            "1e3",
            "18446744073709551616",
            "-9223372036854775809",
        ] {
            let value = json!({ "type": "integer", "value": invalid });
            assert!(serde_json::from_value::<SessionScalar>(value).is_err());
        }
    }

    #[test]
    fn session_scalar_rejects_malformed_tagged_shapes() {
        for invalid in [
            json!({ "type": "null", "value": null }),
            json!({ "type": "boolean" }),
            json!({ "type": "number", "value": 42 }),
            json!({ "type": "integer", "value": 42 }),
            json!({ "type": "string", "value": "text", "rows": [] }),
            json!({ "type": "unknown", "value": "text" }),
        ] {
            assert!(
                serde_json::from_value::<SessionScalar>(invalid.clone()).is_err(),
                "accepted malformed scalar {invalid}"
            );
        }

        assert!(serde_json::to_value(SessionScalar::Number(42.0)).is_err());
    }
}

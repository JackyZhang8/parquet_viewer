use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    InvalidParquet(String),
    #[error("{0}")]
    StaleFile(String),
    #[error("{0}")]
    Sql(String),
    #[error("{message}")]
    SqlLocated {
        message: String,
        line: u64,
        column: u64,
    },
    #[error("{0}")]
    Cancelled(String),
    #[error("{0}")]
    ResourceExhausted(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::InvalidPath(_) => "INVALID_PATH",
            Self::PermissionDenied(_) => "PERMISSION_DENIED",
            Self::InvalidParquet(_) => "INVALID_PARQUET",
            Self::StaleFile(_) => "STALE_FILE",
            Self::Sql(_) | Self::SqlLocated { .. } => "SQL_ERROR",
            Self::Cancelled(_) => "CANCELLED",
            Self::ResourceExhausted(_) => "RESOURCE_EXHAUSTED",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::InvalidArgument(message)
            | Self::InvalidPath(message)
            | Self::PermissionDenied(message)
            | Self::InvalidParquet(message)
            | Self::StaleFile(message)
            | Self::Sql(message)
            | Self::Cancelled(message)
            | Self::ResourceExhausted(message) => message,
            Self::SqlLocated { message, .. } => message,
            Self::Internal(_) => "An internal error occurred",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            Self::SqlLocated { line, column, .. } => Some(format!("line {line} column {column}")),
            _ => None,
        }
    }

    pub(crate) fn sql_with_source(message: impl Into<String>, source: &str) -> Self {
        match sql_location_from_message(source) {
            Some((line, column)) => Self::SqlLocated {
                message: message.into(),
                line,
                column,
            },
            None => Self::Sql(message.into()),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 3)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", self.message())?;
        state.serialize_field("detail", &self.detail())?;
        state.end()
    }
}

fn number_after_label(text: &str, label: &str, from: usize) -> Option<(u64, usize)> {
    let label_at = text[from..].find(label)? + from;
    let mut at = label_at + label.len();
    let bytes = text.as_bytes();
    while at < bytes.len() && !bytes[at].is_ascii_digit() {
        if at > label_at + label.len() + 8 {
            return None;
        }
        at += 1
    }
    let start = at;
    while at < bytes.len() && bytes[at].is_ascii_digit() {
        at += 1
    }
    if start == at {
        return None;
    }
    Some((text[start..at].parse().ok()?, at))
}

pub(crate) fn sql_location_from_message(message: &str) -> Option<(u64, u64)> {
    let lower = message.to_ascii_lowercase();
    let mut search = 0;
    while let Some((line, after_line)) = number_after_label(&lower, "line", search) {
        if let Some((column, _)) = number_after_label(&lower, "column", after_line)
            && line > 0
            && column > 0
        {
            return Some((line, column));
        }
        search = after_line
    }

    let lines = message.lines().collect::<Vec<_>>();
    for (index, source_line) in lines.iter().enumerate() {
        let lower_line = source_line.to_ascii_lowercase();
        let trimmed_at = source_line.len() - source_line.trim_start().len();
        let trimmed = &lower_line[trimmed_at..];
        if !trimmed.starts_with("line ") {
            continue;
        }
        let colon = source_line.find(':')?;
        let line = source_line[trimmed_at + 5..colon]
            .trim()
            .parse::<u64>()
            .ok()?;
        let query_start = source_line[colon + 1..]
            .find(|character: char| !character.is_whitespace())?
            + colon
            + 1;
        let caret_line = lines.get(index + 1).or_else(|| lines.get(index + 2))?;
        let caret = caret_line.find('^')?;
        let column = caret.saturating_sub(query_start) as u64 + 1;
        if line > 0 && column > 0 {
            return Some((line, column));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{AppError, sql_location_from_message};
    use serde_json::json;

    #[test]
    fn invalid_parquet_serializes_to_stable_public_shape() {
        let error = AppError::InvalidParquet("bad footer".into());

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "INVALID_PARQUET",
                "message": "bad footer",
                "detail": null
            })
        );
    }

    #[test]
    fn every_error_variant_has_a_stable_code_and_null_detail() {
        let cases = [
            (
                AppError::InvalidArgument("message".into()),
                "INVALID_ARGUMENT",
            ),
            (AppError::InvalidPath("message".into()), "INVALID_PATH"),
            (
                AppError::PermissionDenied("message".into()),
                "PERMISSION_DENIED",
            ),
            (
                AppError::InvalidParquet("message".into()),
                "INVALID_PARQUET",
            ),
            (AppError::StaleFile("message".into()), "STALE_FILE"),
            (AppError::Sql("message".into()), "SQL_ERROR"),
            (AppError::Cancelled("message".into()), "CANCELLED"),
            (
                AppError::ResourceExhausted("message".into()),
                "RESOURCE_EXHAUSTED",
            ),
        ];

        for (error, code) in cases {
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                json!({ "code": code, "message": "message", "detail": null })
            );
        }
    }

    #[test]
    fn internal_error_redacts_private_context_from_the_wire() {
        let sensitive = "failed at /Users/alice/private.parquet: select secret from payroll";
        let error = AppError::Internal(sensitive.into());

        assert_eq!(error.to_string(), sensitive);
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "INTERNAL_ERROR",
                "message": "An internal error occurred",
                "detail": null
            })
        );
    }

    #[test]
    fn invalid_argument_has_a_stable_public_shape() {
        let error = AppError::InvalidArgument("Invalid filter value".into());

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "INVALID_ARGUMENT",
                "message": "Invalid filter value",
                "detail": null
            })
        );
    }

    #[test]
    fn located_sql_error_serializes_only_a_safe_location() {
        let error = AppError::SqlLocated {
            message: "The query has invalid SQL syntax".into(),
            line: 12,
            column: 7,
        };

        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(
            wire,
            json!({
                "code": "SQL_ERROR",
                "message": "The query has invalid SQL syntax",
                "detail": "line 12 column 7"
            })
        );
        assert!(!wire.to_string().contains("private.parquet"));
    }

    #[test]
    fn extracts_direct_and_duckdb_caret_locations_without_retaining_source_text() {
        assert_eq!(
            sql_location_from_message("parser error at Line: 3, Column: 9 near /secret"),
            Some((3, 9))
        );
        assert_eq!(
            sql_location_from_message(
                "Parser Error: bad\nLINE 2: SELECT secret FROM payroll\n                       ^\n/private.parquet"
            ),
            Some((2, 16))
        );
        assert_eq!(
            sql_location_from_message("Binder Error: missing column"),
            None
        );
    }
}

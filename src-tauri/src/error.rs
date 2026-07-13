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
        summary: String,
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
            Self::SqlLocated {
                summary,
                line,
                column,
                ..
            } => Some(if summary.is_empty() {
                format!("line {line} column {column}")
            } else {
                format!("{summary}\nline {line} column {column}")
            }),
            _ => None,
        }
    }

    pub(crate) fn sql_with_source(message: impl Into<String>, source: &str) -> Self {
        match sql_location_from_message(source) {
            Some((line, column)) => Self::SqlLocated {
                message: message.into(),
                summary: sanitize_sql_error_summary(source),
                line,
                column,
            },
            None => Self::Sql(message.into()),
        }
    }
}

const MAX_SQL_SUMMARY_CHARS: usize = 2_000;

fn query_echo_or_caret(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    let line_echo = lower
        .strip_prefix("line ")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(number, _)| {
            !number.is_empty() && number.chars().all(|char| char.is_ascii_digit())
        });
    line_echo
        || (!trimmed.is_empty()
            && trimmed
                .chars()
                .all(|char| matches!(char, '^' | '~' | '|' | '-' | ' ')))
}

fn redact_quoted_values(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let chars = line.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let quote = chars[index];
        if quote != '\'' && quote != '"' {
            output.push(quote);
            index += 1;
            continue;
        }
        output.push_str(if quote == '\'' {
            "[literal]"
        } else {
            "[identifier]"
        });
        index += 1;
        while index < chars.len() {
            if chars[index] == quote && chars.get(index + 1) == Some(&quote) {
                index += 2;
            } else if chars[index] == quote {
                index += 1;
                break;
            } else {
                index += 1;
            }
        }
    }
    output
}

fn redact_absolute_paths(line: &str) -> String {
    let chars = line.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(line.len());
    let mut index = 0;
    while index < chars.len() {
        let boundary = index == 0
            || chars[index - 1].is_whitespace()
            || matches!(chars[index - 1], '(' | '[' | '{' | ':' | '=');
        let unix = boundary && chars[index] == '/';
        let unc = boundary && chars[index] == '\\' && chars.get(index + 1) == Some(&'\\');
        let windows = boundary
            && chars
                .get(index)
                .is_some_and(|char| char.is_ascii_alphabetic())
            && chars.get(index + 1) == Some(&':')
            && chars
                .get(index + 2)
                .is_some_and(|char| matches!(char, '/' | '\\'));
        if unix || windows || unc {
            output.push_str("[path]");
            index += if windows {
                3
            } else if unc {
                2
            } else {
                1
            };
            while index < chars.len()
                && !chars[index].is_whitespace()
                && !matches!(chars[index], ',' | ';' | ')' | ']' | '}')
            {
                index += 1;
            }
        } else {
            output.push(chars[index]);
            index += 1;
        }
    }
    output
}

fn sanitize_sql_error_summary(source: &str) -> String {
    let mut safe_lines = Vec::new();
    for raw in source.lines() {
        if query_echo_or_caret(raw) || raw.trim().is_empty() {
            continue;
        }
        let mut line = raw
            .chars()
            .map(|char| if char.is_control() { ' ' } else { char })
            .collect::<String>();
        if line.to_ascii_lowercase().starts_with("sql parser error:") {
            line.replace_range(.."sql parser error:".len(), "Parser Error:");
        }
        let lower = line.to_ascii_lowercase();
        if let Some(location) = lower.find(" at line") {
            line.truncate(location);
        }
        line = redact_absolute_paths(&redact_quoted_values(&line));
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            safe_lines.push(collapsed);
        }
    }
    safe_lines
        .join("\n")
        .chars()
        .take(MAX_SQL_SUMMARY_CHARS)
        .collect()
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
    use super::{AppError, MAX_SQL_SUMMARY_CHARS, sql_location_from_message};
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
    fn located_sql_error_serializes_a_useful_summary_without_sensitive_source() {
        let error = AppError::sql_with_source(
            "The query could not be prepared or executed",
            "Binder Error: Could not convert string 'super-secret' from /Users/alice/private.parquet\nCandidate bindings: \"safe_col\"\nWindows source C:\\Users\\alice\\secret.parquet, \\\\server\\share\\secret.parquet, //server/share/other.parquet and /proc/self/fd/9\nLINE 12: SELECT 'super-secret' FROM read_parquet('/dev/fd/42')\n                         ^\ninternal temp /tmp/parquet-viewer/query-1\u{7}",
        );

        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["code"], "SQL_ERROR");
        assert_eq!(
            wire["message"],
            "The query could not be prepared or executed"
        );
        let detail = wire["detail"].as_str().unwrap();
        assert!(detail.contains("Binder Error:"));
        assert!(detail.contains("Candidate bindings:"));
        assert!(
            detail
                .lines()
                .last()
                .is_some_and(|line| line.starts_with("line 12 column "))
        );
        for sensitive in [
            "super-secret",
            "private.parquet",
            "/Users/",
            "C:\\Users",
            "\\\\server\\share",
            "//server/share",
            "/proc/self/fd",
            "SELECT",
            "/dev/fd",
            "/tmp/",
            "^",
            "\u{7}",
        ] {
            assert!(
                !detail.contains(sensitive),
                "detail leaked {sensitive}: {detail}"
            );
        }
        assert!(detail.chars().count() <= 2_100);

        let long = AppError::sql_with_source(
            "The query has invalid SQL syntax",
            &format!("Parser Error: {} at Line: 1, Column: 1", "x".repeat(4_000)),
        );
        let long_detail = serde_json::to_value(long).unwrap()["detail"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(long_detail.chars().count() <= MAX_SQL_SUMMARY_CHARS + 32);
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

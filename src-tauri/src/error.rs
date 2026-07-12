use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
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
            Self::InvalidPath(_) => "INVALID_PATH",
            Self::PermissionDenied(_) => "PERMISSION_DENIED",
            Self::InvalidParquet(_) => "INVALID_PARQUET",
            Self::StaleFile(_) => "STALE_FILE",
            Self::Sql(_) => "SQL_ERROR",
            Self::Cancelled(_) => "CANCELLED",
            Self::ResourceExhausted(_) => "RESOURCE_EXHAUSTED",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::InvalidPath(message)
            | Self::PermissionDenied(message)
            | Self::InvalidParquet(message)
            | Self::StaleFile(message)
            | Self::Sql(message)
            | Self::Cancelled(message)
            | Self::ResourceExhausted(message) => message,
            Self::Internal(_) => "An internal error occurred",
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
        state.serialize_field("detail", &Option::<String>::None)?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;
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
}

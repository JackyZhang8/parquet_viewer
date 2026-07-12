use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::Mutex;
use parquet::basic::{LogicalType, TimeUnit, Type as PhysicalType};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::schema::types::Type as SchemaType;
use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{ColumnSchema, FileMetadata};

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    canonical_path: PathBuf,
    size: u64,
    modified: SystemTime,
}

#[derive(Debug, Clone)]
struct RegistryEntry {
    metadata: FileMetadata,
    fingerprint: FileFingerprint,
}

#[derive(Default)]
struct RegistryInner {
    by_id: HashMap<String, RegistryEntry>,
    by_path: HashMap<PathBuf, String>,
}

#[derive(Clone, Default)]
pub struct FileRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

struct LoadedFile {
    metadata: FileMetadata,
    fingerprint: FileFingerprint,
}

impl FileRegistry {
    pub fn open_paths(&self, paths: Vec<PathBuf>) -> Vec<Result<FileMetadata, AppError>> {
        paths.into_iter().map(|path| self.open_path(path)).collect()
    }

    fn open_path(&self, path: PathBuf) -> Result<FileMetadata, AppError> {
        let canonical_path = canonical_file_path(&path)?;
        if let Some(metadata) = self.metadata_for_path(&canonical_path) {
            return Ok(metadata);
        }

        let file_id = Uuid::new_v4().to_string();
        let loaded = load_file(&canonical_path, file_id.clone())?;

        let mut inner = self.inner.lock();
        if let Some(existing_id) = inner.by_path.get(&canonical_path) {
            return inner
                .by_id
                .get(existing_id)
                .map(|entry| entry.metadata.clone())
                .ok_or_else(|| AppError::Internal("registry indexes are inconsistent".into()));
        }
        inner.by_path.insert(canonical_path, file_id.clone());
        inner.by_id.insert(
            file_id,
            RegistryEntry {
                metadata: loaded.metadata.clone(),
                fingerprint: loaded.fingerprint,
            },
        );
        Ok(loaded.metadata)
    }

    fn metadata_for_path(&self, path: &Path) -> Option<FileMetadata> {
        let inner = self.inner.lock();
        inner
            .by_path
            .get(path)
            .and_then(|id| inner.by_id.get(id))
            .map(|entry| entry.metadata.clone())
    }

    pub fn get(&self, file_id: &str) -> Option<FileMetadata> {
        self.inner
            .lock()
            .by_id
            .get(file_id)
            .map(|entry| entry.metadata.clone())
    }

    pub fn reload(&self, file_id: &str) -> Result<FileMetadata, AppError> {
        let path = self
            .inner
            .lock()
            .by_id
            .get(file_id)
            .map(|entry| entry.fingerprint.canonical_path.clone())
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        let loaded = load_file(&path, file_id.to_owned())?;

        let mut inner = self.inner.lock();
        let entry = inner
            .by_id
            .get_mut(file_id)
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        entry.metadata = loaded.metadata.clone();
        entry.fingerprint = loaded.fingerprint;
        Ok(loaded.metadata)
    }

    pub fn remove(&self, file_id: &str) -> Result<(), AppError> {
        let mut inner = self.inner.lock();
        let entry = inner
            .by_id
            .remove(file_id)
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        inner.by_path.remove(&entry.fingerprint.canonical_path);
        Ok(())
    }

    pub fn is_stale(&self, file_id: &str) -> Result<bool, AppError> {
        let registered = self
            .inner
            .lock()
            .by_id
            .get(file_id)
            .map(|entry| entry.fingerprint.clone())
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        Ok(fingerprint(&registered.canonical_path)? != registered)
    }
}

#[derive(Default)]
pub struct AppState {
    pub files: FileRegistry,
}

#[tauri::command]
pub async fn open_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Result<FileMetadata, AppError>>, AppError> {
    let paths = paths.into_iter().map(PathBuf::from).collect();
    let registry = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || registry.open_paths(paths))
        .await
        .map_err(|error| AppError::Internal(format!("open files task failed: {error}")))
}

#[tauri::command]
pub async fn reload_file(
    file_id: String,
    state: State<'_, AppState>,
) -> Result<FileMetadata, AppError> {
    let registry = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || registry.reload(&file_id))
        .await
        .map_err(|error| AppError::Internal(format!("reload file task failed: {error}")))?
}

#[tauri::command]
pub async fn close_file(file_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.files.remove(&file_id)
}

pub fn read_metadata(path: &Path, file_id: String) -> Result<FileMetadata, AppError> {
    let canonical_path = canonical_file_path(path)?;
    Ok(load_file(&canonical_path, file_id)?.metadata)
}

fn load_file(canonical_path: &Path, file_id: String) -> Result<LoadedFile, AppError> {
    let fingerprint = fingerprint(canonical_path)?;
    let file = File::open(canonical_path).map_err(|error| map_io_error(error, canonical_path))?;
    // SerializedFileReader construction parses the footer metadata. No row-group, page,
    // column, or record reader is created by this metadata-only path.
    let reader = SerializedFileReader::new(file)
        .map_err(|_| AppError::InvalidParquet("The file is not valid Parquet".into()))?;
    let parquet_metadata = reader.metadata();
    let file_metadata = parquet_metadata.file_metadata();
    let row_count = u64::try_from(file_metadata.num_rows())
        .map_err(|_| AppError::InvalidParquet("Parquet row count is invalid".into()))?;
    let row_group_count = u32::try_from(parquet_metadata.num_row_groups())
        .map_err(|_| AppError::ResourceExhausted("Too many Parquet row groups".into()))?;
    let columns = file_metadata
        .schema_descr()
        .root_schema()
        .get_fields()
        .iter()
        .map(|field| ColumnSchema {
            name: field.name().to_owned(),
            logical_type: display_type(field),
            nullable: field.is_optional(),
        })
        .collect();
    let name = canonical_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_path.to_string_lossy().into_owned());

    Ok(LoadedFile {
        metadata: FileMetadata {
            file_id,
            path: canonical_path.to_string_lossy().into_owned(),
            name,
            size_bytes: fingerprint.size,
            row_count,
            row_group_count,
            columns,
        },
        fingerprint,
    })
}

fn canonical_file_path(path: &Path) -> Result<PathBuf, AppError> {
    let canonical = fs::canonicalize(path).map_err(|error| map_io_error(error, path))?;
    let metadata = fs::metadata(&canonical).map_err(|error| map_io_error(error, &canonical))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath("Path is not a file".into()));
    }
    Ok(canonical)
}

fn fingerprint(canonical_path: &Path) -> Result<FileFingerprint, AppError> {
    let metadata =
        fs::metadata(canonical_path).map_err(|error| map_io_error(error, canonical_path))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath("Path is not a file".into()));
    }
    let modified = metadata
        .modified()
        .map_err(|error| map_io_error(error, canonical_path))?;
    Ok(FileFingerprint {
        canonical_path: canonical_path.to_owned(),
        size: metadata.len(),
        modified,
    })
}

fn map_io_error(error: io::Error, _path: &Path) -> AppError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => AppError::PermissionDenied("Permission denied".into()),
        io::ErrorKind::NotFound => AppError::InvalidPath("File not found".into()),
        _ => AppError::InvalidPath("Unable to access file".into()),
    }
}

fn display_type(field: &SchemaType) -> String {
    match field.get_basic_info().logical_type_ref() {
        Some(LogicalType::String) => "STRING".into(),
        Some(LogicalType::Date) => "DATE".into(),
        Some(LogicalType::Timestamp { unit, .. }) => match unit {
            TimeUnit::MILLIS => "TIMESTAMP_MILLIS".into(),
            TimeUnit::MICROS => "TIMESTAMP_MICROS".into(),
            TimeUnit::NANOS => "TIMESTAMP_NANOS".into(),
        },
        Some(LogicalType::Decimal { scale, precision }) => {
            format!("DECIMAL({precision},{scale})")
        }
        Some(logical) => format!("{logical:?}").to_uppercase(),
        None if field.is_primitive() => match field.get_physical_type() {
            PhysicalType::BOOLEAN => "BOOLEAN".into(),
            PhysicalType::INT32 => "INT32".into(),
            PhysicalType::INT64 => "INT64".into(),
            PhysicalType::INT96 => "INT96".into(),
            PhysicalType::FLOAT => "FLOAT".into(),
            PhysicalType::DOUBLE => "DOUBLE".into(),
            PhysicalType::BYTE_ARRAY => "BINARY".into(),
            PhysicalType::FIXED_LEN_BYTE_ARRAY => "FIXED_BINARY".into(),
        },
        None => "STRUCT".into(),
    }
}

#[cfg(test)]
mod command_tests {
    use tauri::Manager;

    use super::{AppState, close_file};
    use crate::error::AppError;

    #[test]
    fn close_file_command_is_awaitable_and_keeps_registry_error_mapping() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let result = tauri::async_runtime::block_on(close_file(
            "missing-file-id".into(),
            app.state::<AppState>(),
        ));

        assert!(matches!(result, Err(AppError::InvalidPath(_))));
    }
}

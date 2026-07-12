use std::collections::HashMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Take};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use parking_lot::Mutex;
use parquet::basic::{LogicalType, TimeUnit, Type as PhysicalType};
use parquet::errors::{ParquetError, Result as ParquetResult};
use parquet::file::reader::{ChunkReader, FileReader, Length, SerializedFileReader};
use parquet::schema::types::Type as SchemaType;
use tauri::State;
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

use crate::AppState;
use crate::error::AppError;
use crate::models::{ColumnSchema, FileMetadata};

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    canonical_path: PathBuf,
    size: u64,
    modified: SystemTime,
    identity: FileIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows {
        volume_serial_number: Option<u32>,
        file_index: Option<u64>,
    },
    #[cfg(not(any(unix, windows)))]
    Unavailable,
}

const MAX_FOOTER_METADATA_BYTES: u64 = 64 * 1024 * 1024;

struct MetadataChunkReader {
    file: File,
    file_size: u64,
    max_metadata_bytes: u64,
    cap_exceeded: Arc<AtomicBool>,
}

impl MetadataChunkReader {
    fn new(file: File, file_size: u64) -> Self {
        Self::with_size_and_cap(file, file_size, MAX_FOOTER_METADATA_BYTES)
    }

    #[cfg(test)]
    fn with_cap(file: File, max_metadata_bytes: u64) -> Self {
        let file_size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        Self::with_size_and_cap(file, file_size, max_metadata_bytes)
    }

    fn with_size_and_cap(file: File, file_size: u64, max_metadata_bytes: u64) -> Self {
        Self {
            file,
            file_size,
            max_metadata_bytes,
            cap_exceeded: Arc::new(AtomicBool::new(false)),
        }
    }

    #[cfg(test)]
    fn cap_exceeded(&self) -> bool {
        self.cap_exceeded.load(Ordering::Relaxed)
    }

    fn reject_over_cap(&self) -> ParquetError {
        self.cap_exceeded.store(true, Ordering::Relaxed);
        ParquetError::General("Parquet metadata read exceeds configured limit".into())
    }
}

impl Length for MetadataChunkReader {
    fn len(&self) -> u64 {
        self.file_size
    }
}

impl ChunkReader for MetadataChunkReader {
    type T = Take<BufReader<File>>;

    fn get_read(&self, start: u64) -> ParquetResult<Self::T> {
        if start > self.file_size {
            return Err(ParquetError::General(
                "Invalid Parquet metadata offset".into(),
            ));
        }
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(start))?;
        let available = self.file_size - start;
        let limit = available.min(self.max_metadata_bytes.saturating_add(8));
        Ok(BufReader::new(file).take(limit))
    }

    fn get_bytes(&self, start: u64, length: usize) -> ParquetResult<bytes::Bytes> {
        let length_u64 = u64::try_from(length).map_err(|_| self.reject_over_cap())?;
        if length_u64 > self.max_metadata_bytes {
            return Err(self.reject_over_cap());
        }
        let end = start
            .checked_add(length_u64)
            .ok_or_else(|| ParquetError::General("Invalid Parquet metadata range".into()))?;
        if end > self.file_size {
            return Err(ParquetError::General(
                "Invalid Parquet metadata range".into(),
            ));
        }
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0_u8; length];
        file.read_exact(&mut buffer)?;
        Ok(buffer.into())
    }
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

pub(crate) struct QuerySource {
    pub(crate) canonical_path: PathBuf,
    pub(crate) duckdb_path: PathBuf,
    pub(crate) fingerprint_token: String,
    file: File,
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
        let file = open_query_guard(&registered.canonical_path)?;
        let current = fingerprint_from_open_file(&registered.canonical_path, &file)?;
        Ok(current != registered)
    }

    pub(crate) fn resolve_query_source(&self, file_id: &str) -> Result<QuerySource, AppError> {
        let registered = self
            .inner
            .lock()
            .by_id
            .get(file_id)
            .map(|entry| entry.fingerprint.clone())
            .ok_or_else(|| AppError::InvalidPath("Unknown file ID".into()))?;
        let file = open_query_guard(&registered.canonical_path)?;
        let current = fingerprint_from_open_file(&registered.canonical_path, &file)?;
        if current != registered {
            return Err(AppError::StaleFile(
                "The file changed after it was opened; reload it before querying".into(),
            ));
        }
        #[cfg(target_os = "macos")]
        let duckdb_path = PathBuf::from(format!("/dev/fd/{}", file.as_raw_fd()));
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let duckdb_path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
        let duckdb_path = registered.canonical_path.clone();
        duckdb_path
            .to_str()
            .ok_or_else(|| AppError::InvalidPath("Query source path is not valid UTF-8".into()))?;
        Ok(QuerySource {
            canonical_path: registered.canonical_path.clone(),
            duckdb_path,
            fingerprint_token: format!("{}:{:?}", registered.size, registered.modified),
            file,
            fingerprint: registered,
        })
    }

    pub(crate) fn revalidate_query_source(&self, source: &QuerySource) -> Result<(), AppError> {
        let current = fingerprint_from_open_file(&source.canonical_path, &source.file)?;
        if current != source.fingerprint {
            return Err(AppError::StaleFile(
                "The opened file changed before query execution".into(),
            ));
        }
        Ok(())
    }
}

fn open_query_guard(path: &Path) -> Result<File, AppError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    #[cfg(windows)]
    options.share_mode(windows_query_guard_share_mode());
    let file = options
        .open(path)
        .map_err(|error| map_io_error(error, path))?;
    let metadata = file.metadata().map_err(|error| map_io_error(error, path))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath("Path is not a file".into()));
    }
    Ok(file)
}

#[cfg(any(windows, test))]
const fn windows_query_guard_share_mode() -> u32 {
    // Windows FILE_SHARE_READ: other readers (including DuckDB) may reopen the
    // canonical path, while writers and delete/replace operations remain blocked.
    0x0000_0001
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
    state.queries.close_file(&file_id);
    state.files.remove(&file_id)
}

pub fn read_metadata(path: &Path, file_id: String) -> Result<FileMetadata, AppError> {
    let canonical_path = canonical_file_path(path)?;
    Ok(load_file(&canonical_path, file_id)?.metadata)
}

fn load_file(canonical_path: &Path, file_id: String) -> Result<LoadedFile, AppError> {
    let mut file = open_regular_file(canonical_path)?;
    let fingerprint = fingerprint_from_open_file(canonical_path, &file)?;
    validate_footer(&mut file, fingerprint.size)?;
    // SerializedFileReader construction parses the footer metadata. No row-group, page,
    // column, or record reader is created by this metadata-only path.
    let reader = open_parquet_metadata(file, fingerprint.size)?;
    let parquet_metadata = reader.metadata();
    let file_metadata = parquet_metadata.file_metadata();
    let row_count = u64::try_from(file_metadata.num_rows())
        .map_err(|_| AppError::InvalidParquet("Parquet row count is invalid".into()))?;
    let row_group_count = u32::try_from(parquet_metadata.num_row_groups())
        .map_err(|_| AppError::ResourceExhausted("Too many Parquet row groups".into()))?;
    // The MVP wire contract intentionally reports only top-level Parquet fields. Nested
    // children remain represented by their parent display type until recursive schemas
    // are introduced as a separate, compatible API change.
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
    let canonical_path_text = canonical_path
        .to_str()
        .ok_or_else(|| AppError::InvalidPath("File path is not valid UTF-8".into()))?;
    let name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidPath("File name is not valid UTF-8".into()))?
        .to_owned();

    Ok(LoadedFile {
        metadata: FileMetadata {
            file_id,
            path: canonical_path_text.to_owned(),
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
    // Tauri IPC supplies paths as UTF-8 strings. Reject non-UTF-8 canonical paths so the
    // public FileMetadata.path remains authoritative and reversible instead of lossy.
    canonical
        .to_str()
        .ok_or_else(|| AppError::InvalidPath("File path is not valid UTF-8".into()))?;
    Ok(canonical)
}

fn open_regular_file(canonical_path: &Path) -> Result<File, AppError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let file = options
        .open(canonical_path)
        .map_err(|error| map_io_error(error, canonical_path))?;
    let metadata = file
        .metadata()
        .map_err(|error| map_io_error(error, canonical_path))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath("Path is not a file".into()));
    }
    Ok(file)
}

fn fingerprint_from_open_file(
    canonical_path: &Path,
    file: &File,
) -> Result<FileFingerprint, AppError> {
    let metadata = file
        .metadata()
        .map_err(|error| map_io_error(error, canonical_path))?;
    let modified = metadata
        .modified()
        .map_err(|error| map_io_error(error, canonical_path))?;
    Ok(FileFingerprint {
        canonical_path: canonical_path.to_owned(),
        size: metadata.len(),
        modified,
        identity: file_identity(&metadata),
    })
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
fn file_identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity::Windows {
        volume_serial_number: metadata.volume_serial_number(),
        file_index: metadata.file_index(),
    }
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_metadata: &Metadata) -> FileIdentity {
    FileIdentity::Unavailable
}

fn validate_footer(file: &mut File, file_size: u64) -> Result<(), AppError> {
    if file_size < 8 {
        return Err(AppError::InvalidParquet(
            "The file has a truncated Parquet footer".into(),
        ));
    }
    file.seek(SeekFrom::End(-8))
        .map_err(|error| map_io_error(error, Path::new("")))?;
    let mut footer = [0_u8; 8];
    file.read_exact(&mut footer)
        .map_err(|_| AppError::InvalidParquet("The file has a truncated Parquet footer".into()))?;
    if &footer[4..] != b"PAR1" {
        return Err(AppError::InvalidParquet(
            "The file has an invalid Parquet footer".into(),
        ));
    }
    let metadata_length =
        u32::from_le_bytes(footer[..4].try_into().map_err(|_| {
            AppError::InvalidParquet("The file has an invalid Parquet footer".into())
        })?) as u64;
    if metadata_length > MAX_FOOTER_METADATA_BYTES {
        return Err(AppError::ResourceExhausted(
            "Parquet footer metadata exceeds the supported limit".into(),
        ));
    }
    if metadata_length > file_size - 8 {
        return Err(AppError::InvalidParquet(
            "The file has an invalid Parquet footer length".into(),
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| map_io_error(error, Path::new("")))?;
    Ok(())
}

fn open_parquet_metadata(
    file: File,
    file_size: u64,
) -> Result<SerializedFileReader<MetadataChunkReader>, AppError> {
    let chunk_reader = MetadataChunkReader::new(file, file_size);
    let cap_exceeded = chunk_reader.cap_exceeded.clone();
    SerializedFileReader::new(chunk_reader).map_err(|_| {
        if cap_exceeded.load(Ordering::Relaxed) {
            AppError::ResourceExhausted(
                "Parquet footer metadata exceeds the supported limit".into(),
            )
        } else {
            AppError::InvalidParquet("The file is not valid Parquet".into())
        }
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

#[cfg(test)]
mod query_guard_tests {
    use super::windows_query_guard_share_mode;

    #[test]
    fn windows_query_guard_allows_reads_but_denies_write_and_delete_sharing() {
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;

        let share_mode = windows_query_guard_share_mode();
        assert_eq!(share_mode, FILE_SHARE_READ);
        assert_eq!(share_mode & (FILE_SHARE_WRITE | FILE_SHARE_DELETE), 0);
    }
}

#[cfg(test)]
mod metadata_boundary_tests {
    use std::io::{Read, Seek, SeekFrom, Write};

    use parquet::file::reader::ChunkReader;

    use super::{
        MAX_FOOTER_METADATA_BYTES, MetadataChunkReader, open_parquet_metadata, validate_footer,
    };
    use crate::error::AppError;

    #[test]
    fn metadata_chunk_reader_rejects_random_reads_above_its_cap() {
        let file = tempfile::tempfile().unwrap();
        file.set_len(64).unwrap();
        let reader = MetadataChunkReader::with_cap(file, 16);

        assert!(reader.get_bytes(0, 17).is_err());
        assert!(reader.cap_exceeded());
    }

    #[test]
    fn metadata_chunk_reader_limits_sequential_streams() {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&[7_u8; 64]).unwrap();
        let reader = MetadataChunkReader::with_cap(file, 16);
        let mut stream = reader.get_read(0).unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();

        assert_eq!(bytes.len(), 24);
    }

    #[test]
    fn footer_growth_after_preflight_is_capped_at_parser_read_boundary() {
        let mut file = tempfile::tempfile().unwrap();
        let file_size = MAX_FOOTER_METADATA_BYTES + 9;
        file.set_len(file_size).unwrap();
        file.seek(SeekFrom::End(-8)).unwrap();
        file.write_all(&0_u32.to_le_bytes()).unwrap();
        file.write_all(b"PAR1").unwrap();
        validate_footer(&mut file, file_size).unwrap();

        let mut mutator = file.try_clone().unwrap();
        mutator.seek(SeekFrom::End(-8)).unwrap();
        mutator
            .write_all(&((MAX_FOOTER_METADATA_BYTES + 1) as u32).to_le_bytes())
            .unwrap();
        mutator.write_all(b"PAR1").unwrap();

        assert!(matches!(
            open_parquet_metadata(file, file_size),
            Err(AppError::ResourceExhausted(_))
        ));
    }

    #[test]
    fn metadata_chunk_reader_allows_reads_at_the_cap() {
        let file = tempfile::tempfile().unwrap();
        file.set_len(16).unwrap();
        let reader = MetadataChunkReader::with_cap(file, 16);

        assert_eq!(reader.get_bytes(0, 16).unwrap().len(), 16);
        assert!(!reader.cap_exceeded());
    }
}

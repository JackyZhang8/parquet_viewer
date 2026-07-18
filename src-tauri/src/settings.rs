use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;

const MIB: u64 = 1024 * 1024;
const MIN_BATCH_SIZE: u32 = 50;
const MAX_BATCH_SIZE: u32 = 5_000;
const MIN_PREVIEW_LIMIT: u32 = 100;
const MAX_PREVIEW_LIMIT: u32 = 100_000;
const MIN_MEMORY_MB: u32 = 64;
const MAX_MEMORY_MB: u32 = 16_384;
const MIN_DISK_WARNING_MB: u32 = 64;
const MAX_DISK_WARNING_MB: u32 = 102_400;
const MIN_CONCURRENCY: u32 = 1;
const MAX_CONCURRENCY: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    En,
    Zh,
}

impl Default for Language {
    fn default() -> Self {
        Self::En
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    #[serde(default)]
    pub language: Language,
    pub theme: Theme,
    pub batch_size: u32,
    pub preview_limit: u32,
    pub memory_limit_mb: u32,
    pub temp_directory: Option<String>,
    pub temp_disk_warning_mb: u32,
    pub concurrency: u32,
    pub restore_tabs: bool,
}

impl AppSettings {
    pub fn defaults_for_available_memory(available_memory_bytes: u64) -> Self {
        Self {
            language: Language::En,
            theme: Theme::System,
            batch_size: 500,
            preview_limit: 10_000,
            memory_limit_mb: default_memory_limit_mb(available_memory_bytes),
            temp_directory: None,
            temp_disk_warning_mb: 1024,
            concurrency: 2,
            restore_tabs: true,
        }
    }

    pub(crate) fn runtime(&self) -> RuntimeSettings {
        RuntimeSettings {
            memory_limit_mb: self.memory_limit_mb,
            temp_directory: self.temp_directory.as_ref().map(PathBuf::from),
            temp_disk_warning_mb: self.temp_disk_warning_mb,
            concurrency: self.concurrency as usize,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSettings {
    pub memory_limit_mb: u32,
    pub temp_directory: Option<PathBuf>,
    pub temp_disk_warning_mb: u32,
    pub concurrency: usize,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        AppSettings::defaults_for_available_memory(detected_available_memory_bytes()).runtime()
    }
}

pub fn default_memory_limit_mb(available_memory_bytes: u64) -> u32 {
    let quarter_mb = available_memory_bytes / 4 / MIB;
    quarter_mb.clamp(u64::from(MIN_MEMORY_MB), 2048) as u32
}

pub fn sanitize_settings(mut settings: AppSettings) -> Result<AppSettings, AppError> {
    settings.batch_size = settings.batch_size.clamp(MIN_BATCH_SIZE, MAX_BATCH_SIZE);
    settings.preview_limit = settings
        .preview_limit
        .clamp(MIN_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);
    settings.memory_limit_mb = settings.memory_limit_mb.clamp(MIN_MEMORY_MB, MAX_MEMORY_MB);
    settings.temp_disk_warning_mb = settings
        .temp_disk_warning_mb
        .clamp(MIN_DISK_WARNING_MB, MAX_DISK_WARNING_MB);
    settings.concurrency = settings.concurrency.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY);
    if let Some(directory) = &settings.temp_directory {
        if directory.is_empty() || directory.contains('\0') {
            return Err(AppError::InvalidPath(
                "Temporary directory path is invalid".into(),
            ));
        }
        let path = Path::new(directory);
        let metadata = fs::metadata(path)
            .map_err(|_| AppError::InvalidPath("Temporary directory does not exist".into()))?;
        if !metadata.is_dir() {
            return Err(AppError::InvalidPath(
                "Temporary directory path is not a directory".into(),
            ));
        }
        let canonical = fs::canonicalize(path).map_err(|_| {
            AppError::InvalidPath("Temporary directory could not be resolved".into())
        })?;
        settings.temp_directory = Some(
            canonical
                .to_str()
                .ok_or_else(|| {
                    AppError::InvalidPath("Temporary directory is not valid UTF-8".into())
                })?
                .to_owned(),
        );
    }
    Ok(settings)
}

#[derive(Clone)]
pub struct SettingsStore {
    path: Arc<PathBuf>,
    defaults: AppSettings,
    current: Arc<Mutex<AppSettings>>,
    save_lock: Arc<Mutex<()>>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::with_available_memory(path, detected_available_memory_bytes())
    }

    pub fn with_available_memory(path: impl Into<PathBuf>, available_memory_bytes: u64) -> Self {
        let defaults = AppSettings::defaults_for_available_memory(available_memory_bytes);
        let store = Self {
            path: Arc::new(path.into()),
            defaults: defaults.clone(),
            current: Arc::new(Mutex::new(defaults)),
            save_lock: Arc::new(Mutex::new(())),
        };
        store.reload_from_disk();
        store
    }

    pub fn load(&self) -> AppSettings {
        self.current.lock().clone()
    }

    pub fn save(&self, settings: AppSettings) -> Result<AppSettings, AppError> {
        let settings = sanitize_settings(settings)?;
        let bytes = serde_json::to_vec_pretty(&settings)
            .map_err(|_| AppError::InvalidArgument("Invalid settings data".into()))?;
        let _guard = self.save_lock.lock();
        atomic_write(&self.path, &bytes)?;
        *self.current.lock() = settings.clone();
        Ok(settings)
    }

    pub fn reload_from_disk(&self) -> AppSettings {
        let loaded = fs::read(&*self.path)
            .ok()
            .filter(|bytes| bytes.len() <= 64 * 1024)
            .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
            .and_then(|settings| sanitize_settings(settings).ok())
            .unwrap_or_else(|| self.defaults.clone());
        *self.current.lock() = loaded.clone();
        loaded
    }
}

fn detected_available_memory_bytes() -> u64 {
    #[cfg(unix)]
    unsafe {
        let pages = libc::sysconf(libc::_SC_PHYS_PAGES);
        let page_size = libc::sysconf(libc::_SC_PAGESIZE);
        if pages > 0 && page_size > 0 {
            return (pages as u64).saturating_mul(page_size as u64);
        }
    }
    2 * 1024 * 1024 * 1024
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(map_write_error)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    let temporary = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(map_write_error)?;
        file.write_all(bytes).map_err(map_write_error)?;
        file.flush().map_err(map_write_error)?;
        file.sync_all().map_err(map_write_error)?;
        drop(file);
        atomic_replace(&temporary, path).map_err(map_write_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(unix)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn map_write_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::PermissionDenied("Unable to save settings".into())
    } else {
        AppError::Internal(format!("settings write failed: {error}"))
    }
}

#[tauri::command]
pub async fn load_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    Ok(state.settings.load())
}

#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<AppSettings, AppError> {
    let store = state.settings.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || store.save(settings))
        .await
        .map_err(|error| AppError::Internal(format!("settings save task failed: {error}")))??;
    let runtime = saved.runtime();
    state.queries.update_settings(runtime.clone());
    state.exports.update_settings(runtime);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{AppSettings, Language, SettingsStore, Theme, default_memory_limit_mb, sanitize_settings};

    #[test]
    fn defaults_match_the_mvp_and_memory_is_bounded_by_available_ram() {
        let settings = AppSettings::defaults_for_available_memory(8 * 1024 * 1024 * 1024);
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.language, Language::En);
        assert_eq!(settings.batch_size, 500);
        assert_eq!(settings.preview_limit, 10_000);
        assert_eq!(settings.concurrency, 2);
        assert!(settings.restore_tabs);
        assert_eq!(settings.temp_directory, None);
        assert_eq!(settings.temp_disk_warning_mb, 1024);
        assert_eq!(default_memory_limit_mb(8 * 1024 * 1024 * 1024), 2048);
        assert_eq!(default_memory_limit_mb(512 * 1024 * 1024), 128);
        assert_eq!(default_memory_limit_mb(64 * 1024 * 1024), 64);
    }

    #[test]
    fn legacy_settings_without_language_default_to_english() {
        let settings: AppSettings = serde_json::from_str(
            r#"{"theme":"system","batchSize":500,"previewLimit":10000,"memoryLimitMb":512,"tempDirectory":null,"tempDiskWarningMb":1024,"concurrency":2,"restoreTabs":true}"#,
        )
        .unwrap();

        assert_eq!(serde_json::to_value(settings).unwrap()["language"], "en");
    }

    #[test]
    fn unsafe_numeric_settings_are_clamped_to_documented_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let sanitized = sanitize_settings(AppSettings {
            language: Language::En,
            theme: Theme::Dark,
            batch_size: 0,
            preview_limit: u32::MAX,
            memory_limit_mb: 1,
            temp_directory: Some(temp.path().to_string_lossy().into_owned()),
            temp_disk_warning_mb: u32::MAX,
            concurrency: 99,
            restore_tabs: false,
        })
        .unwrap();

        assert_eq!(sanitized.batch_size, 50);
        assert_eq!(sanitized.preview_limit, 100_000);
        assert_eq!(sanitized.memory_limit_mb, 64);
        assert_eq!(sanitized.temp_disk_warning_mb, 102_400);
        assert_eq!(sanitized.concurrency, 4);
        assert!(!sanitized.restore_tabs);
    }

    #[test]
    fn invalid_or_file_temp_directories_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("not-a-directory");
        fs::write(&file, "x").unwrap();
        for path in [temp.path().join("missing"), file] {
            let mut settings = AppSettings::defaults_for_available_memory(2 * 1024 * 1024 * 1024);
            settings.temp_directory = Some(path.to_string_lossy().into_owned());
            assert!(matches!(
                sanitize_settings(settings),
                Err(crate::error::AppError::InvalidPath(_))
            ));
        }
    }

    #[test]
    fn settings_round_trip_atomically_and_corrupt_files_recover_to_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let store = SettingsStore::with_available_memory(&path, 4 * 1024 * 1024 * 1024);
        let expected = sanitize_settings(AppSettings {
            language: Language::En,
            theme: Theme::Light,
            batch_size: 750,
            preview_limit: 25_000,
            memory_limit_mb: 900,
            temp_directory: Some(temp.path().to_string_lossy().into_owned()),
            temp_disk_warning_mb: 2048,
            concurrency: 3,
            restore_tabs: false,
        })
        .unwrap();

        assert_eq!(store.save(expected.clone()).unwrap(), expected);
        assert_eq!(store.load(), expected);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["batchSize"], 750);
        assert_eq!(json["restoreTabs"], false);
        fs::write(path, "not json").unwrap();
        assert_eq!(
            store.reload_from_disk(),
            AppSettings::defaults_for_available_memory(4 * 1024 * 1024 * 1024)
        );
    }
}

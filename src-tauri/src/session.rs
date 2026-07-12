use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::error::AppError;
use crate::models::{RestoredSession, SessionSnapshot};

const VERSION: u32 = 1;
const MAX_TABS: usize = 100;
const MAX_SQL_BYTES: usize = 256 * 1024;
const MAX_SESSION_BYTES: usize = 4 * 1024 * 1024;
pub const SESSION_WARNING: &str = "The saved workspace could not be restored";

#[derive(Clone)]
pub struct SessionStore {
    path: Arc<PathBuf>,
    save_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    fail_next_replace: Arc<std::sync::atomic::AtomicBool>,
}

impl SessionStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(path.into()),
            save_lock: Arc::new(Mutex::new(())),
            #[cfg(test)]
            fail_next_replace: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn save(&self, snapshot: &SessionSnapshot) -> Result<(), AppError> {
        let _guard = self.save_lock.lock();
        validate(snapshot)?;
        let bytes = serde_json::to_vec(snapshot)
            .map_err(|_| AppError::InvalidArgument("Invalid session data".into()))?;
        if bytes.len() > MAX_SESSION_BYTES {
            return Err(AppError::InvalidArgument("Session is too large".into()));
        }
        self.atomic_write(&bytes)
    }

    pub fn load(&self) -> Result<RestoredSession, AppError> {
        let bytes = match read_bounded(&self.path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(empty_restored(None)),
            Err(ReadFailure::Invalid) => return Ok(empty_restored(Some(SESSION_WARNING.into()))),
            Err(ReadFailure::Io(error)) => return Err(map_read_error(error)),
        };
        let snapshot: SessionSnapshot = match serde_json::from_slice(&bytes) {
            Ok(snapshot) => snapshot,
            Err(_) => return Ok(empty_restored(Some(SESSION_WARNING.into()))),
        };
        if validate(&snapshot).is_err() {
            return Ok(empty_restored(Some(SESSION_WARNING.into())));
        }
        let unavailable_tab_ids = snapshot
            .tabs
            .iter()
            .filter(|tab| {
                fs::metadata(&tab.path)
                    .map(|metadata| !metadata.is_file())
                    .unwrap_or(true)
            })
            .map(|tab| tab.id.clone())
            .collect();
        Ok(RestoredSession {
            snapshot,
            unavailable_tab_ids,
            warning: None,
        })
    }

    fn atomic_write(&self, bytes: &[u8]) -> Result<(), AppError> {
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(map_write_error)?;
        cleanup_stale_temps(parent, &self.path);
        let temp = parent.join(temp_name(&self.path, Uuid::new_v4()));
        let result = (|| {
            let mut file = create_private_temp(&temp)?;
            file.write_all(bytes).map_err(map_write_error)?;
            file.flush().map_err(map_write_error)?;
            file.sync_all().map_err(map_write_error)?;
            drop(file);
            #[cfg(test)]
            if self
                .fail_next_replace
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(AppError::Internal(
                    "injected session replace failure".into(),
                ));
            }
            atomic_replace(&temp, &self.path).map_err(map_write_error)?;
            sync_directory(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    #[cfg(test)]
    fn fail_next_replace_for_test(&self) {
        self.fail_next_replace
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn temp_name(session_path: &Path, id: Uuid) -> String {
    let name = session_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.json");
    format!(".{name}.{id}.tmp")
}

fn cleanup_stale_temps(parent: &Path, session_path: &Path) {
    let name = session_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.json");
    let prefix = format!(".{name}.");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(candidate) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = candidate
            .strip_prefix(&prefix)
            .and_then(|candidate| candidate.strip_suffix(".tmp"))
        else {
            continue;
        };
        if Uuid::parse_str(id).is_err() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

fn validate(snapshot: &SessionSnapshot) -> Result<(), AppError> {
    if snapshot.version != VERSION {
        return Err(AppError::InvalidArgument(
            "Unsupported session version".into(),
        ));
    }
    if snapshot.tabs.len() > MAX_TABS {
        return Err(AppError::InvalidArgument(
            "Session has too many tabs".into(),
        ));
    }
    let mut ids = HashSet::with_capacity(snapshot.tabs.len());
    for tab in &snapshot.tabs {
        if !ids.insert(tab.id.as_str()) {
            return Err(AppError::InvalidArgument(
                "Session tab IDs must be unique".into(),
            ));
        }
        if tab.path.is_empty() {
            return Err(AppError::InvalidArgument(
                "Session paths cannot be empty".into(),
            ));
        }
        if tab.sql_draft.len() > MAX_SQL_BYTES {
            return Err(AppError::InvalidArgument("SQL draft is too large".into()));
        }
    }
    if snapshot
        .active_tab_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id.as_str()))
    {
        return Err(AppError::InvalidArgument(
            "Active tab is not in the session".into(),
        ));
    }
    Ok(())
}

fn empty_restored(warning: Option<String>) -> RestoredSession {
    RestoredSession {
        snapshot: SessionSnapshot {
            version: VERSION,
            tabs: vec![],
            active_tab_id: None,
        },
        unavailable_tab_ids: vec![],
        warning,
    }
}

enum ReadFailure {
    Invalid,
    Io(std::io::Error),
}

fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>, ReadFailure> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ReadFailure::Io(error)),
    };
    if metadata.len() > MAX_SESSION_BYTES as u64 {
        return Err(ReadFailure::Invalid);
    }
    let file = File::open(path).map_err(ReadFailure::Io)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_SESSION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(ReadFailure::Io)?;
    if bytes.len() > MAX_SESSION_BYTES {
        return Err(ReadFailure::Invalid);
    }
    Ok(Some(bytes))
}

fn create_private_temp(path: &Path) -> Result<File, AppError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(map_write_error)
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

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AppError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(map_write_error)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

fn map_read_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::PermissionDenied("Unable to read saved workspace".into())
    } else {
        AppError::Internal(format!("session read failed: {error}"))
    }
}

fn map_write_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::PermissionDenied("Unable to save workspace".into())
    } else {
        AppError::Internal(format!("session write failed: {error}"))
    }
}

#[tauri::command]
pub async fn load_session(state: State<'_, AppState>) -> Result<RestoredSession, AppError> {
    let store = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || store.load())
        .await
        .map_err(|error| AppError::Internal(format!("session load task failed: {error}")))?
}

#[tauri::command]
pub async fn save_session(
    snapshot: SessionSnapshot,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let store = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || store.save(&snapshot))
        .await
        .map_err(|error| AppError::Internal(format!("session save task failed: {error}")))?
}

#[cfg(test)]
mod tests;

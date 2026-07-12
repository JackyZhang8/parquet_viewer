mod fixtures;

use std::fs;
use std::io::Write;
use std::sync::{Arc, Barrier};

use parquet_viewer_lib::error::AppError;
use parquet_viewer_lib::files::{FileRegistry, read_metadata};

use fixtures::{fixture, write_fixture, write_nested_fixture};

#[test]
fn reads_only_footer_metadata_for_expected_schema() {
    let (_temp, path) = fixture();
    let metadata = read_metadata(&path, "test-id".into()).unwrap();

    assert_eq!(metadata.file_id, "test-id");
    assert_eq!(metadata.row_count, 10);
    assert_eq!(metadata.row_group_count, 2);
    assert_eq!(metadata.columns.len(), 3);
    assert_eq!(metadata.columns[0].name, "id");
    assert_eq!(metadata.columns[0].logical_type, "INT64");
    assert!(!metadata.columns[0].nullable);
    assert_eq!(metadata.columns[1].name, "name");
    assert_eq!(metadata.columns[1].logical_type, "STRING");
    assert!(metadata.columns[1].nullable);
    assert_eq!(metadata.columns[2].name, "created_at");
    assert_eq!(metadata.columns[2].logical_type, "TIMESTAMP_MILLIS");
    assert!(!metadata.columns[2].nullable);
    let json = serde_json::to_value(metadata).unwrap();
    assert!(json.get("rows").is_none());
    assert!(json.get("batches").is_none());
}

#[test]
fn nested_schema_is_reported_as_one_top_level_struct_column() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("nested.parquet");
    write_nested_fixture(&path);
    let metadata = read_metadata(&path, "nested-id".into()).unwrap();

    assert_eq!(metadata.columns.len(), 1);
    assert_eq!(metadata.columns[0].name, "profile");
    assert_eq!(metadata.columns[0].logical_type, "STRUCT");
    assert!(metadata.columns[0].nullable);
}

#[test]
fn rejects_non_parquet_and_truncated_files() {
    let temp = tempfile::tempdir().unwrap();
    let text = temp.path().join("not.parquet");
    fs::write(&text, b"hello world").unwrap();
    assert!(matches!(
        read_metadata(&text, "id".into()),
        Err(AppError::InvalidParquet(_))
    ));

    let valid = temp.path().join("valid.parquet");
    write_fixture(&valid);
    let bytes = fs::read(&valid).unwrap();
    let truncated = temp.path().join("truncated.parquet");
    fs::write(&truncated, &bytes[..bytes.len() - 4]).unwrap();
    assert!(matches!(
        read_metadata(&truncated, "id".into()),
        Err(AppError::InvalidParquet(_))
    ));
}

#[test]
fn maps_missing_paths_and_directories_to_invalid_path() {
    let temp = tempfile::tempdir().unwrap();
    assert!(matches!(
        read_metadata(&temp.path().join("missing.parquet"), "id".into()),
        Err(AppError::InvalidPath(_))
    ));
    assert!(matches!(
        read_metadata(temp.path(), "id".into()),
        Err(AppError::InvalidPath(_))
    ));
}

#[test]
fn registry_deduplicates_canonical_paths_and_preserves_batch_errors() {
    let (_temp, path) = fixture();
    let registry = FileRegistry::default();
    let alias = path
        .parent()
        .unwrap()
        .join(".")
        .join(path.file_name().unwrap());
    let missing = path.parent().unwrap().join("missing.parquet");
    let opened = registry.open_paths(vec![path.clone(), missing, alias]);

    assert_eq!(opened.len(), 3);
    let first = opened[0].as_ref().unwrap();
    assert!(matches!(opened[1], Err(AppError::InvalidPath(_))));
    let duplicate = opened[2].as_ref().unwrap();
    assert_eq!(first.file_id, duplicate.file_id);
    assert_eq!(registry.get(&first.file_id).unwrap(), first.clone());
}

#[test]
fn open_batch_wire_shape_preserves_successes_and_sanitized_errors_in_order() {
    let (_temp, path) = fixture();
    let missing = path.parent().unwrap().join("private-missing.parquet");
    let opened = FileRegistry::default().open_paths(vec![path, missing]);
    let json = serde_json::to_value(opened).unwrap();

    assert!(json[0]["Ok"].get("fileId").is_some());
    assert_eq!(json[1]["Err"]["code"], "INVALID_PATH");
    assert_eq!(json[1]["Err"]["detail"], serde_json::Value::Null);
    assert!(
        !json[1]["Err"]["message"]
            .as_str()
            .unwrap()
            .contains("private-missing.parquet")
    );
}

#[test]
fn detects_fingerprint_changes_and_reload_keeps_last_good_metadata() {
    let (_temp, path) = fixture();
    let registry = FileRegistry::default();
    let opened = registry.open_paths(vec![path.clone()]).remove(0).unwrap();
    assert!(!registry.is_stale(&opened.file_id).unwrap());

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    assert!(registry.is_stale(&opened.file_id).unwrap());
    assert!(matches!(
        registry.reload(&opened.file_id),
        Err(AppError::InvalidParquet(_))
    ));
    assert!(registry.get(&opened.file_id).is_some());
}

#[test]
fn remove_closes_registry_entry() {
    let (_temp, path) = fixture();
    let registry = FileRegistry::default();
    let opened = registry.open_paths(vec![path]).remove(0).unwrap();
    registry.remove(&opened.file_id).unwrap();
    assert!(registry.get(&opened.file_id).is_none());
    assert!(matches!(
        registry.remove(&opened.file_id),
        Err(AppError::InvalidPath(_))
    ));
}

#[test]
fn rejects_malformed_footer_magic_and_impossible_length() {
    let temp = tempfile::tempdir().unwrap();
    let bad_magic = temp.path().join("bad-magic.parquet");
    fs::write(&bad_magic, [0, 0, 0, 0, b'B', b'A', b'D', b'!']).unwrap();
    assert!(matches!(
        read_metadata(&bad_magic, "id".into()),
        Err(AppError::InvalidParquet(_))
    ));

    let impossible = temp.path().join("impossible-length.parquet");
    fs::write(&impossible, [1, 0, 0, 0, b'P', b'A', b'R', b'1']).unwrap();
    assert!(matches!(
        read_metadata(&impossible, "id".into()),
        Err(AppError::InvalidParquet(_))
    ));
}

#[test]
fn rejects_declared_footer_metadata_over_cap_before_allocation() {
    const OVER_CAP: u32 = 64 * 1024 * 1024 + 1;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("oversized-footer.parquet");
    let mut footer = OVER_CAP.to_le_bytes().to_vec();
    footer.extend_from_slice(b"PAR1");
    fs::write(&path, footer).unwrap();

    assert!(matches!(
        read_metadata(&path, "id".into()),
        Err(AppError::ResourceExhausted(_))
    ));
}

#[test]
fn concurrent_duplicate_opens_share_one_file_id_and_registry_entry() {
    let (_temp, path) = fixture();
    let registry = Arc::new(FileRegistry::default());
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                registry.open_paths(vec![path]).remove(0).unwrap().file_id
            })
        })
        .collect();
    let ids: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();

    assert!(ids.iter().all(|id| id == &ids[0]));
    registry.remove(&ids[0]).unwrap();
    assert!(matches!(
        registry.remove(&ids[0]),
        Err(AppError::InvalidPath(_))
    ));
}

#[cfg(unix)]
#[test]
fn rejects_fifo_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("pipe.parquet");
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

    assert!(matches!(
        read_metadata(&path, "id".into()),
        Err(AppError::InvalidPath(_))
    ));
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn rejects_non_utf8_canonical_paths() {
    // macOS filesystem APIs reject invalid UTF-8 path creation with EILSEQ, so this
    // deterministic fixture is exercised only on Unix platforms that permit it.
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp
        .path()
        .join(OsString::from_vec(b"bad-\xff.parquet".to_vec()));
    write_fixture(&path);

    assert!(matches!(
        read_metadata(&path, "id".into()),
        Err(AppError::InvalidPath(_))
    ));
}

#[cfg(unix)]
#[test]
fn detects_same_size_same_mtime_file_replacement_by_identity() {
    let (_temp, path) = fixture();
    let registry = FileRegistry::default();
    let opened = registry.open_paths(vec![path.clone()]).remove(0).unwrap();
    let original_metadata = fs::metadata(&path).unwrap();
    let original_mtime = filetime::FileTime::from_last_modification_time(&original_metadata);
    let replacement = path.with_extension("replacement");
    fs::copy(&path, &replacement).unwrap();
    filetime::set_file_mtime(&replacement, original_mtime).unwrap();
    assert_eq!(
        fs::metadata(&replacement).unwrap().len(),
        original_metadata.len()
    );
    fs::rename(&replacement, &path).unwrap();

    assert!(registry.is_stale(&opened.file_id).unwrap());
}

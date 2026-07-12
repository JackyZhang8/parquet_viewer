mod fixtures;

use std::fs;
use std::io::Write;

use parquet_viewer_lib::error::AppError;
use parquet_viewer_lib::files::{FileRegistry, read_metadata};

use fixtures::{fixture, write_fixture};

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

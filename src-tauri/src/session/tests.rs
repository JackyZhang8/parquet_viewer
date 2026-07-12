use std::fs;
use std::sync::Arc;

use serde_json::json;
use tempfile::tempdir;

use super::{SESSION_WARNING, SessionStore};
use crate::error::AppError;
use crate::models::{
    SessionFilter, SessionFilterOperator, SessionScalar, SessionSnapshot, SessionSort,
    SessionSortDirection, SessionTab, SessionViewState,
};

fn tab(id: &str, path: String, sql_draft: String) -> SessionTab {
    SessionTab {
        id: id.into(),
        file_id: format!("file-{id}"),
        path,
        sql_draft,
        filters: vec![SessionFilter {
            column: "enabled".into(),
            operator: SessionFilterOperator::Eq,
            value: SessionScalar::Boolean(true),
        }],
        sorts: vec![SessionSort {
            column: "created_at".into(),
            direction: SessionSortDirection::Desc,
        }],
        view_state: SessionViewState {
            scroll_top: 12,
            scroll_left: 34,
            sidebar_width: 280,
            editor_height: 190,
        },
    }
}

fn snapshot(paths: [&std::path::Path; 2]) -> SessionSnapshot {
    SessionSnapshot {
        version: 1,
        tabs: vec![
            tab(
                "one",
                paths[0].to_string_lossy().into_owned(),
                "select 1".into(),
            ),
            tab(
                "two",
                paths[1].to_string_lossy().into_owned(),
                "select 2".into(),
            ),
        ],
        active_tab_id: Some("two".into()),
    }
}

#[test]
fn round_trip_preserves_order_drafts_filters_sorts_and_view_state() {
    let dir = tempdir().unwrap();
    let first = dir.path().join("first.parquet");
    let second = dir.path().join("second.parquet");
    fs::write(&first, b"not opened").unwrap();
    fs::write(&second, b"not opened either").unwrap();
    let expected = snapshot([&first, &second]);
    let store = SessionStore::new(dir.path().join("session.json"));

    store.save(&expected).unwrap();
    let restored = store.load().unwrap();

    assert_eq!(restored.snapshot, expected);
    assert!(restored.unavailable_tab_ids.is_empty());
    assert_eq!(restored.warning, None);
    let text = fs::read_to_string(dir.path().join("session.json")).unwrap();
    for forbidden in ["queryId", "rows", "running", "batch", "error"] {
        assert!(
            !text.contains(forbidden),
            "persisted transient field {forbidden}"
        );
    }
}

#[test]
fn missing_session_is_empty_and_missing_data_file_keeps_tab_but_marks_it_unavailable() {
    let dir = tempdir().unwrap();
    let store = SessionStore::new(dir.path().join("session.json"));
    assert_eq!(store.load().unwrap().snapshot.tabs, vec![]);

    let missing = dir.path().join("missing.parquet");
    let present = dir.path().join("present.parquet");
    fs::write(&present, b"metadata only").unwrap();
    let expected = snapshot([&missing, &present]);
    store.save(&expected).unwrap();
    let restored = store.load().unwrap();

    assert_eq!(restored.snapshot, expected);
    assert_eq!(restored.unavailable_tab_ids, vec!["one"]);
}

#[test]
fn directories_are_unavailable_even_when_metadata_succeeds() {
    let dir = tempdir().unwrap();
    let data_directory = dir.path().join("not-a-file.parquet");
    fs::create_dir(&data_directory).unwrap();
    let store = SessionStore::new(dir.path().join("session.json"));
    let expected = SessionSnapshot {
        version: 1,
        tabs: vec![tab(
            "directory",
            data_directory.to_string_lossy().into_owned(),
            String::new(),
        )],
        active_tab_id: Some("directory".into()),
    };
    store.save(&expected).unwrap();

    let restored = store.load().unwrap();

    assert_eq!(restored.snapshot, expected);
    assert_eq!(restored.unavailable_tab_ids, vec!["directory"]);
}

#[cfg(unix)]
#[test]
fn symlinks_to_directories_are_unavailable() {
    use std::os::unix::fs::symlink;

    let dir = tempdir().unwrap();
    let target = dir.path().join("directory");
    let link = dir.path().join("linked.parquet");
    fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();
    let store = SessionStore::new(dir.path().join("session.json"));
    store
        .save(&SessionSnapshot {
            version: 1,
            tabs: vec![tab(
                "link",
                link.to_string_lossy().into_owned(),
                String::new(),
            )],
            active_tab_id: Some("link".into()),
        })
        .unwrap();

    assert_eq!(store.load().unwrap().unavailable_tab_ids, vec!["link"]);
}

#[cfg(unix)]
#[test]
fn special_files_are_unavailable_without_opening_them() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let dir = tempdir().unwrap();
    let fifo = dir.path().join("not-data.parquet");
    let fifo_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    let store = SessionStore::new(dir.path().join("session.json"));
    store
        .save(&SessionSnapshot {
            version: 1,
            tabs: vec![tab(
                "fifo",
                fifo.to_string_lossy().into_owned(),
                String::new(),
            )],
            active_tab_id: Some("fifo".into()),
        })
        .unwrap();

    let restored = store.load().unwrap();

    assert_eq!(restored.unavailable_tab_ids, vec!["fifo"]);
}

#[test]
fn save_removes_only_matching_stale_regular_temp_siblings() {
    let dir = tempdir().unwrap();
    let session_path = dir.path().join("session.json");
    let stale = dir
        .path()
        .join(".session.json.00000000-0000-0000-0000-000000000001.tmp");
    let matching_directory = dir
        .path()
        .join(".session.json.00000000-0000-0000-0000-000000000002.tmp");
    let unknown = dir.path().join(".session-other.tmp");
    fs::write(&stale, b"stale").unwrap();
    fs::create_dir(&matching_directory).unwrap();
    fs::write(&unknown, b"owned by someone else").unwrap();

    SessionStore::new(&session_path)
        .save(&SessionSnapshot {
            version: 1,
            tabs: vec![],
            active_tab_id: None,
        })
        .unwrap();

    assert!(!stale.exists());
    assert!(matching_directory.is_dir());
    assert!(unknown.is_file());
}

#[test]
fn invalid_saved_documents_recover_to_empty_with_sanitized_warning() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let invalid = [
        "{broken".to_owned(),
        json!({"version":1,"tabs":[],"activeTabId":null,"queryId":"secret"}).to_string(),
        json!({"version":2,"tabs":[],"activeTabId":null}).to_string(),
        json!({"version":1,"tabs":[minimal_tab("same"), minimal_tab("same")],"activeTabId":"same"})
            .to_string(),
        json!({"version":1,"tabs":[minimal_tab("one")],"activeTabId":"missing"}).to_string(),
    ];

    for contents in invalid {
        fs::write(&path, &contents).unwrap();
        let restored = SessionStore::new(&path).load().unwrap();
        assert!(restored.snapshot.tabs.is_empty());
        assert_eq!(restored.warning.as_deref(), Some(SESSION_WARNING));
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        let warning = restored.warning.as_deref().unwrap();
        assert!(!warning.contains("secret"));
        assert!(!warning.contains(dir.path().to_str().unwrap()));
    }
}

fn minimal_tab(id: &str) -> serde_json::Value {
    json!({
        "id":id,"fileId":format!("file-{id}"),"path":"/missing/data.parquet","sqlDraft":"",
        "filters":[],"sorts":[],
        "viewState":{"scrollTop":0,"scrollLeft":0,"sidebarWidth":300,"editorHeight":180}
    })
}

#[test]
fn invalid_save_inputs_return_invalid_argument_without_replacing_previous_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = SessionStore::new(&path);
    let data = dir.path().join("data.parquet");
    fs::write(&data, b"x").unwrap();
    let valid = SessionSnapshot {
        version: 1,
        tabs: vec![tab("one", data.to_string_lossy().into_owned(), "ok".into())],
        active_tab_id: Some("one".into()),
    };
    store.save(&valid).unwrap();
    let original = fs::read(&path).unwrap();

    let mut invalid_cases = vec![
        SessionSnapshot {
            version: 2,
            ..valid.clone()
        },
        SessionSnapshot {
            tabs: vec![valid.tabs[0].clone(); 101],
            ..valid.clone()
        },
        SessionSnapshot {
            tabs: vec![valid.tabs[0].clone(), valid.tabs[0].clone()],
            ..valid.clone()
        },
        SessionSnapshot {
            active_tab_id: Some("missing".into()),
            ..valid.clone()
        },
    ];
    let mut empty_path = valid.clone();
    empty_path.tabs[0].path.clear();
    invalid_cases.push(empty_path);
    let mut long_sql = valid.clone();
    long_sql.tabs[0].sql_draft = "x".repeat(256 * 1024 + 1);
    invalid_cases.push(long_sql);

    for invalid in invalid_cases {
        assert!(matches!(
            store.save(&invalid),
            Err(AppError::InvalidArgument(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}

#[test]
fn oversized_session_is_bounded_on_write_and_recovers_safely_on_load() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = SessionStore::new(&path);
    let mut large = SessionSnapshot {
        version: 1,
        tabs: vec![],
        active_tab_id: None,
    };
    for index in 0..20 {
        large.tabs.push(tab(
            &format!("tab-{index}"),
            format!("/missing/{index}.parquet"),
            "x".repeat(220 * 1024),
        ));
    }
    assert!(matches!(
        store.save(&large),
        Err(AppError::InvalidArgument(_))
    ));

    fs::write(&path, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();
    let restored = store.load().unwrap();
    assert!(restored.snapshot.tabs.is_empty());
    assert_eq!(restored.warning.as_deref(), Some(SESSION_WARNING));
}

#[test]
fn concurrent_saves_leave_one_complete_snapshot() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = Arc::new(SessionStore::new(&path));
    let snapshots: Vec<_> = (0..16)
        .map(|index| SessionSnapshot {
            version: 1,
            tabs: vec![tab(
                &format!("tab-{index}"),
                format!("/missing/{index}.parquet"),
                format!("select {index}"),
            )],
            active_tab_id: Some(format!("tab-{index}")),
        })
        .collect();
    let handles: Vec<_> = snapshots
        .clone()
        .into_iter()
        .map(|snapshot| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || store.save(&snapshot).unwrap())
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }

    let persisted: SessionSnapshot = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(snapshots.contains(&persisted));
}

#[test]
fn overlapping_loads_observe_only_complete_old_or_new_snapshots() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = Arc::new(SessionStore::new(&path));
    let old = SessionSnapshot {
        version: 1,
        tabs: vec![tab(
            "old",
            "/missing/old.parquet".into(),
            "o".repeat(128 * 1024),
        )],
        active_tab_id: Some("old".into()),
    };
    let new = SessionSnapshot {
        version: 1,
        tabs: vec![tab(
            "new",
            "/missing/new.parquet".into(),
            "n".repeat(128 * 1024),
        )],
        active_tab_id: Some("new".into()),
    };
    store.save(&old).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let writer = {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        let old = old.clone();
        let new = new.clone();
        std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..100 {
                store.save(&new).unwrap();
                store.save(&old).unwrap();
            }
            store.save(&new).unwrap();
        })
    };
    barrier.wait();
    for _ in 0..500 {
        let restored = store.load().unwrap();
        assert_eq!(restored.warning, None);
        assert!(restored.snapshot == old || restored.snapshot == new);
    }
    writer.join().unwrap();
    assert_eq!(store.load().unwrap().snapshot, new);
}

#[test]
fn injected_atomic_failure_preserves_previous_valid_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = SessionStore::new(&path);
    let first = SessionSnapshot {
        version: 1,
        tabs: vec![],
        active_tab_id: None,
    };
    store.save(&first).unwrap();
    let original = fs::read(&path).unwrap();
    store.fail_next_replace_for_test();
    let second = SessionSnapshot {
        version: 1,
        tabs: vec![tab("two", "/missing/two.parquet".into(), "select 2".into())],
        active_tab_id: Some("two".into()),
    };
    assert!(matches!(store.save(&second), Err(AppError::Internal(_))));
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn windows_atomic_save_replaces_an_existing_session() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    let store = SessionStore::new(&path);
    let old = SessionSnapshot {
        version: 1,
        tabs: vec![],
        active_tab_id: None,
    };
    let new = SessionSnapshot {
        version: 1,
        tabs: vec![tab(
            "new",
            "C:\\missing\\new.parquet".into(),
            "select 2".into(),
        )],
        active_tab_id: Some("new".into()),
    };
    store.save(&old).unwrap();
    store.save(&new).unwrap();
    assert_eq!(store.load().unwrap().snapshot, new);
}

#[cfg(unix)]
#[test]
fn saved_session_is_user_only_on_unix() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("session.json");
    SessionStore::new(&path)
        .save(&SessionSnapshot {
            version: 1,
            tabs: vec![],
            active_tab_id: None,
        })
        .unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

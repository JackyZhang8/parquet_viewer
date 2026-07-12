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

# Parquet Viewer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform, read-only Tauri desktop application that opens multiple Parquet files in tabs, previews very large files without loading them into memory, supports filters and DuckDB SQL with completion, and exports query results to CSV.

**Architecture:** React owns presentation and per-tab UI state; focused Tauri commands expose Rust services for file metadata, query lifecycle, session persistence, and export. DuckDB scans Parquet directly, while a Rust cursor registry limits active queries and returns bounded batches to a virtualized grid.

**Tech Stack:** Tauri 2, Rust 2024, React 19, TypeScript, Vite, Vitest, Testing Library, TanStack Virtual, Monaco Editor, DuckDB, Serde, Tokio, UUID.

---

## File structure

```text
parquet_gui/
├── package.json                    # frontend scripts and dependencies
├── vite.config.ts                  # Vite and Vitest configuration
├── src/
│   ├── app/App.tsx                 # top-level workspace composition
│   ├── app/app.css                 # application shell and theme tokens
│   ├── domain/types.ts             # shared frontend contracts
│   ├── lib/tauri.ts                # typed Tauri command wrappers
│   ├── stores/workspace.ts         # tabs and per-file UI state
│   ├── features/open/DropZone.tsx  # empty state and drag/drop intake
│   ├── features/tabs/FileTabs.tsx  # file tab behavior
│   ├── features/schema/SchemaPanel.tsx
│   ├── features/query/filterSql.ts # visual-filter request builder
│   ├── features/query/FilterBar.tsx
│   ├── features/query/SqlEditor.tsx
│   ├── features/grid/DataGrid.tsx  # row/column virtualized result grid
│   ├── features/status/StatusBar.tsx
│   └── test/setup.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs                 # desktop entry point only
│       ├── lib.rs                  # command registration and AppState
│       ├── error.rs                # stable error codes and serialization
│       ├── models.rs               # IPC request/response types
│       ├── files.rs                # path validation and Parquet metadata
│       ├── filters.rs              # safe filter-to-SQL compiler
│       ├── query.rs                # DuckDB connection and cursor registry
│       ├── session.rs              # persisted tab/session state
│       └── export.rs               # CSV export task
└── tests/fixtures/                 # generated small and malformed fixtures
```

## Task 1: Scaffold a testable Tauri workspace

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `src/main.tsx`
- Create: `src/test/setup.ts`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Initialize version control before application changes**

Run: `git init && git add .gitignore docs && git commit -m "docs: add parquet viewer design and implementation plan"`

Expected: a new repository with the design and plan as the first commit.

- [ ] **Step 2: Add frontend dependencies and scripts**

Run `npm install react react-dom @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-fs @tauri-apps/plugin-opener @monaco-editor/react monaco-editor zustand @tanstack/react-virtual` and `npm install -D typescript vite @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom @tauri-apps/cli`. Add scripts `dev`, `build`, `test`, `test:watch`, and `tauri`; the generated lockfile is the exact dependency baseline.

- [ ] **Step 3: Add the minimal Tauri application**

Use this Rust boundary in `src-tauri/src/lib.rs`:

```rust
mod error;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run Parquet Viewer");
}
```

Use `src-tauri/src/main.rs` only to call `parquet_viewer_lib::run()`.

- [ ] **Step 4: Verify both toolchains**

Run: `npm test -- --run`

Expected: Vitest exits successfully with no tests.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: Rust compiles and reports zero failing tests.

- [ ] **Step 5: Commit**

Run: `git add package.json package-lock.json vite.config.ts src src-tauri && git commit -m "chore: scaffold tauri react workspace"`

## Task 2: Define stable IPC contracts and errors

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/models.rs`
- Create: `src/domain/types.ts`
- Test: `src-tauri/src/error.rs`

- [ ] **Step 1: Write failing serialization tests**

Add Rust tests asserting that `AppError::InvalidParquet("bad footer".into())` serializes to:

```json
{"code":"INVALID_PARQUET","message":"bad footer","detail":null}
```

Also test camelCase output for `FileMetadata`, `ColumnSchema`, `QueryBatch`, and `SessionSnapshot`.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml error::tests models::tests`

Expected: FAIL because the error and model types do not exist.

- [ ] **Step 3: Implement shared contracts**

Define these core Rust types and matching TypeScript interfaces:

```rust
pub struct FileMetadata { pub file_id: String, pub path: String, pub name: String,
    pub size_bytes: u64, pub row_count: u64, pub row_group_count: u64,
    pub columns: Vec<ColumnSchema> }
pub struct ColumnSchema { pub name: String, pub logical_type: String, pub nullable: bool }
pub struct QueryRequest { pub file_id: String, pub sql: String, pub batch_size: u32,
    pub preview_limit: u64 }
pub struct QueryStarted { pub query_id: String, pub columns: Vec<ColumnSchema> }
pub struct QueryBatch { pub query_id: String, pub rows: Vec<Vec<serde_json::Value>>,
    pub done: bool, pub returned_rows: u64, pub elapsed_ms: u64 }
```

Implement `AppError` variants for invalid path, permission denied, invalid Parquet, stale file, SQL, cancelled, resource exhausted, and internal error. Convert every command result through `Result<T, AppError>`.

- [ ] **Step 4: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all serialization tests PASS.

Run: `git add src/domain src-tauri/src && git commit -m "feat: define ipc contracts and stable errors"`

## Task 3: Open Parquet files and read metadata lazily

**Files:**
- Create: `src-tauri/src/files.rs`
- Create: `tests/fixtures/generate.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Test: `src-tauri/src/files.rs`

- [ ] **Step 1: Add fixture generation and failing metadata tests**

Generate a small fixture with three columns (`id`, `name`, `created_at`), two row groups, and ten rows. Test that `read_metadata()` returns ten rows and two row groups without returning any row data. Add tests for a non-Parquet file and a truncated footer.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml files::tests`

Expected: FAIL because `read_metadata` is undefined.

- [ ] **Step 3: Implement `FileRegistry` and metadata reading**

Use canonical paths to deduplicate files. Store a fingerprint containing canonical path, size, and modified time. Open the DuckDB Parquet reader only for footer/schema metadata and return a UUID file ID. Do not execute `COUNT(*)`; derive total rows from Parquet metadata.

Expose commands:

```rust
#[tauri::command]
async fn open_files(paths: Vec<String>, state: State<'_, AppState>)
    -> Result<Vec<FileMetadata>, AppError>;

#[tauri::command]
async fn reload_file(file_id: String, state: State<'_, AppState>)
    -> Result<FileMetadata, AppError>;
```

- [ ] **Step 4: Verify lazy behavior and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml files::tests`

Expected: valid metadata tests pass; corrupt fixtures return `INVALID_PARQUET`.

Run: `git add src-tauri tests && git commit -m "feat: open parquet files and read metadata"`

## Task 4: Compile visual filters safely

**Files:**
- Create: `src-tauri/src/filters.rs`
- Modify: `src-tauri/src/models.rs`
- Test: `src-tauri/src/filters.rs`

- [ ] **Step 1: Write injection-focused failing tests**

Test string equality, numeric ranges, null checks, text contains, three-field sorting, a column named `order value`, and a malicious value such as `' OR 1=1 --`. Assert that values appear only in bound parameters and identifiers are double-quoted.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml filters::tests`

Expected: FAIL because `compile_filter_query` is undefined.

- [ ] **Step 3: Implement the compiler**

Define `FilterCondition`, `FilterOperator`, `SortSpec`, and `BoundValue`. Compile only whitelisted operators. Reject unknown columns using the active file schema. Emit SQL shaped as:

```sql
SELECT * FROM read_parquet(?)
WHERE "status" = ? AND "amount" > ?
ORDER BY "created_at" DESC
LIMIT ?
```

Keep the file path and all values as parameters; only validated, escaped identifiers may be interpolated.

- [ ] **Step 4: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml filters::tests`

Expected: all compiler and injection tests PASS.

Run: `git add src-tauri/src && git commit -m "feat: compile typed filters to safe sql"`

## Task 5: Execute bounded queries with cancellable cursors

**Files:**
- Create: `src-tauri/src/query.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Test: `src-tauri/src/query.rs`

- [ ] **Step 1: Write failing lifecycle tests**

Cover starting `SELECT * FROM data`, fetching batches of three rows, reaching `done`, cancelling before the next fetch, replacing a query for the same tab, rejecting SQL that references unapproved external paths, and releasing cursors when a file closes.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml query::tests`

Expected: FAIL because `QueryService` does not exist.

- [ ] **Step 3: Implement query isolation and cursor registry**

For each query, rewrite only the controlled virtual relation `data` to `read_parquet(?)`. Disable DuckDB external access and extension auto-installation. Apply memory limit, thread limit, temporary directory, and preview limit before execution. Keep a cursor plus cancellation handle under a UUID query ID.

Expose:

```rust
start_query(request) -> QueryStarted
fetch_query_batch(query_id) -> QueryBatch
cancel_query(query_id) -> ()
close_file(file_id) -> ()
```

Limit active queries to two with a semaphore. New queries for the same file cancel the prior interactive query.

- [ ] **Step 4: Verify resource cleanup**

Run: `cargo test --manifest-path src-tauri/Cargo.toml query::tests`

Expected: cursor, cancellation, external-access, and concurrency tests PASS.

- [ ] **Step 5: Commit**

Run: `git add src-tauri/src && git commit -m "feat: add cancellable batched query service"`

## Task 6: Persist and restore tab sessions without rerunning queries

**Files:**
- Create: `src-tauri/src/session.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Test: `src-tauri/src/session.rs`

- [ ] **Step 1: Write failing round-trip tests**

Persist two ordered tabs with active tab ID, SQL drafts, filter state, sort state, and panel widths. Assert that query IDs, result rows, and running state are absent. Test a missing file restores as `unavailable` rather than deleting the tab.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session::tests`

Expected: FAIL because the session store is missing.

- [ ] **Step 3: Implement atomic persistence**

Write JSON to a temporary sibling and atomically rename it into the application config directory. Expose `load_session` and `save_session`. Validate paths during load but never open data or execute SQL.

- [ ] **Step 4: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session::tests`

Expected: round-trip, missing-file, and corrupt-session recovery tests PASS.

Run: `git add src-tauri/src && git commit -m "feat: persist safe workspace sessions"`

## Task 7: Build workspace state, drag/drop, and file tabs

**Files:**
- Create: `src/lib/tauri.ts`
- Create: `src/stores/workspace.ts`
- Create: `src/features/open/DropZone.tsx`
- Create: `src/features/tabs/FileTabs.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/app.css`
- Test: `src/stores/workspace.test.ts`
- Test: `src/features/tabs/FileTabs.test.tsx`

- [ ] **Step 1: Write failing UI-state tests**

Test adding multiple files, canonical-ID deduplication, tab activation, close-other, close-right, independent SQL drafts, and restoration that does not call `startQuery`.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run src/stores/workspace.test.ts src/features/tabs/FileTabs.test.tsx`

Expected: FAIL because the store and components are absent.

- [ ] **Step 3: Implement typed command wrappers and Zustand store**

Keep one `TabState` per file with metadata, draft, filters, sorts, view position, and result status. Result rows stay outside persisted state. Debounce `saveSession` after serializable changes.

- [ ] **Step 4: Implement the empty state and tabs**

Handle Tauri file-drop events and a native multi-file picker. Implement tab overflow, accessible keyboard navigation, context actions, duplicate focus, loading state, unavailable-file state, and “show in file manager.”

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run`

Expected: workspace and tab tests PASS.

Run: `git add src && git commit -m "feat: add drag drop workspace and file tabs"`

## Task 8: Add schema panel and typed filter UI

**Files:**
- Create: `src/features/schema/SchemaPanel.tsx`
- Create: `src/features/query/filterSql.ts`
- Create: `src/features/query/FilterBar.tsx`
- Test: `src/features/query/FilterBar.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Test field search, type display, text/numeric/date operator menus, adding and removing AND conditions, maximum three sort fields, and producing the exact `FilterQueryRequest` expected by Rust.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run src/features/query/FilterBar.test.tsx`

Expected: FAIL because the schema and filter components are absent.

- [ ] **Step 3: Implement schema and filters**

Map DuckDB logical types into text, number, boolean, date/time, binary, and nested UI families. Keep operators type-specific. Send structured filter objects to Rust; never construct executable SQL from user values in the browser.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- --run src/features/query/FilterBar.test.tsx`

Expected: all schema and filter interactions PASS.

Run: `git add src/features && git commit -m "feat: add schema browser and typed filters"`

## Task 9: Render batched results in a virtual grid

**Files:**
- Create: `src/features/grid/DataGrid.tsx`
- Create: `src/features/grid/valueFormat.ts`
- Create: `src/features/status/StatusBar.tsx`
- Test: `src/features/grid/DataGrid.test.tsx`
- Test: `src/features/grid/valueFormat.test.ts`

- [ ] **Step 1: Write failing formatting and loading tests**

Cover null versus empty string, long-text truncation, timestamp display, binary placeholder, nested JSON display, fetching the next batch near the scroll boundary, stopping at `done`, cancelling on tab close, and showing an explicit truncated-result notice.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run src/features/grid`

Expected: FAIL because grid modules are absent.

- [ ] **Step 3: Implement row and column virtualization**

Use TanStack Virtual for visible rows and columns. Append only bounded batches and cap browser-held preview rows at the configured preview limit. Support fixed headers, resize, hide, copy cell/row/selection, and full-value read-only popover.

- [ ] **Step 4: Integrate query status and cancellation**

Display queued/running/done/cancelled/error states, elapsed time, returned rows, truncation, and stop action. Preserve the last successful result after a syntax error but mark it stale.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run src/features/grid src/features/status`

Expected: grid batching, formatting, and cancellation tests PASS.

Run: `git add src/features && git commit -m "feat: add virtualized batched data grid"`

## Task 10: Add SQL editor and context-aware completion

**Files:**
- Create: `src/features/query/SqlEditor.tsx`
- Create: `src/features/query/sqlCompletion.ts`
- Test: `src/features/query/sqlCompletion.test.ts`
- Test: `src/features/query/SqlEditor.test.tsx`

- [ ] **Step 1: Write failing completion tests**

Assert `data` table completion after `FROM`, field-first suggestions after `SELECT`, `WHERE`, and `ORDER BY`, safe quoted insertion for `order value`, fuzzy matching, function snippets, and no fields from inactive tabs.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run src/features/query/sqlCompletion.test.ts`

Expected: FAIL because completion generation is absent.

- [ ] **Step 3: Implement Monaco integration**

Register one completion provider that derives suggestions from the active tab schema. Include common DuckDB keywords, aggregate/scalar/date functions, the fixed `data` table, field type icons, hover type information, Run shortcut, format shortcut, and line/column error markers.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- --run src/features/query`

Expected: filter and SQL editor tests PASS.

Run: `git add src/features/query && git commit -m "feat: add sql editor and schema completion"`

## Task 11: Export complete query results to CSV

**Files:**
- Create: `src-tauri/src/export.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/features/status/StatusBar.tsx`
- Test: `src-tauri/src/export.rs`

- [ ] **Step 1: Write failing export tests**

Test CSV headers, commas/quotes/newlines, null values, export beyond preview limit, cancellation, overwrite rejection, and cleanup of partial temporary files after errors.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml export::tests`

Expected: FAIL because export tasks are absent.

- [ ] **Step 3: Implement backend-only streaming export**

Run a fresh validated query using DuckDB `COPY (...) TO ? (FORMAT CSV, HEADER)` or an equivalent streaming writer. Write to a temporary sibling, emit progress events, rename only on success, and remove the temporary file on cancel/error.

- [ ] **Step 4: Connect native save dialog and status UI**

The frontend selects a destination, confirms overwrite, starts export, displays progress, and exposes cancel. Never route exported rows through JavaScript.

- [ ] **Step 5: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml export::tests`

Expected: all export and cleanup tests PASS.

Run: `npm test -- --run`

Expected: export UI tests PASS.

Run: `git add src src-tauri && git commit -m "feat: export query results to csv"`

## Task 12: Harden resources, permissions, and cross-platform behavior

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/query.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src/features/settings/SettingsDialog.tsx`
- Test: `src-tauri/src/settings.rs`

- [ ] **Step 1: Write failing limit tests**

Test defaults for batch size 500, preview limit 10,000, concurrency two, memory cap calculation, invalid temporary directory, low-disk warning threshold, and clamping unsafe settings.

- [ ] **Step 2: Confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::tests`

Expected: FAIL because settings validation is absent.

- [ ] **Step 3: Implement settings and least-privilege capabilities**

Persist only theme, batch size, preview limit, memory limit, temp directory, disk warning, concurrency, and restore-tabs preference. Grant filesystem access only through user-selected paths and application config/temp locations. Do not enable shell execution or arbitrary network access.

- [ ] **Step 4: Add platform-path tests and application safeguards**

Test Unicode, spaces, Windows drive paths, UNC-like inputs, symlinks, deleted files, and files replaced after metadata load. Recheck fingerprints before query and return `STALE_FILE` on mismatch.

- [ ] **Step 5: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

Run: `npm test -- --run && npm run build`

Expected: all frontend tests pass and Vite production build succeeds.

Run: `git add src src-tauri && git commit -m "feat: harden resource and platform settings"`

## Task 13: End-to-end verification and release baseline

**Files:**
- Create: `docs/testing.md`
- Create: `scripts/generate-benchmark-data.sh`
- Create: `README.md`

- [ ] **Step 1: Document reproducible fixtures and benchmarks**

Document commands to generate small typed fixtures, corrupt fixtures, a wide-schema fixture, and a configurable large fixture. Record machine RAM, CPU, storage type, file compression, row-group size, and file size with every benchmark.

- [ ] **Step 2: Run the complete automated suite**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: no formatting diff.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

Expected: no warnings.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

Run: `npm test -- --run && npm run build`

Expected: all frontend tests pass and production assets build.

- [ ] **Step 3: Run desktop smoke tests on all target platforms**

On macOS, Windows, and Linux verify multi-file drag/drop, native picker, Unicode paths, session restoration without query execution, filter query, SQL completion, cancellation, CSV export, reveal-in-file-manager, and missing-file recovery.

- [ ] **Step 4: Measure large-file behavior**

With a dataset larger than available RAM, record metadata-open time, first-batch time, peak application memory, temporary-disk usage, cancellation latency, and memory after closing the tab. Pass only if memory does not grow linearly with file size and closes return cursor/resource counts to zero.

- [ ] **Step 5: Build release artifacts and commit documentation**

Run on each platform: `npm run tauri build`

Expected: signed or locally installable platform artifact is produced without runtime dependency on an external DuckDB installation.

Run: `git add README.md docs scripts && git commit -m "docs: add verification and release baseline"`

## Final acceptance checklist

- [ ] Multiple local Parquet files open into isolated tabs and duplicate paths focus the existing tab.
- [ ] Footer/schema metadata appears without scanning all rows.
- [ ] Preview queries return bounded batches and avoid high-offset pagination.
- [ ] Filters use validated identifiers and parameter-bound values.
- [ ] SQL can access only the current file through `data`; external access is disabled.
- [ ] Query cancellation, tab close, and app shutdown release cursors and temporary resources.
- [ ] Virtual scrolling remains responsive at the 10,000-row browser preview cap.
- [ ] Completion includes current schema, `data`, keywords, and common DuckDB functions.
- [ ] Session restoration never automatically executes SQL.
- [ ] CSV export streams in the backend and cleans partial files.
- [ ] macOS, Windows, and Linux builds pass smoke tests.

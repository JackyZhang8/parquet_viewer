# Parquet Viewer

Parquet Viewer is a cross-platform, read-only desktop application for inspecting and querying local Parquet files. It uses Tauri 2, React, Rust, embedded DuckDB, Monaco Editor, and a row/column virtualized grid.

## Features

- Open or drag multiple `.parquet` files into isolated tabs.
- Read footer metadata and schema without loading the complete file.
- Preview large files through bounded batches and virtual scrolling.
- Build typed filters and up to three sort keys without writing SQL.
- Run read-only DuckDB SQL against the current file through the fixed `data` table.
- Complete SQL keywords, DuckDB functions, and current schema fields.
- Cancel queries and exports; closing a tab or exiting releases related work.
- Export the complete filter or SQL result directly to CSV in the Rust backend.
- Restore tabs, SQL drafts, filters, sorts, and layout without rerunning queries.
- Configure theme, preview/batch limits, memory, temporary storage, disk warning, concurrency, and startup restoration.

The original Parquet files are never edited or replaced.

## Development

Requirements:

- Node.js 20 or newer
- Rust stable
- Platform prerequisites from the [Tauri 2 prerequisites guide](https://v2.tauri.app/start/prerequisites/)

```bash
npm ci
npm test -- --run
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

Production checks:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm test -- --run
npm run build
npm run tauri build
```

Generated installers and application bundles are written below `src-tauri/target/release/bundle/`. The macOS baseline emits a locally installable `.app`; distribution DMGs can be produced later in a signed/notarized release environment.

## Benchmark fixtures

Generate typed, malformed, wide, and configurable large fixtures:

```bash
./scripts/generate-benchmark-data.sh
ROWS=100000000 OUTPUT_DIR=/path/to/fixtures ./scripts/generate-benchmark-data.sh
```

See [docs/testing.md](docs/testing.md) for automated checks, platform smoke tests, and the benchmark recording template.

## Security model

- SQL accepts exactly one read-only `SELECT`/`WITH` query.
- User SQL can read only the current file through `data`.
- DuckDB external access and extension auto-loading are disabled.
- Filter values and file paths are bound parameters; identifiers are validated and quoted.
- Query batches and IPC payloads have explicit row, column, nesting, string, and encoded-size limits.
- CSV export writes to a temporary sibling and only replaces the destination after success.
- Tauri capabilities grant only native open/save/confirmation dialogs and reveal-in-file-manager.

## Scope

The MVP intentionally excludes editing, remote data sources, directory datasets, cross-tab joins, charting, notebooks, and ETL workflows.

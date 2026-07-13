# Testing and release verification

## Automated suite

Run from the repository root:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm test -- --run
npm run build
npm run tauri build
```

The GitHub Actions workflow runs frontend and Rust checks on macOS, Windows, and Linux, builds the desktop application on every platform, and uploads unsigned local artifacts.

## Reproducible fixtures

```bash
./scripts/generate-benchmark-data.sh
```

Environment variables:

- `OUTPUT_DIR`: destination directory; defaults to `tests/generated`.
- `ROWS`: number of rows in `large.parquet`; defaults to `1000000`.

Generated files:

- `typed-small.parquet`: scalar, decimal, boolean, date, timestamp, null, text, and nested values.
- `wide-schema.parquet`: 256 data columns for horizontal virtualization and completion testing.
- `large.parquet`: ZSTD-compressed configurable data with explicit row groups.
- `corrupt-footer.parquet`: invalid footer bytes.
- `truncated.parquet`: a valid Parquet file with a truncated footer.

For a dataset larger than RAM, choose a row count appropriate for the data width and machine:

```bash
ROWS=250000000 OUTPUT_DIR=/fast-disk/parquet-viewer-fixtures ./scripts/generate-benchmark-data.sh
```

## Desktop smoke test

Run this checklist separately on macOS, Windows, and Linux using the locally built artifact:

1. Open multiple files through the native picker and drag/drop.
2. Verify a duplicate path focuses the existing tab.
3. Open paths containing spaces, Unicode characters, and platform-specific separators.
4. Verify schema, row count, row groups, file size, and field search.
5. Run a typed filter and a three-key sort.
6. Run SQL with schema completion, formatting, and a deliberate syntax error.
7. Cancel a long query and confirm the UI returns to an interactive state.
8. Export a result larger than the preview limit, verify CSV escaping, and cancel a second export.
9. Close a tab during a query/export and verify partial export files are absent.
10. Restart the application and verify tabs/drafts restore without automatic execution.
11. Remove a restored file and verify the unavailable-file recovery state.
12. Reveal a file in Finder, Explorer, or the Linux file manager.
13. Change theme and resource settings, restart, and verify persistence.

Record the artifact name, OS/version, architecture, and pass/fail result for every run.

## Large-file benchmark

Record all of the following so results are comparable:

| Field | Value |
| --- | --- |
| Date / commit | |
| OS / architecture | |
| CPU | |
| RAM | |
| Storage type | |
| Parquet file size | |
| Row count | |
| Column count | |
| Compression | |
| Row-group size | |
| Configured memory limit | |
| Configured concurrency | |

Measure:

| Metric | Result |
| --- | --- |
| Metadata-open time | |
| First-batch time | |
| Peak application memory | |
| Peak temporary-disk usage | |
| Filtered first-batch time | |
| Cancellation latency | |
| Memory after closing the tab | |
| Active cursor/export count after close | |

Pass criteria:

- Opening metadata does not scan row data or allocate in proportion to file size.
- Browser-held preview rows never exceed the configured limit.
- Memory does not grow linearly with total Parquet file size.
- Query and export cancellation complete without leaving misleading final files.
- Closing a tab or exiting returns query/export registries to zero.

## Release notes

Release artifacts are unsigned unless platform signing credentials are provided. The macOS baseline produces a `.app` instead of invoking Finder-dependent DMG decoration, which is unreliable in headless automation. Signing, notarization, and a distribution DMG are release-channel steps; they are not required for local installability checks.

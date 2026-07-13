#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/tests/generated}"
ROWS="${ROWS:-1000000}"

mkdir -p "$OUTPUT_DIR"
cargo run --release --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml" --example generate_benchmark_data -- "$OUTPUT_DIR" "$ROWS"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "This script cross-compiles a Windows executable from macOS." >&2
    exit 1
    ;;
esac

for command in node npm cargo rustup; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

# Homebrew's Rust toolchain may not contain the Windows standard library that
# rustup installs, so make Tauri and cargo-xwin use the rustup-managed toolchain.
RUSTUP_CARGO="$(rustup which cargo)"
export PATH="$(dirname "$RUSTUP_CARGO"):$PATH"

if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "Installing cargo-xwin for Windows cross-compilation..."
  cargo install cargo-xwin --locked
fi

if ! command -v clang-cl >/dev/null 2>&1; then
  for llvm_bin in /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin; do
    if [[ -x "$llvm_bin/clang-cl" ]]; then
      export PATH="$llvm_bin:$PATH"
      break
    fi
  done
fi

if ! command -v clang-cl >/dev/null 2>&1; then
  echo "Missing clang-cl. Install LLVM with: brew install llvm" >&2
  exit 1
fi

if [[ ! -f src-tauri/icons/icon.ico ]]; then
  echo "Missing Windows application icon: src-tauri/icons/icon.ico" >&2
  exit 1
fi

echo "Installing frontend dependencies..."
npm ci

echo "Preparing the Windows SDK and Rust target..."
rustup target add x86_64-pc-windows-msvc
xwin_env="$(cargo xwin env --target x86_64-pc-windows-msvc --quiet)"
eval "$xwin_env"

# Tauri's macOS Objective-C dependencies require unwinding, but the portable
# Windows release executable can omit unwind support to reduce its size.
export RUSTFLAGS="${RUSTFLAGS:-} -C panic=abort"

echo "Cross-compiling the Windows executable with src-tauri/icons/icon.ico..."
npm run tauri -- build --target x86_64-pc-windows-msvc --no-bundle

executable="src-tauri/target/x86_64-pc-windows-msvc/release/parquet-viewer.exe"
if [[ ! -f "$executable" ]]; then
  echo "Build completed, but the Windows executable was not found: $executable" >&2
  exit 1
fi

echo
echo "Windows executable created:"
printf '  %s\n' "$executable"

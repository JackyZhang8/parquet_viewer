import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'

const root = process.cwd()
const script = readFileSync(resolve(root, 'build-win.sh'), 'utf8')
const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const filesSource = readFileSync(resolve(root, 'src-tauri/src/files.rs'), 'utf8')
const mainSource = readFileSync(resolve(root, 'src-tauri/src/main.rs'), 'utf8')

test('macOS build script cross-compiles a standalone Windows executable', () => {
  assert.match(script, /^#!\/usr\/bin\/env bash/m)
  assert.match(script, /set -euo pipefail/)
  assert.match(script, /Darwin/)
  assert.match(script, /rustup which cargo/)
  assert.match(script, /cargo xwin env --target x86_64-pc-windows-msvc/)
  assert.match(script, /npm ci/)
  assert.match(script, /npm run tauri -- build --target x86_64-pc-windows-msvc --no-bundle/)
  assert.match(script, /src-tauri\/icons\/icon\.ico/)
  assert.match(script, /src-tauri\/target\/x86_64-pc-windows-msvc\/release\/parquet-viewer\.exe/)
  assert.doesNotMatch(script, /wine/)
  assert.doesNotMatch(script, /--bundles nsis/)
  assert.doesNotMatch(script, /bundle\/nsis/)
  assert.ok(config.bundle.icon.includes('icons/icon.ico'))
})

test('Windows file fingerprints avoid unstable std metadata APIs', () => {
  assert.doesNotMatch(filesSource, /metadata\.volume_serial_number\(\)/)
  assert.doesNotMatch(filesSource, /metadata\.file_index\(\)/)
  assert.match(filesSource, /GetFileInformationByHandle/)
  assert.match(filesSource, /GetFileInformationByHandle\(file\.as_raw_handle\(\), &mut information\)/)
})

test('Windows release builds use the GUI subsystem without hiding debug diagnostics', () => {
  assert.match(
    mainSource,
    /#!\[cfg_attr\(\s*all\(target_os = "windows", not\(debug_assertions\)\),\s*windows_subsystem = "windows"\s*\)\]/s,
  )
})

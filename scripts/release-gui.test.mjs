import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const workflowPath = resolve(process.cwd(), '.github/workflows/release-gui.yml')
const workflow = (() => {
  try {
    return readFileSync(workflowPath, 'utf8')
  } catch {
    return ''
  }
})()

test('GUI release workflow builds all supported desktop bundles', () => {
  assert.notEqual(workflow, '', 'release-gui.yml must exist')
  assert.match(workflow, /tags:\s*\n\s+- ["']parquet-gui-v\*["']/)
  assert.match(workflow, /aarch64-apple-darwin/)
  assert.match(workflow, /x86_64-apple-darwin/)
  assert.match(workflow, /x86_64-unknown-linux-gnu/)
  assert.match(workflow, /x86_64-pc-windows-msvc/)
  assert.match(workflow, /bundles: app,dmg/)
  assert.match(workflow, /bundles: deb,appimage/)
  assert.match(workflow, /bundles: msi,nsis/)
})

test('GUI release workflow validates and publishes the requested version', () => {
  assert.match(workflow, /Check project versions/)
  assert.match(workflow, /src-tauri\/tauri\.conf\.json/)
  assert.match(workflow, /src-tauri\/Cargo\.toml/)
  assert.match(workflow, /package\.json/)
  assert.match(workflow, /softprops\/action-gh-release@v2/)
  assert.match(workflow, /SHA256SUMS/)
})

test('manual release input is passed to the shell through the environment', () => {
  assert.match(workflow, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/)
  assert.match(workflow, /raw="\$DISPATCH_VERSION"/)
  assert.doesNotMatch(workflow, /raw="\$\{\{ inputs\.version \}\}"/)
})

test('macOS release workflow supports Developer ID signing and notarization', () => {
  assert.match(workflow, /APPLE_CERTIFICATE/)
  assert.match(workflow, /APPLE_CERTIFICATE_PASSWORD/)
  assert.match(workflow, /APPLE_SIGNING_IDENTITY/)
  assert.match(workflow, /APPLE_ID/)
  assert.match(workflow, /APPLE_APP_PASSWORD/)
  assert.match(workflow, /APPLE_TEAM_ID/)
  assert.match(workflow, /Developer ID Application/)
})

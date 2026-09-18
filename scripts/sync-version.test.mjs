import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { syncVersion } from './sync-version.mjs'

for (const newline of ['\n', '\r\n']) {
test(`version synchronization preserves ${JSON.stringify(newline)} line endings and dependency versions`, () => {
  const root = mkdtempSync(join(tmpdir(), 'parquet-version-'))
  try {
    mkdirSync(join(root, 'src-tauri'))
    const write = (path, value) => writeFileSync(join(root, path), value.replace(/\n/g, newline))
    const read = (path) => readFileSync(join(root, path), 'utf8')
    write('package.json', JSON.stringify({ name: 'parquet-viewer', version: '2.3.4' }))
    write('package-lock.json', JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/example': { version: '1.0.0' } } }))
    write('src-tauri/Cargo.toml', '[package]\nname = "parquet-viewer"\nversion = "0.1.0"\n\n[dependencies]\nexample = "1.0.0"\n')
    write('src-tauri/Cargo.lock', 'version = 4\n\n[[package]]\nname = "parquet-viewer"\nversion = "0.1.0"\n\n[[package]]\nname = "example"\nversion = "1.0.0"\n')
    syncVersion(root)
    assert.match(read('src-tauri/Cargo.toml'), /version = "2.3.4"/)
    assert.match(read('src-tauri/Cargo.toml'), /example = "1.0.0"/)
    assert.match(read('src-tauri/Cargo.lock'), /name = "example"\r?\nversion = "1.0.0"/)
    assert.match(read('src-tauri/Cargo.lock'), /name = "parquet-viewer"\r?\nversion = "2.3.4"/)
    const lock = JSON.parse(read('package-lock.json'))
    assert.equal(lock.version, '2.3.4')
    assert.equal(lock.packages[''].version, '2.3.4')
    assert.equal(lock.packages['node_modules/example'].version, '1.0.0')
    for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      assert.ok(read(file).includes(newline))
      if (newline === '\r\n') assert.doesNotMatch(read(file), /(?<!\r)\n/)
    }
    const before = read('src-tauri/Cargo.lock')
    syncVersion(root)
    assert.equal(read('src-tauri/Cargo.lock'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
}

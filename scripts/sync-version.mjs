import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function syncVersion(root) {
  const read = (file) => readFileSync(resolve(root, file), 'utf8')
  const write = (file, content) => {
    if (read(file) !== content) writeFileSync(resolve(root, file), content)
  }
  const { version, name } = JSON.parse(read('package.json'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package.json version: ${version}`)
  }
  const manifest = read('src-tauri/Cargo.toml')
  const updated = manifest.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, `$1"${version}"`)
  if (updated === manifest && !manifest.includes(`version = "${version}"`)) {
    throw new Error('Cargo package version was not found')
  }
  const cargoLock = read('src-tauri/Cargo.lock')
  const blocks = cargoLock.split('[[package]]')
  const index = blocks.findIndex((block) => block.includes(`\nname = "${name}"\n`))
  if (index < 0) throw new Error('Application package was not found in Cargo.lock')
  blocks[index] = blocks[index].replace(/\nversion = "[^"]+"/, `\nversion = "${version}"`)
  const npmLock = JSON.parse(read('package-lock.json'))
  npmLock.version = version
  npmLock.packages[''].version = version
  write('src-tauri/Cargo.toml', updated)
  write('src-tauri/Cargo.lock', blocks.join('[[package]]'))
  write('package-lock.json', JSON.stringify(npmLock, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncVersion(fileURLToPath(new URL('../', import.meta.url)))
}

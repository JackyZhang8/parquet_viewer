import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const projectRoot = path.resolve(import.meta.dirname, '..')

async function fixture({ nodeModules = true, npmLock = true, projectLockNewer = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'parquet-viewer-dev-test-'))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npm.log')
  await mkdir(bin)
  await cp(path.join(projectRoot, 'dev.sh'), path.join(root, 'dev.sh'))
  await chmod(path.join(root, 'dev.sh'), 0o755)
  await writeFile(path.join(root, 'package-lock.json'), '{}\n')
  if (nodeModules) await mkdir(path.join(root, 'node_modules'))
  if (nodeModules && npmLock) await writeFile(path.join(root, 'node_modules', '.package-lock.json'), '{}\n')
  if (nodeModules && npmLock && projectLockNewer) {
    const old = new Date(Date.now() - 60_000)
    const recent = new Date()
    await utimes(path.join(root, 'node_modules', '.package-lock.json'), old, old)
    await utimes(path.join(root, 'package-lock.json'), recent, recent)
  }
  await writeFile(path.join(bin, 'cargo'), '#!/usr/bin/env bash\nexit 0\n')
  await writeFile(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s" "${2:-1420}"\n')
  await writeFile(path.join(bin, 'npm'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [[ "\${1:-}" == "ci" ]]; then mkdir -p node_modules; touch node_modules/.package-lock.json; fi\nexit 0\n`)
  await chmod(path.join(bin, 'cargo'), 0o755)
  await chmod(path.join(bin, 'node'), 0o755)
  await chmod(path.join(bin, 'npm'), 0o755)
  return { root, log, bin }
}

async function run(options, port = 31_420) {
  const setup = await fixture(options)
  const result = spawnSync(path.join(setup.root, 'dev.sh'), [], {
    cwd: setup.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${setup.bin}:${process.env.PATH}`, PARQUET_VIEWER_DEV_PORT: String(port) },
  })
  const log = await readFile(setup.log, 'utf8').catch(() => '')
  return { ...setup, result, log }
}

test('installs dependencies when node_modules is missing', async () => {
  const { result, log } = await run({ nodeModules: false })
  assert.equal(result.status, 0, result.stderr)
  assert.match(log, /^ci$/m)
})

test('installs dependencies when npm hidden lockfile is missing', async () => {
  const { result, log } = await run({ npmLock: false }, 31_421)
  assert.equal(result.status, 0, result.stderr)
  assert.match(log, /^ci$/m)
})

test('installs dependencies when package-lock.json is newer than npm hidden lockfile', async () => {
  const { result, log } = await run({ projectLockNewer: true }, 31_422)
  assert.equal(result.status, 0, result.stderr)
  assert.match(log, /^ci$/m)
})

test('keeps strict-port configuration when dependencies are current', async () => {
  const { result, log } = await run({}, 31_423)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(log, /^ci$/m)
  assert.match(log, /npm run dev -- --port 31423 --strictPort/)
})

test('rejects an invalid configured port', async () => {
  const setup = await fixture()
  const result = spawnSync(path.join(setup.root, 'dev.sh'), [], {
    cwd: setup.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${setup.bin}:${process.env.PATH}`, PARQUET_VIEWER_DEV_PORT: 'invalid' },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must be an integer between 1 and 65535/)
})

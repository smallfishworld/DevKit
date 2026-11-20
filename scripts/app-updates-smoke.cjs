const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')

const root = resolve(__dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'devkit-app-updates-ui-'))
try {
  const outfile = join(dir, 'fixture.cjs')
  buildSync({
    entryPoints: [join(root, 'tests/probes/app-updates-ui-smoke.ts')],
    bundle: true, platform: 'node', outfile, external: ['electron'], logLevel: 'error'
  })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'devkit-app-updates-ui-fixture', version: '0.2.0', main: 'fixture.cjs'
  }))
  const flags = process.platform === 'linux' ? ['--no-sandbox'] : []
  const result = spawnSync(require('electron'), [...flags, dir], {
    cwd: root, stdio: 'inherit', timeout: 45_000,
    env: { ...process.env, DEVKIT_SMOKE_USER_DATA: dir }
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error('Electron fixture exited on ' + result.signal)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

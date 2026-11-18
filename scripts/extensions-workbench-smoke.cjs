const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')

const root = resolve(__dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'devkit-extensions-ui-'))
try {
  const output = join(dir, 'fixture.cjs')
  buildSync({
    entryPoints: [join(root, 'tests/probes/extensions-workbench-ui-smoke.ts')],
    bundle: true, platform: 'node', outfile: output, external: ['electron'],
    alias: { serialport: join(root, 'tests/terminal-serial-mock.js') }, logLevel: 'error'
  })
  const flags = process.platform === 'linux' ? ['--no-sandbox'] : []
  const result = spawnSync(require('electron'), [...flags, output, dir], {
    cwd: root, stdio: 'inherit', timeout: 90_000
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(dir, { recursive: true, force: true }) }

const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')

const root = resolve(__dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'devkit-debug-ui-'))
try {
  const output = join(dir, 'fixture.cjs')
  buildSync({
    entryPoints: [join(root, 'tests/probes/debug-unlock-ui-smoke.ts')], bundle: true,
    platform: 'node', outfile: output, external: ['electron'],
    alias: { serialport: join(root, 'tests/terminal-serial-mock.js') }, logLevel: 'error'
  })
  const result = spawnSync(require('electron'), [output, dir], { cwd: root, stdio: 'inherit', timeout: 60_000 })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`模拟 Electron 进程退出信号：${result.signal}`)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

'use strict'
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')
const { pack } = require('./package-device-plugin.cjs')
const root = resolve(__dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'devkit-plugins-ui-'))
try {
  const output = join(dir, 'fixture.cjs')
  pack(join(root, 'examples/plugins/text-hex-responder'), join(dir, 'responder.json'))
  buildSync({
    entryPoints: [join(root, 'tests/probes/plugins-ui-smoke.ts')], bundle: true,
    platform: 'node', outfile: output, external: ['electron'],
    alias: { serialport: join(root, 'tests/terminal-serial-mock.js') }, logLevel: 'error'
  })
  const flags = process.platform === 'linux' ? ['--no-sandbox'] : []
  const result = spawnSync(require('electron'), [...flags, output, dir], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, DEVKIT_SMOKE_USER_DATA: dir, DISPLAY: process.env.DISPLAY || ':0' },
    timeout: process.env.DEVKIT_PLUGIN_SMOKE_HOLD === '1' ? 0 : 90_000
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error('Electron插件冒烟退出信号：' + result.signal)
  process.exitCode = result.status ?? 1
} finally { rmSync(dir, { recursive: true, force: true }) }

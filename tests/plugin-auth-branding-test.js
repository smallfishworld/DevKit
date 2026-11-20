const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const directory = mkdtempSync(join(tmpdir(), 'devkit-auth-branding-'))
try {
  const entry = join(directory, 'test.cjs')
  buildSync({
    entryPoints: ['tests/plugin-auth-branding-entry.js'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { electron: resolve('tests/plugin-auth-branding-electron.js') },
    logLevel: 'silent'
  })
  const result = spawnSync(process.execPath, [entry], { stdio: 'inherit', timeout: 10000 })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}

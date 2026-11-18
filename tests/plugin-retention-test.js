const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')

const temp = mkdtempSync(join(tmpdir(), 'devkit-plugin-unit-'))
try {
  const out = join(temp, 'test.cjs')
  buildSync({ entryPoints: [join(__dirname, 'plugin-retention-entry.js')], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
  require(out)
} finally { rmSync(temp, { recursive: true, force: true }) }

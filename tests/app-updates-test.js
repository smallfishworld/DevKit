const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const dir = mkdtempSync(join(tmpdir(), 'devkit-app-updates-test-'))
try {
  const outfile = join(dir, 'test.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'app-updates-entry.js')],
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error'
  })
  require(outfile)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

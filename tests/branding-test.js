const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const dir = mkdtempSync(join(tmpdir(), 'devkit-branding-test-'))
try {
  const out = join(dir, 'test.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'branding-entry.js')],
    outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error'
  })
  require(out)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

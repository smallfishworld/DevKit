const { buildSync } = require('esbuild')
const { join } = require('node:path')

const output = join(__dirname, '.plugin-source-test.cjs')
buildSync({
  entryPoints: [join(__dirname, 'plugin-source-entry.js')], bundle: true, platform: 'node',
  outfile: output, logLevel: 'error'
})
require(output)

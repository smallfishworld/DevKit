const path = require('node:path')
const { buildSync } = require('esbuild')

buildSync({
  entryPoints: [path.join(__dirname, 'terminal-entry.js')],
  bundle: true,
  platform: 'node',
  outfile: path.join(__dirname, '.terminal-test.cjs'),
  alias: { electron: path.join(__dirname, 'terminal-electron-mock.js') },
  logLevel: 'error'
})
require('./.terminal-test.cjs')

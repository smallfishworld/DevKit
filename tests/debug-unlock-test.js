const { buildSync } = require('esbuild')
const { join } = require('node:path')

const output = join(__dirname, '.debug-unlock-test.cjs')
buildSync({
  entryPoints: [join(__dirname, 'debug-unlock-entry.js')], bundle: true, platform: 'node', outfile: output,
  alias: {
    electron: join(__dirname, 'terminal-electron-mock.js'),
    serialport: join(__dirname, 'terminal-serial-mock.js')
  },
  logLevel: 'error'
})
require(output)

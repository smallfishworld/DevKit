const path = require('node:path')
const { buildSync } = require('esbuild')
buildSync({
  entryPoints: [path.join(__dirname, 'terminal-services-entry.js')],
  bundle: true, platform: 'node', outfile: path.join(__dirname, '.terminal-services-test.cjs'),
  external: ['ssh2'],
  alias: {
    electron: path.join(__dirname, 'terminal-electron-mock.js'),
    serialport: path.join(__dirname, 'terminal-serial-mock.js')
  },
  logLevel: 'error'
})
require('./.terminal-services-test.cjs')

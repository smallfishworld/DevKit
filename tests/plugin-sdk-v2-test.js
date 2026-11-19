const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')

const temp = mkdtempSync(join(tmpdir(), 'devkit-plugin-sdk-v2-'))
try {
  const mockElectron = join(temp, 'electron-mock.cjs')
  writeFileSync(mockElectron, 'module.exports = { app: { getPath: () => "", getVersion: () => "0.1.10" }, dialog: {}, utilityProcess: {}, ipcMain: { handle() {}, on() {} } };\n')
  const out = join(temp, 'test.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'plugin-sdk-v2-entry.js')],
    bundle: true,
    platform: 'node',
    alias: { electron: mockElectron },
    outfile: out,
    logLevel: 'error'
  })
  require(out)
} finally { rmSync(temp, { recursive: true, force: true }) }

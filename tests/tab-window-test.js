const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')

const temp = mkdtempSync(join(tmpdir(), 'devkit-tab-window-unit-'))
try {
  const out = join(temp, 'test.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'tab-window-entry.js')],
    // tabs store 内部走 @renderer 别名引用纯逻辑模块
    alias: { '@renderer': join(__dirname, '../src/renderer/src') },
    bundle: true,
    platform: 'node',
    outfile: out,
    logLevel: 'error'
  })
  require(out)
} finally { rmSync(temp, { recursive: true, force: true }) }

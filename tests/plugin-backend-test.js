const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const dir=mkdtempSync(join(tmpdir(),'devkit-plugin-tests-'))
try {
  const entry=join(dir,'test.cjs')
  const host=join(dir,'plugin-host.cjs')
  buildSync({entryPoints:['tests/plugin-backend-entry.js'],outfile:entry,bundle:true,platform:'node',format:'cjs',alias:{electron:resolve('tests/plugin-electron-mock.js')},logLevel:'silent'})
  buildSync({entryPoints:['src/main/services/plugins/host.ts'],outfile:host,bundle:true,platform:'node',format:'cjs',logLevel:'silent'})
  const result=spawnSync(process.execPath,[entry],{stdio:'inherit',env:{...process.env,DEVKIT_PLUGIN_TEST_HOST:host},timeout:30000})
  if(result.error)throw result.error
  process.exitCode=result.status??1
} finally { rmSync(dir,{recursive:true,force:true}) }

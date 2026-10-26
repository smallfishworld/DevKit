/* 回滚保护测试入口：esbuild 打包 vtguard-entry.js（含 TS 源）后用 node 跑 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(__dirname, 'vtguard-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.vtguard-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.vtguard-test.cjs')

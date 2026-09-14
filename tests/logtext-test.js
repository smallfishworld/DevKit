/* 日志文本清洗测试入口：esbuild 打包 logtext-entry.js（含 TS 源）后用 node 跑 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(__dirname, 'logtext-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.logtext-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.logtext-test.cjs')
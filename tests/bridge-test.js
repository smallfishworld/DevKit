/* 串口TCP桥接纯逻辑测试入口：esbuild 打包 bridge-entry.js（含 TS 源）后用 node 跑
   覆盖 Telnet IAC 状态机、JSON 行协议、身份派生 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(__dirname, 'bridge-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.bridge-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.bridge-test.cjs')

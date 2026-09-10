/* 纯逻辑单元测试：textdiff + hexdiff + folder（比较/同步），esbuild 打包后在 node 跑 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(__dirname, 'diff-entry.js')}" --bundle --platform=node --external:electron --outfile="${path.join(__dirname, '.diff-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.diff-test.cjs')
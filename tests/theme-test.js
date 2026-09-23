/* 主题系统纯逻辑测试：注册表、ANSI 16 色、xterm 映射、跟随系统与 Tabby 导入 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(ROOT, 'tests/theme-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.theme-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.theme-test.cjs')

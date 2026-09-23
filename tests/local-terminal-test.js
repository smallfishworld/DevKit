/* 本地终端纯逻辑测试：Shell Profile 路径检测与 PowerShell fallback */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(ROOT, 'tests/local-terminal-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.local-terminal-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.local-terminal-test.cjs')

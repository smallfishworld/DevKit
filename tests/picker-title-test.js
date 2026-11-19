/* 取点器几何换算 + 串口备注标题（纯逻辑） */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(ROOT, 'tests/picker-title-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.picker-title-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.picker-title-test.cjs')

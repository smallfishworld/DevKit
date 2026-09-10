/* 纯逻辑单元测试：hexutil + 计算器引擎（esbuild 打包后在 node 跑） */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(ROOT, 'scripts/logic-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.logic-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.logic-test.cjs')

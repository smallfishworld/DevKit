/* 应用语言纯逻辑测试：支持集合、默认回退、配置清洗与双语消息键一致性 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

execSync(
  `npx esbuild "${path.join(ROOT, 'tests/locale-entry.js')}" --bundle --platform=node --outfile="${path.join(__dirname, '.locale-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
require('./.locale-test.cjs')

/* 主题系统纯逻辑测试：Tabby YAML/JSON 导入、ANSI 16 色映射与配置兼容归一。 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.theme-test.cjs')

execSync(
  `npx esbuild "${path.join(__dirname, 'theme-entry.js')}" --bundle --platform=node --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)

const {
  normalizeAppearanceSettings,
  parseTabbyThemeText,
  slugifyThemeName
} = require(OUT)

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

const yaml = `
name: Nord Import
foreground: '#D8DEE9'
background: '#2E3440'
cursor: '#D8DEE9'
selection: '#434C5E'
colors:
  - '#3B4252'
  - '#BF616A'
  - '#A3BE8C'
  - '#EBCB8B'
  - '#81A1C1'
  - '#B48EAD'
  - '#88C0D0'
  - '#E5E9F0'
  - '#4C566A'
  - '#BF616A'
  - '#A3BE8C'
  - '#EBCB8B'
  - '#81A1C1'
  - '#B48EAD'
  - '#8FBCBB'
  - '#ECEFF4'
`

console.log('--- Tabby YAML ---')
const nord = parseTabbyThemeText(yaml)
check('名称解析', nord.name === 'Nord Import')
check('ANSI red 映射 colors[1]', nord.ansi.red === '#BF616A')
check('ANSI brightWhite 映射 colors[15]', nord.ansi.brightWhite === '#ECEFF4')
check('selection 映射 selectionBackground', nord.selectionBackground === '#434C5E')
check('导入主题标记为自定义', nord.builtin === false && nord.id.startsWith('custom-'))

console.log('--- Tabby JSON ---')
const json = JSON.stringify({
  name: 'JSON Theme',
  foreground: '#ffffff',
  background: '#000000',
  cursor: '#ffffff',
  selection: '#333333',
  colors: Array.from({ length: 16 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`)
})
const jt = parseTabbyThemeText(json)
check('JSON colors[10] → brightGreen', jt.ansi.brightGreen === '#00000a')

console.log('--- 配置兼容 ---')
const partial = normalizeAppearanceSettings({ terminalThemeId: 'nord' })
check('旧配置缺字段自动补默认 UI theme', partial.uiThemeId === 'devkit-dark')
check('旧配置缺 custom themes 自动补空数组', Array.isArray(partial.customTerminalThemes) && partial.customTerminalThemes.length === 0)
check('slug 稳定', slugifyThemeName('Tokyo Night') === 'tokyo-night')

console.log('--- 非法主题 ---')
let rejected = false
try {
  parseTabbyThemeText("name: bad\nforeground: '#fff'\nbackground: '#000'\ncolors:\n - '#000'")
} catch {
  rejected = true
}
check('少于 16 色时拒绝导入', rejected)

if (fail > 0) {
  console.log(`\ntheme-test: ${fail} FAILED, ${pass} passed`)
  process.exit(1)
}
console.log(`\ntheme-test: all ${pass} passed`)

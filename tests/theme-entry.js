import assert from 'node:assert/strict'
import {
  TERMINAL_THEMES,
  ThemeRegistry,
  importTabbyColorScheme,
  toXtermTheme
} from '../src/renderer/src/theme/index.ts'
import { DEFAULT_APPEARANCE_SETTINGS } from '../src/shared/theme.ts'
import { termPanelPalette, termPanelPaletteVars, relativeLuminance, uiThemeFromTerminal } from '../src/shared/theme.ts'

assert.ok(TERMINAL_THEMES.length >= 10)
assert.equal(DEFAULT_APPEARANCE_SETTINGS.uiTheme, 'devkit-dark')
assert.equal(DEFAULT_APPEARANCE_SETTINGS.terminalTheme, 'devkit-default')

const registry = new ThemeRegistry(TERMINAL_THEMES)
assert.equal(registry.getTerminal('nord')?.name, 'Nord')

const ansiKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
]
for (const theme of TERMINAL_THEMES) {
  assert.ok(theme.foreground)
  assert.ok(theme.background)
  assert.ok(theme.cursor)
  assert.ok(theme.selectionBackground)
  for (const key of ansiKeys) assert.ok(theme.ansi[key], `${theme.id} missing ${key}`)
}

const nord = registry.getTerminal('nord')
assert.ok(nord)
const xterm = toXtermTheme(nord)
assert.equal(xterm.background, nord.background)
assert.equal(xterm.red, nord.ansi.red)
assert.equal(xterm.brightWhite, nord.ansi.brightWhite)

// ---------- 全 App 界面主题（uiThemeFromTerminal） ----------
const dk = uiThemeFromTerminal(registry.getTerminal('devkit-default'))
for (const theme of TERMINAL_THEMES) {
  const ui = uiThemeFromTerminal(theme)
  // 明暗判定与背景亮度一致
  assert.equal(ui.mode, relativeLuminance(theme.background) > 0.5 ? 'light' : 'dark', theme.id)
  // 派生色板覆盖全部关键语义 token，均为有效 6 位 hex
  const colors = ui.colors
  for (const key of ['primary', 'success', 'warning', 'danger', 'info', 'background', 'backgroundPage', 'surface', 'fill', 'fillLight', 'fillDark', 'textPrimary', 'textRegular', 'textSecondary', 'textPlaceholder', 'border', 'borderLight', 'borderLighter', 'diffOnlyLeft', 'diffOnlyRight', 'diffDiffer', 'diffIdentical', 'diffDirectory', 'diffIgnored']) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(colors[key]), `${theme.id} ${key} 非法: ${colors[key]}`)
  }
  // 主色来自 ansi（不落空）
  assert.ok(colors.primary, theme.id)
}
// 边界对比：暗主题 border 应与背景可辨（纠正旧 palette 边框近背景问题）
const nordUi = uiThemeFromTerminal(registry.getTerminal('nord'))
assert.equal(nordUi.mode, 'dark')
assert.ok(Math.abs(relativeLuminance(nordUi.colors.border) - relativeLuminance(nordUi.colors.background)) > 0.04)
// 纯函数：同输入同输出
assert.deepEqual(uiThemeFromTerminal(registry.getTerminal('nord')), uiThemeFromTerminal(registry.getTerminal('nord')))

const imported = importTabbyColorScheme({
  name: 'Example Theme',
  foreground: '#eeeeee',
  background: '#111111',
  cursor: '#ffffff',
  selection: '#333333',
  colors: Array.from({ length: 16 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`)
})
assert.equal(imported.id, 'tabby-example-theme')
assert.equal(imported.ansi.black, '#000000')
assert.equal(imported.ansi.brightWhite, '#00000f')

// ---------- 终端面板配色（termPanelPalette） ----------
for (const theme of TERMINAL_THEMES) {
  const pal = termPanelPalette(theme)
  // 明暗判定与背景亮度一致
  assert.equal(pal.mode, relativeLuminance(theme.background) > 0.5 ? 'light' : 'dark', theme.id)
  // 面板块、文本、边框相对背景可分辨
  assert.ok(pal.surface)
  assert.ok(pal.textPrimary)
  assert.ok(pal.border)
  // 变量映射覆盖面板需要的语义 token
  const vars = termPanelPaletteVars(pal)
  for (const key of ['--dk-bg', '--dk-surface', '--dk-fill', '--dk-text-primary', '--dk-border']) {
    assert.ok(vars[key], `${theme.id} missing ${key}`)
  }
}
// light 主题的面板块更亮于背景，dark 主题更亮（工具栏一眼可辨）
const solarizedLight = termPanelPalette(registry.getTerminal('solarized-light'))
assert.equal(solarizedLight.mode, 'light')
assert.ok(relativeLuminance(solarizedLight.surface) > relativeLuminance(solarizedLight.bg))
const dracula = termPanelPalette(registry.getTerminal('dracula'))
assert.equal(dracula.mode, 'dark')
assert.ok(relativeLuminance(dracula.surface) > relativeLuminance(dracula.bg))
// 纯函数：同输入同输出
assert.deepEqual(termPanelPalette(registry.getTerminal('nord')), termPanelPalette(registry.getTerminal('nord')))

console.log('theme tests passed')

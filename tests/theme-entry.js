import assert from 'node:assert/strict'
import {
  TERMINAL_THEMES,
  UI_THEMES,
  ThemeRegistry,
  importTabbyColorScheme,
  resolveUiTheme,
  toXtermTheme
} from '../src/renderer/src/theme/index.ts'
import { DEFAULT_APPEARANCE_SETTINGS } from '../src/shared/theme.ts'

assert.equal(UI_THEMES.length, 2)
assert.ok(TERMINAL_THEMES.length >= 10)
assert.equal(DEFAULT_APPEARANCE_SETTINGS.uiTheme, 'devkit-dark')
assert.equal(DEFAULT_APPEARANCE_SETTINGS.terminalTheme, 'devkit-default')

const registry = new ThemeRegistry(UI_THEMES, TERMINAL_THEMES)
assert.equal(registry.getUi('devkit-dark')?.mode, 'dark')
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

assert.equal(resolveUiTheme({ ...DEFAULT_APPEARANCE_SETTINGS, followSystem: true }, false).id, 'devkit-light')
assert.equal(resolveUiTheme({ ...DEFAULT_APPEARANCE_SETTINGS, followSystem: true }, true).id, 'devkit-dark')

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

console.log('theme tests passed')

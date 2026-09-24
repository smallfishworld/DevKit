import type { ITheme } from '@xterm/xterm'
import type { TerminalTheme, UiTheme } from '../../../shared/theme'
import { uiThemeFromTerminal } from '../../../shared/theme'

export { uiThemeFromTerminal }

export class ThemeRegistry {
  private readonly terminalThemes = new Map<string, TerminalTheme>()

  constructor(terminalThemes: TerminalTheme[] = []) {
    terminalThemes.forEach((theme) => this.registerTerminal(theme))
  }

  registerTerminal(theme: TerminalTheme): void {
    this.terminalThemes.set(theme.id, theme)
  }

  getTerminal(id: string): TerminalTheme | undefined {
    return this.terminalThemes.get(id)
  }

  listTerminal(): TerminalTheme[] {
    return Array.from(this.terminalThemes.values())
  }
}

const terminal = (
  id: string,
  name: string,
  foreground: string,
  background: string,
  cursor: string,
  selectionBackground: string,
  ansi: TerminalTheme['ansi'],
  author?: string
): TerminalTheme => ({
  id,
  name,
  author,
  builtin: true,
  foreground,
  background,
  cursor,
  cursorAccent: background,
  selectionBackground,
  ansi
})

export const DEVKIT_TERMINAL_THEME = terminal(
  'devkit-default',
  'DevKit Default',
  '#cfd8dc',
  '#101418',
  '#7fb4d9',
  '#31454f',
  {
    black: '#1b2026', red: '#d96c75', green: '#8fbf7f', yellow: '#d6b66b',
    blue: '#6f9fc7', magenta: '#ad7fb8', cyan: '#6fb5b5', white: '#c7d0d6',
    brightBlack: '#65717c', brightRed: '#ed8790', brightGreen: '#a7d397', brightYellow: '#e7ca84',
    brightBlue: '#8bb8df', brightMagenta: '#c998d2', brightCyan: '#8acccc', brightWhite: '#eef3f5'
  },
  'DevKit'
)

export const TERMINAL_THEMES: TerminalTheme[] = [
  DEVKIT_TERMINAL_THEME,
  terminal('vscode-dark-plus', 'VS Code Dark+', '#cccccc', '#1e1e1e', '#ffffff', '#264f78', {
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5'
  }, 'Microsoft'),
  terminal('one-dark', 'One Dark', '#abb2bf', '#282c34', '#528bff', '#3e4451', {
    black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#d19a66', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff'
  }, 'Atom'),
  terminal('dracula', 'Dracula', '#f8f8f2', '#282a36', '#f8f8f0', '#44475a', {
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
  }, 'Dracula'),
  terminal('nord', 'Nord', '#d8dee9', '#2e3440', '#d8dee9', '#434c5e', {
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
  }, 'Arctic Ice Studio'),
  terminal('gruvbox-dark', 'Gruvbox Dark', '#ebdbb2', '#282828', '#ebdbb2', '#504945', {
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2'
  }, 'morhetz'),
  terminal('solarized-dark', 'Solarized Dark', '#839496', '#002b36', '#93a1a1', '#073642', {
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
  }, 'Ethan Schoonover'),
  terminal('solarized-light', 'Solarized Light', '#657b83', '#fdf6e3', '#586e75', '#eee8d5', {
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
  }, 'Ethan Schoonover'),
  terminal('catppuccin-mocha', 'Catppuccin Mocha', '#cdd6f4', '#1e1e2e', '#f5e0dc', '#45475a', {
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
  }, 'Catppuccin'),
  terminal('tokyo-night', 'Tokyo Night', '#c0caf5', '#1a1b26', '#c0caf5', '#33467c', {
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5'
  }, 'enkia'),
  terminal('monokai', 'Monokai', '#f8f8f2', '#272822', '#f8f8f0', '#49483e', {
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5'
  }, 'Monokai'),
  terminal('material-dark', 'Material (Dark)', '#eeffff', '#263238', '#ffcb6b', '#314549', {
    black: '#000000', red: '#f07178', green: '#c3e88d', yellow: '#ffcb6b', blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#eeffff',
    brightBlack: '#546e7a', brightRed: '#ff8b92', brightGreen: '#ddffa7', brightYellow: '#ffe585', brightBlue: '#a2caff', brightMagenta: '#e2a9ff', brightCyan: '#b6f3ff', brightWhite: '#ffffff'
  }, 'Google'),
  terminal('github-dark', 'GitHub Dark', '#adbac7', '#1c2128', '#539bf5', '#373e47', {
    black: '#090a0b', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#909dab',
    brightBlack: '#636e7b', brightRed: '#f47067', brightGreen: '#57ab5a', brightYellow: '#c69026', brightBlue: '#539bf5', brightMagenta: '#b083f0', brightCyan: '#39c5cf', brightWhite: '#adbac7'
  }, 'GitHub'),
  terminal('ayu-mirage', 'Ayu Mirage', '#cbccc6', '#1f2430', '#ffcc66', '#343f44', {
    black: '#191e2a', red: '#f07178', green: '#aad94c', yellow: '#ffb454', blue: '#59c2ff', magenta: '#d2a6ff', cyan: '#95e6cb', white: '#cbccc6',
    brightBlack: '#565b66', brightRed: '#ff6a78', brightGreen: '#b8e532', brightYellow: '#ffb454', brightBlue: '#69c4ff', brightMagenta: '#d889ff', brightCyan: '#9ae8cb', brightWhite: '#f3f4f5'
  }, 'ayu'),
  terminal('pure-black', 'Pure Black', '#e6e6e6', '#000000', '#e6e6e6', '#333333', {
    black: '#000000', red: '#cc5555', green: '#55cc55', yellow: '#cccc55', blue: '#5555cc', magenta: '#cc55cc', cyan: '#55cccc', white: '#e6e6e6',
    brightBlack: '#777777', brightRed: '#ff7777', brightGreen: '#77ff77', brightYellow: '#ffff77', brightBlue: '#7777ff', brightMagenta: '#ff77ff', brightCyan: '#77ffff', brightWhite: '#ffffff'
  }, 'DevKit'),
  terminal('black-navy', 'Dim Ink', '#d8dee9', '#0a0f14', '#d8dee9', '#1f2630', {
    black: '#0a0f14', red: '#c05b5b', green: '#5fa86f', yellow: '#c9a45c', blue: '#5a7fa8', magenta: '#a86baa', cyan: '#57a7aa', white: '#d8dee9',
    brightBlack: '#5a6673', brightRed: '#e07373', brightGreen: '#7bc98c', brightYellow: '#e0c077', brightBlue: '#7ca4cc', brightMagenta: '#c08ac5', brightCyan: '#77c9cc', brightWhite: '#f2f6fa'
  }, 'DevKit'),
  terminal('homebrew-green', 'Homebrew Green', '#00ff00', '#000000', '#00ff00', '#00ff0044', {
    black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900', blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
    brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500', brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5'
  }, 'Homebrew'),
  terminal('eye-green', 'Soft Green', '#2f4f3a', '#c7edcc', '#2f4f3a', '#a8d8b4', {
    black: '#3a4a3f', red: '#a03d3d', green: '#2a7d43', yellow: '#8a6a1d', blue: '#3a5a8a', magenta: '#7a4a7a', cyan: '#2a6a6a', white: '#2f4f3a',
    brightBlack: '#6a7a6f', brightRed: '#c05757', brightGreen: '#3d9a58', brightYellow: '#a8872e', brightBlue: '#5578ab', brightMagenta: '#9a639a', brightCyan: '#45898c', brightWhite: '#12381f'
  }, 'DevKit')
]

export const themeRegistry = new ThemeRegistry(TERMINAL_THEMES)

export function toXtermTheme(theme: TerminalTheme): ITheme {
  return {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent ?? theme.background,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    black: theme.ansi.black,
    red: theme.ansi.red,
    green: theme.ansi.green,
    yellow: theme.ansi.yellow,
    blue: theme.ansi.blue,
    magenta: theme.ansi.magenta,
    cyan: theme.ansi.cyan,
    white: theme.ansi.white,
    brightBlack: theme.ansi.brightBlack,
    brightRed: theme.ansi.brightRed,
    brightGreen: theme.ansi.brightGreen,
    brightYellow: theme.ansi.brightYellow,
    brightBlue: theme.ansi.brightBlue,
    brightMagenta: theme.ansi.brightMagenta,
    brightCyan: theme.ansi.brightCyan,
    brightWhite: theme.ansi.brightWhite
  }
}

export function applyUiTheme(theme: UiTheme): void {
  const root = document.documentElement
  const c = theme.colors
  root.classList.toggle('dark', theme.mode === 'dark')
  root.dataset.uiTheme = theme.id
  root.style.colorScheme = theme.mode
  const vars: Record<string, string> = {
    '--dk-primary': c.primary,
    '--dk-success': c.success,
    '--dk-warning': c.warning,
    '--dk-danger': c.danger,
    '--dk-info': c.info,
    '--dk-bg': c.background,
    '--dk-bg-page': c.backgroundPage,
    '--dk-surface': c.surface,
    '--dk-fill': c.fill,
    '--dk-fill-light': c.fillLight,
    '--dk-fill-dark': c.fillDark,
    '--dk-text-primary': c.textPrimary,
    '--dk-text-regular': c.textRegular,
    '--dk-text-secondary': c.textSecondary,
    '--dk-text-placeholder': c.textPlaceholder,
    '--dk-border': c.border,
    '--dk-border-light': c.borderLight,
    '--dk-border-lighter': c.borderLighter,
    '--dk-change-row': c.diffChangeRow,
    '--dk-change-seg': c.diffChangeSegment,
    '--dk-orph-row': c.diffOrphanRow,
    '--dk-add-row': c.diffOrphanRow,
    '--dk-add-seg': c.diffOrphanRow,
    '--dk-del-row': c.diffChangeRow,
    '--dk-del-seg': c.diffChangeSegment,
    '--dk-st-only-left': c.diffOnlyLeft,
    '--dk-st-only-right': c.diffOnlyRight,
    '--dk-st-differ': c.diffDiffer,
    '--dk-st-identical': c.diffIdentical,
    '--dk-st-dir': c.diffDirectory,
    '--dk-st-ignored': c.diffIgnored
  }
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
}

interface TabbyColorSchemeLike {
  name?: string
  foreground?: string
  background?: string
  cursor?: string
  selection?: string
  colors?: string[]
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported-theme'
}

/** 将 Tabby Color Scheme JSON/已解析对象转换为 DevKit TerminalTheme。YAML 可先由外部解析后传入。 */
export function importTabbyColorScheme(input: string | TabbyColorSchemeLike): TerminalTheme {
  const data = typeof input === 'string' ? JSON.parse(input) as TabbyColorSchemeLike : input
  if (!data.name || !data.foreground || !data.background || !Array.isArray(data.colors) || data.colors.length < 16) {
    throw new Error('无效的 Tabby 终端主题：缺少 name/foreground/background/colors[16]')
  }
  const c = data.colors
  return {
    id: `tabby-${slugify(data.name)}`,
    name: data.name,
    author: 'Tabby import',
    builtin: false,
    foreground: data.foreground,
    background: data.background,
    cursor: data.cursor ?? data.foreground,
    cursorAccent: data.background,
    selectionBackground: data.selection ?? '#ffffff33',
    ansi: {
      black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
      brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15]
    }
  }
}

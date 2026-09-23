import type { ITheme } from '@xterm/xterm'
import type { AppearanceSettings, TerminalTheme, UiTheme } from '../../../shared/theme'

export class ThemeRegistry {
  private readonly uiThemes = new Map<string, UiTheme>()
  private readonly terminalThemes = new Map<string, TerminalTheme>()

  constructor(uiThemes: UiTheme[] = [], terminalThemes: TerminalTheme[] = []) {
    uiThemes.forEach((theme) => this.registerUi(theme))
    terminalThemes.forEach((theme) => this.registerTerminal(theme))
  }

  registerUi(theme: UiTheme): void {
    this.uiThemes.set(theme.id, theme)
  }

  registerTerminal(theme: TerminalTheme): void {
    this.terminalThemes.set(theme.id, theme)
  }

  getUi(id: string): UiTheme | undefined {
    return this.uiThemes.get(id)
  }

  getTerminal(id: string): TerminalTheme | undefined {
    return this.terminalThemes.get(id)
  }

  listUi(): UiTheme[] {
    return Array.from(this.uiThemes.values())
  }

  listTerminal(): TerminalTheme[] {
    return Array.from(this.terminalThemes.values())
  }
}

export const DEVKIT_DARK_UI_THEME: UiTheme = {
  id: 'devkit-dark',
  name: 'DevKit Dark',
  mode: 'dark',
  colors: {
    primary: '#5b8ac2',
    success: '#67c23a',
    warning: '#d8a657',
    danger: '#d96868',
    info: '#7d8b99',
    background: '#141414',
    backgroundPage: '#101216',
    surface: '#1b1d21',
    fill: '#25282d',
    fillLight: '#202329',
    fillDark: '#30343a',
    textPrimary: '#e4e7ed',
    textRegular: '#c5c9d1',
    textSecondary: '#9097a3',
    textPlaceholder: '#6f7782',
    border: '#4b4f57',
    borderLight: '#3d4148',
    borderLighter: '#30343a',
    diffChangeRow: 'rgba(198, 66, 66, 0.14)',
    diffChangeSegment: 'rgba(229, 57, 53, 0.38)',
    diffOrphanRow: 'rgba(67, 160, 71, 0.16)',
    diffOnlyLeft: '#7ba3cc',
    diffOnlyRight: '#dfad72',
    diffDiffer: '#d99a9a',
    diffIdentical: '#90a4ae',
    diffDirectory: '#81c784',
    diffIgnored: '#546e7a'
  }
}

export const DEVKIT_LIGHT_UI_THEME: UiTheme = {
  id: 'devkit-light',
  name: 'DevKit Light',
  mode: 'light',
  colors: {
    primary: '#3f6f9f',
    success: '#4f8f45',
    warning: '#a86f1f',
    danger: '#b94a48',
    info: '#657786',
    background: '#ffffff',
    backgroundPage: '#f4f6f8',
    surface: '#ffffff',
    fill: '#eef1f4',
    fillLight: '#f5f7f9',
    fillDark: '#e2e6ea',
    textPrimary: '#20242a',
    textRegular: '#3d454f',
    textSecondary: '#69737f',
    textPlaceholder: '#9aa3ad',
    border: '#c8ced6',
    borderLight: '#d8dde3',
    borderLighter: '#e6e9ed',
    diffChangeRow: 'rgba(198, 66, 66, 0.10)',
    diffChangeSegment: 'rgba(229, 57, 53, 0.24)',
    diffOrphanRow: 'rgba(67, 160, 71, 0.13)',
    diffOnlyLeft: '#416f9b',
    diffOnlyRight: '#9a641f',
    diffDiffer: '#a94f4f',
    diffIdentical: '#66717d',
    diffDirectory: '#4f8f45',
    diffIgnored: '#8a949e'
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

export const UI_THEMES: UiTheme[] = [DEVKIT_DARK_UI_THEME, DEVKIT_LIGHT_UI_THEME]

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
  }, 'enkia')
]

export const themeRegistry = new ThemeRegistry(UI_THEMES, TERMINAL_THEMES)

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

export function resolveUiTheme(settings: AppearanceSettings, prefersDark: boolean): UiTheme {
  const id = settings.followSystem ? (prefersDark ? 'devkit-dark' : 'devkit-light') : settings.uiTheme
  return themeRegistry.getUi(id) ?? DEVKIT_DARK_UI_THEME
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

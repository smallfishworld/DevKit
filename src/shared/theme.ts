/** DevKit 外观与终端主题共享模型及纯函数。 */

export const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number]

export type TerminalAnsiPalette = Record<AnsiColorKey, string>

export interface TerminalTheme {
  id: string
  name: string
  author?: string
  builtin?: boolean
  foreground: string
  background: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  selectionForeground?: string
  ansi: TerminalAnsiPalette
}

export interface UiThemeColors {
  primary: string
  primaryLight3: string
  primaryLight5: string
  primaryLight7: string
  primaryLight8: string
  primaryLight9: string
  primaryDark2: string
  background: string
  backgroundPage: string
  surface: string
  surfaceHover: string
  surfaceActive: string
  textPrimary: string
  textRegular: string
  textSecondary: string
  border: string
  borderLight: string
  success: string
  warning: string
  danger: string
  info: string
  diffChangeRow: string
  diffChangeSeg: string
  diffOrphanRow: string
  diffOnlyLeft: string
  diffOnlyRight: string
  diffDiffer: string
  diffIdentical: string
  diffDir: string
  diffIgnored: string
}

export interface UiTheme {
  id: string
  name: string
  mode: 'dark' | 'light'
  colors: UiThemeColors
}

export interface AppearanceSettings {
  uiThemeId: string
  terminalThemeId: string
  followSystem: boolean
  customTerminalThemes: TerminalTheme[]
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiThemeId: 'devkit-dark',
  terminalThemeId: 'devkit-default',
  followSystem: false,
  customTerminalThemes: []
}

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function slugifyThemeName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'terminal-theme'
}

export function normalizeTerminalTheme(value: unknown): TerminalTheme | null {
  const raw = recordOf(value)
  if (!raw) return null
  const ansiRaw = recordOf(raw.ansi)
  if (!ansiRaw) return null

  const name = stringOf(raw.name)
  const foreground = stringOf(raw.foreground)
  const background = stringOf(raw.background)
  const cursor = stringOf(raw.cursor)
  const selectionBackground = stringOf(raw.selectionBackground)
  if (!name || !foreground || !background || !cursor || !selectionBackground) return null

  const ansi = {} as TerminalAnsiPalette
  for (const key of ANSI_COLOR_KEYS) {
    const color = stringOf(ansiRaw[key])
    if (!color) return null
    ansi[key] = color
  }

  return {
    id: stringOf(raw.id) ?? `custom-${slugifyThemeName(name)}`,
    name,
    author: stringOf(raw.author),
    builtin: raw.builtin === true,
    foreground,
    background,
    cursor,
    cursorAccent: stringOf(raw.cursorAccent) ?? background,
    selectionBackground,
    selectionForeground: stringOf(raw.selectionForeground),
    ansi
  }
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const raw = recordOf(value)
  if (!raw) return { ...DEFAULT_APPEARANCE_SETTINGS, customTerminalThemes: [] }

  const customs = Array.isArray(raw.customTerminalThemes)
    ? raw.customTerminalThemes
        .map(normalizeTerminalTheme)
        .filter((theme): theme is TerminalTheme => !!theme)
        .map((theme) => ({ ...theme, builtin: false }))
    : []

  return {
    uiThemeId: stringOf(raw.uiThemeId) ?? DEFAULT_APPEARANCE_SETTINGS.uiThemeId,
    terminalThemeId:
      stringOf(raw.terminalThemeId) ?? DEFAULT_APPEARANCE_SETTINGS.terminalThemeId,
    followSystem: raw.followSystem === true,
    customTerminalThemes: customs
  }
}

function unquote(value: string): string {
  const s = value.trim()
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1)
  }
  return s
}

function paletteFromArray(colors: unknown[]): TerminalAnsiPalette {
  if (colors.length < ANSI_COLOR_KEYS.length) {
    throw new Error(`Tabby 主题 colors 至少需要 ${ANSI_COLOR_KEYS.length} 个颜色`)
  }
  const ansi = {} as TerminalAnsiPalette
  ANSI_COLOR_KEYS.forEach((key, index) => {
    const color = stringOf(colors[index])
    if (!color) throw new Error(`Tabby 主题 colors[${index}] 不是有效颜色字符串`)
    ansi[key] = color
  })
  return ansi
}

function themeFromTabbyRecord(raw: UnknownRecord): TerminalTheme {
  const name = stringOf(raw.name) ?? 'Imported Terminal Theme'
  const foreground = stringOf(raw.foreground)
  const background = stringOf(raw.background)
  const cursor = stringOf(raw.cursor) ?? foreground
  const selectionBackground =
    stringOf(raw.selectionBackground) ?? stringOf(raw.selection) ?? '#3a3d41'

  if (!foreground || !background || !cursor) {
    throw new Error('Tabby 主题缺少 foreground / background / cursor')
  }
  if (!Array.isArray(raw.colors)) throw new Error('Tabby 主题缺少 16 色 colors 数组')

  return {
    id: `custom-${slugifyThemeName(name)}`,
    name,
    author: stringOf(raw.author),
    builtin: false,
    foreground,
    background,
    cursor,
    cursorAccent: stringOf(raw.cursorAccent) ?? background,
    selectionBackground,
    selectionForeground: stringOf(raw.selectionForeground),
    ansi: paletteFromArray(raw.colors)
  }
}

function parseYamlTabby(text: string): UnknownRecord {
  const out: UnknownRecord = {}
  const colors: string[] = []
  let readingColors = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (readingColors && line.startsWith('-')) {
      colors.push(unquote(line.slice(1)))
      continue
    }

    const match = rawLine.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const value = match[2].trim()
    readingColors = key === 'colors'

    if (key === 'colors') {
      if (value) {
        const inline = value.replace(/^\[/, '').replace(/\]$/, '')
        for (const item of inline.split(',')) {
          const color = unquote(item)
          if (color) colors.push(color)
        }
      }
      continue
    }

    out[key] = unquote(value)
  }

  out.colors = colors
  return out
}

/**
 * 解析 Tabby color scheme（JSON 或常见 YAML 格式）。同时接受 DevKit 自身导出的 TerminalTheme JSON。
 */
export function parseTabbyThemeText(text: string): TerminalTheme {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('主题文件为空')

  let raw: unknown
  if (trimmed.startsWith('{')) {
    raw = JSON.parse(trimmed) as unknown
    const native = normalizeTerminalTheme(raw)
    if (native) return { ...native, builtin: false }
  } else {
    raw = parseYamlTabby(trimmed)
  }

  const record = recordOf(raw)
  if (!record) throw new Error('无法识别主题文件格式')
  return themeFromTabbyRecord(record)
}

export type ThemeMode = 'dark' | 'light'

export interface UiThemeColors {
  primary: string
  success: string
  warning: string
  danger: string
  info: string
  background: string
  backgroundPage: string
  surface: string
  fill: string
  fillLight: string
  fillDark: string
  textPrimary: string
  textRegular: string
  textSecondary: string
  textPlaceholder: string
  border: string
  borderLight: string
  borderLighter: string
  diffChangeRow: string
  diffChangeSegment: string
  diffOrphanRow: string
  diffOnlyLeft: string
  diffOnlyRight: string
  diffDiffer: string
  diffIdentical: string
  diffDirectory: string
  diffIgnored: string
}

export interface UiTheme {
  id: string
  name: string
  mode: ThemeMode
  colors: UiThemeColors
}

export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

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
  ansi: AnsiPalette
}

export interface AppearanceSettings {
  uiTheme: string
  terminalTheme: string
  followSystem: boolean
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiTheme: 'devkit-dark',
  terminalTheme: 'devkit-default',
  followSystem: false
}

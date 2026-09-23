import type { TerminalTheme, UiTheme } from '../../../shared/theme'

export function toXtermTheme(theme: TerminalTheme) {
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
    '--dk-primary-light-3': c.primaryLight3,
    '--dk-primary-light-5': c.primaryLight5,
    '--dk-primary-light-7': c.primaryLight7,
    '--dk-primary-light-8': c.primaryLight8,
    '--dk-primary-light-9': c.primaryLight9,
    '--dk-primary-dark-2': c.primaryDark2,
    '--dk-bg': c.background,
    '--dk-bg-page': c.backgroundPage,
    '--dk-surface': c.surface,
    '--dk-surface-hover': c.surfaceHover,
    '--dk-surface-active': c.surfaceActive,
    '--dk-text-primary': c.textPrimary,
    '--dk-text-regular': c.textRegular,
    '--dk-text-secondary': c.textSecondary,
    '--dk-border': c.border,
    '--dk-border-light': c.borderLight,
    '--dk-success': c.success,
    '--dk-warning': c.warning,
    '--dk-danger': c.danger,
    '--dk-info': c.info,
    '--dk-change-row': c.diffChangeRow,
    '--dk-change-seg': c.diffChangeSeg,
    '--dk-orph-row': c.diffOrphanRow,
    '--dk-st-only-left': c.diffOnlyLeft,
    '--dk-st-only-right': c.diffOnlyRight,
    '--dk-st-differ': c.diffDiffer,
    '--dk-st-identical': c.diffIdentical,
    '--dk-st-dir': c.diffDir,
    '--dk-st-ignored': c.diffIgnored
  }

  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
}

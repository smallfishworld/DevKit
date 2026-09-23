import type { TerminalTheme, UiTheme } from '../../../shared/theme'
import { BUILTIN_TERMINAL_THEMES, BUILTIN_UI_THEMES } from './builtins'

export class ThemeRegistry {
  private readonly uiThemes = new Map<string, UiTheme>()
  private readonly terminalThemes = new Map<string, TerminalTheme>()
  private readonly builtinTerminalIds = new Set<string>()

  constructor(uiThemes: UiTheme[] = [], terminalThemes: TerminalTheme[] = []) {
    uiThemes.forEach((theme) => this.registerUi(theme))
    terminalThemes.forEach((theme) => this.registerTerminal({ ...theme, builtin: true }))
  }

  registerUi(theme: UiTheme): void {
    this.uiThemes.set(theme.id, theme)
  }

  registerTerminal(theme: TerminalTheme): void {
    if (theme.builtin) this.builtinTerminalIds.add(theme.id)
    this.terminalThemes.set(theme.id, theme)
  }

  replaceCustomTerminalThemes(themes: TerminalTheme[]): void {
    for (const id of [...this.terminalThemes.keys()]) {
      if (!this.builtinTerminalIds.has(id)) this.terminalThemes.delete(id)
    }
    for (const theme of themes) {
      if (this.builtinTerminalIds.has(theme.id)) continue
      this.terminalThemes.set(theme.id, { ...theme, builtin: false })
    }
  }

  getUi(id: string): UiTheme | undefined {
    return this.uiThemes.get(id)
  }

  getTerminal(id: string): TerminalTheme | undefined {
    return this.terminalThemes.get(id)
  }

  listUi(): UiTheme[] {
    return [...this.uiThemes.values()]
  }

  listTerminal(): TerminalTheme[] {
    return [...this.terminalThemes.values()]
  }

  isBuiltinTerminal(id: string): boolean {
    return this.builtinTerminalIds.has(id)
  }
}

export const themeRegistry = new ThemeRegistry(BUILTIN_UI_THEMES, BUILTIN_TERMINAL_THEMES)

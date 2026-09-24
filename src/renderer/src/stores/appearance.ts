import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  uiThemeFromTerminal,
  type AppearanceSettings,
  type TerminalTheme
} from '../../../shared/theme'
import { DEVKIT_TERMINAL_THEME, applyUiTheme, themeRegistry } from '../theme'

export const useAppearanceStore = defineStore('appearance', () => {
  const settings = reactive<AppearanceSettings>({ ...DEFAULT_APPEARANCE_SETTINGS })
  const initialized = ref(false)

  const terminalThemes = themeRegistry.listTerminal()

  const terminalTheme = computed<TerminalTheme>(
    () => themeRegistry.getTerminal(settings.terminalTheme) ?? DEVKIT_TERMINAL_THEME
  )

  function applyCurrentUiTheme(): void {
    applyUiTheme(uiThemeFromTerminal(terminalTheme.value))
  }

  async function persist(): Promise<void> {
    try {
      await window.api.invoke('settings', 'appearance:set', 'global', { ...settings })
    } catch (error) {
      console.warn('[appearance] 保存设置失败:', error)
    }
  }

  async function init(): Promise<void> {
    if (initialized.value) return

    try {
      const saved = (await window.api.invoke(
        'settings',
        'appearance:get',
        'global'
      )) as Partial<AppearanceSettings> | null
      if (saved && typeof saved.terminalTheme === 'string' && themeRegistry.getTerminal(saved.terminalTheme)) {
        settings.terminalTheme = saved.terminalTheme
      }
    } catch (error) {
      console.warn('[appearance] 读取设置失败，使用默认主题:', error)
    }

    applyCurrentUiTheme()
    initialized.value = true
  }

  function setTerminalTheme(id: string): void {
    if (!themeRegistry.getTerminal(id)) return
    settings.terminalTheme = id
    applyCurrentUiTheme()
    void persist()
  }

  return {
    settings,
    initialized,
    terminalThemes,
    terminalTheme,
    init,
    setTerminalTheme
  }
})

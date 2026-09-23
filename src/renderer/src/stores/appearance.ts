import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type TerminalTheme,
  type UiTheme
} from '../../../shared/theme'
import {
  DEVKIT_DARK_UI_THEME,
  DEVKIT_TERMINAL_THEME,
  applyUiTheme,
  resolveUiTheme,
  themeRegistry
} from '../theme'

export const useAppearanceStore = defineStore('appearance', () => {
  const settings = reactive<AppearanceSettings>({ ...DEFAULT_APPEARANCE_SETTINGS })
  const initialized = ref(false)
  const systemDark = ref(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  let mediaQuery: MediaQueryList | null = null
  let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

  const uiThemes = themeRegistry.listUi()
  const terminalThemes = themeRegistry.listTerminal()

  const uiTheme = computed<UiTheme>(() => resolveUiTheme(settings, systemDark.value))
  const terminalTheme = computed<TerminalTheme>(
    () => themeRegistry.getTerminal(settings.terminalTheme) ?? DEVKIT_TERMINAL_THEME
  )

  function applyCurrentUiTheme(): void {
    applyUiTheme(uiTheme.value ?? DEVKIT_DARK_UI_THEME)
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

    mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
    systemDark.value = mediaQuery?.matches ?? true
    if (mediaQuery) {
      mediaListener = (event: MediaQueryListEvent) => {
        systemDark.value = event.matches
        if (settings.followSystem) applyCurrentUiTheme()
      }
      mediaQuery.addEventListener('change', mediaListener)
    }

    try {
      const saved = (await window.api.invoke(
        'settings',
        'appearance:get',
        'global'
      )) as Partial<AppearanceSettings> | null
      if (saved) {
        if (typeof saved.uiTheme === 'string' && themeRegistry.getUi(saved.uiTheme)) {
          settings.uiTheme = saved.uiTheme
        }
        if (typeof saved.terminalTheme === 'string' && themeRegistry.getTerminal(saved.terminalTheme)) {
          settings.terminalTheme = saved.terminalTheme
        }
        if (typeof saved.followSystem === 'boolean') settings.followSystem = saved.followSystem
      }
    } catch (error) {
      console.warn('[appearance] 读取设置失败，使用默认主题:', error)
    }

    applyCurrentUiTheme()
    initialized.value = true
  }

  function setUiTheme(id: string): void {
    if (!themeRegistry.getUi(id)) return
    settings.uiTheme = id
    settings.followSystem = false
    applyCurrentUiTheme()
    void persist()
  }

  function setTerminalTheme(id: string): void {
    if (!themeRegistry.getTerminal(id)) return
    settings.terminalTheme = id
    void persist()
  }

  function setFollowSystem(enabled: boolean): void {
    settings.followSystem = enabled
    applyCurrentUiTheme()
    void persist()
  }

  return {
    settings,
    initialized,
    uiThemes,
    terminalThemes,
    uiTheme,
    terminalTheme,
    init,
    setUiTheme,
    setTerminalTheme,
    setFollowSystem
  }
})

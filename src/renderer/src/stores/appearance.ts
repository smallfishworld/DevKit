import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  normalizeTerminalTheme,
  type AppearanceSettings,
  type TerminalTheme
} from '../../../shared/theme'
import { applyUiTheme } from '../theme/apply'
import { themeRegistry } from '../theme/registry'

export const useAppearanceStore = defineStore('appearance', () => {
  const settings = ref<AppearanceSettings>({
    ...DEFAULT_APPEARANCE_SETTINGS,
    customTerminalThemes: []
  })
  const initialized = ref(false)
  const registryRevision = ref(0)
  const systemDark = ref(true)
  let mediaQuery: MediaQueryList | null = null
  let saveQueue: Promise<unknown> = Promise.resolve()

  const uiThemes = computed(() => themeRegistry.listUi())
  const terminalThemes = computed(() => {
    void registryRevision.value
    return themeRegistry.listTerminal()
  })

  const uiTheme = computed(() => {
    const requested = settings.value.followSystem
      ? systemDark.value
        ? 'devkit-dark'
        : 'devkit-light'
      : settings.value.uiThemeId
    return themeRegistry.getUi(requested) ?? themeRegistry.getUi('devkit-dark')!
  })

  const terminalTheme = computed(() => {
    void registryRevision.value
    return (
      themeRegistry.getTerminal(settings.value.terminalThemeId) ??
      themeRegistry.getTerminal(DEFAULT_APPEARANCE_SETTINGS.terminalThemeId)!
    )
  })

  function applyCurrentUiTheme(): void {
    applyUiTheme(uiTheme.value)
  }

  function refreshCustomThemes(): void {
    themeRegistry.replaceCustomTerminalThemes(settings.value.customTerminalThemes)
    registryRevision.value += 1
    if (!themeRegistry.getTerminal(settings.value.terminalThemeId)) {
      settings.value.terminalThemeId = DEFAULT_APPEARANCE_SETTINGS.terminalThemeId
    }
  }

  function persist(): Promise<unknown> {
    const snapshot = JSON.parse(JSON.stringify(settings.value)) as AppearanceSettings
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(() => window.api.invoke('settings', 'appearance:set', 'global', snapshot))
    return saveQueue
  }

  function bindSystemTheme(): void {
    if (mediaQuery) return
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mediaQuery.matches
    mediaQuery.addEventListener('change', (event) => {
      systemDark.value = event.matches
      if (settings.value.followSystem) applyCurrentUiTheme()
    })
  }

  async function initialize(): Promise<void> {
    bindSystemTheme()
    // 首屏先应用内置默认主题；读取磁盘配置后再无刷新切换到用户上次选择。
    applyCurrentUiTheme()
    try {
      const raw = await window.api.invoke('settings', 'appearance:get', 'global')
      settings.value = normalizeAppearanceSettings(raw)
      if (!themeRegistry.getUi(settings.value.uiThemeId)) {
        settings.value.uiThemeId = DEFAULT_APPEARANCE_SETTINGS.uiThemeId
      }
      refreshCustomThemes()
    } catch {
      settings.value = { ...DEFAULT_APPEARANCE_SETTINGS, customTerminalThemes: [] }
      refreshCustomThemes()
    }
    applyCurrentUiTheme()
    initialized.value = true
  }

  function setUiTheme(id: string): void {
    if (!themeRegistry.getUi(id)) return
    settings.value.uiThemeId = id
    applyCurrentUiTheme()
    void persist()
  }

  function setFollowSystem(enabled: boolean): void {
    settings.value.followSystem = enabled
    applyCurrentUiTheme()
    void persist()
  }

  function setTerminalTheme(id: string): void {
    if (!themeRegistry.getTerminal(id)) return
    settings.value.terminalThemeId = id
    void persist()
  }

  function upsertCustomTerminalTheme(theme: TerminalTheme): boolean {
    const normalized = normalizeTerminalTheme({ ...theme, builtin: false })
    if (!normalized || themeRegistry.isBuiltinTerminal(normalized.id)) return false

    const next = settings.value.customTerminalThemes.filter((item) => item.id !== normalized.id)
    next.push({ ...normalized, builtin: false })
    settings.value.customTerminalThemes = next
    refreshCustomThemes()
    settings.value.terminalThemeId = normalized.id
    void persist()
    return true
  }

  function removeCustomTerminalTheme(id: string): void {
    if (themeRegistry.isBuiltinTerminal(id)) return
    const next = settings.value.customTerminalThemes.filter((item) => item.id !== id)
    if (next.length === settings.value.customTerminalThemes.length) return
    settings.value.customTerminalThemes = next
    if (settings.value.terminalThemeId === id) {
      settings.value.terminalThemeId = DEFAULT_APPEARANCE_SETTINGS.terminalThemeId
    }
    refreshCustomThemes()
    void persist()
  }

  return {
    settings,
    initialized,
    uiThemes,
    terminalThemes,
    uiTheme,
    terminalTheme,
    initialize,
    setUiTheme,
    setFollowSystem,
    setTerminalTheme,
    upsertCustomTerminalTheme,
    removeCustomTerminalTheme
  }
})

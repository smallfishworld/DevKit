import type { ToolService } from '../../ipc'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings
} from '../../../shared/theme'
import { getSection, setSection } from '../macro/configStore'
import {
  DEFAULT_LOCALE_SETTINGS,
  sanitizeAppLocale,
  sanitizeLocaleSettings,
  type LocaleSettings
} from '../../../shared/locale'
import { setAppLocale } from '../../app-locale'

function sanitizeAppearance(value: unknown): AppearanceSettings {
  const raw = (value ?? {}) as Partial<AppearanceSettings>
  return {
    uiTheme: typeof raw.uiTheme === 'string' ? raw.uiTheme : DEFAULT_APPEARANCE_SETTINGS.uiTheme,
    terminalTheme:
      typeof raw.terminalTheme === 'string'
        ? raw.terminalTheme
        : DEFAULT_APPEARANCE_SETTINGS.terminalTheme,
    followSystem:
      typeof raw.followSystem === 'boolean'
        ? raw.followSystem
        : DEFAULT_APPEARANCE_SETTINGS.followSystem
  }
}

export const settingsService: ToolService = {
  async invoke(_panelId, action, payload) {
    switch (action) {
      case 'appearance:get': {
        const saved = await getSection<AppearanceSettings>('appearance', DEFAULT_APPEARANCE_SETTINGS)
        return sanitizeAppearance(saved)
      }
      case 'appearance:set': {
        const settings = sanitizeAppearance(payload)
        await setSection('appearance', settings)
        return settings
      }
      case 'locale:get': {
        const saved = await getSection<LocaleSettings>('locale', DEFAULT_LOCALE_SETTINGS)
        return setAppLocale(sanitizeLocaleSettings(saved).language)
      }
      case 'locale:set': {
        const language = sanitizeAppLocale(payload)
        await setSection<LocaleSettings>('locale', { language })
        return setAppLocale(language)
      }
      default:
        throw new Error(`未知设置操作: ${action}`)
    }
  }
}

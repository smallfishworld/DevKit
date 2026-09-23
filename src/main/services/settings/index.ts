import type { ToolService } from '../../ipc'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings
} from '../../../shared/theme'
import { getSection, setSection } from '../macro/configStore'

class SettingsService implements ToolService {
  invoke(_panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'appearance:get':
        return this.getAppearance()
      case 'appearance:set':
        return this.setAppearance(payload)
      default:
        throw new Error(`未知 settings action: ${action}`)
    }
  }

  private async getAppearance(): Promise<AppearanceSettings> {
    const stored = await getSection<AppearanceSettings>('appearance', DEFAULT_APPEARANCE_SETTINGS)
    return normalizeAppearanceSettings(stored)
  }

  private async setAppearance(payload: unknown): Promise<AppearanceSettings> {
    const settings = normalizeAppearanceSettings(payload)
    await setSection('appearance', settings)
    return settings
  }
}

export const settingsService = new SettingsService()

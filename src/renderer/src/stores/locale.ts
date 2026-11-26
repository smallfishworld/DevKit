import { defineStore } from 'pinia'
import { DEFAULT_APP_LOCALE, sanitizeAppLocale, type AppLocale } from '../../../shared/locale'
import { setI18nLocale } from '../i18n'

export const useLocaleStore = defineStore('locale', {
  state: () => ({
    locale: DEFAULT_APP_LOCALE as AppLocale,
    initialized: false,
    saveSequence: 0
  }),
  actions: {
    apply(locale: AppLocale): void {
      this.locale = locale
      setI18nLocale(locale)
    },
    async init(): Promise<void> {
      if (this.initialized) return
      try {
        const saved = await window.api.invoke('settings', 'locale:get', 'app')
        this.apply(sanitizeAppLocale(saved))
      } catch {
        this.apply(DEFAULT_APP_LOCALE)
      } finally {
        this.initialized = true
      }
    },
    async setLocale(value: AppLocale): Promise<void> {
      const locale = sanitizeAppLocale(value)
      const sequence = ++this.saveSequence
      this.apply(locale)
      try {
        const saved = sanitizeAppLocale(await window.api.invoke('settings', 'locale:set', 'app', locale))
        if (sequence === this.saveSequence) this.apply(saved)
      } catch {
        // Keep the requested language for this session even if persistence fails.
      }
    }
  }
})

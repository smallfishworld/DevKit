export const APP_LOCALES = ['zh-CN', 'en'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

export interface LocaleSettings {
  language: AppLocale
}

export const DEFAULT_APP_LOCALE: AppLocale = 'zh-CN'

export const DEFAULT_LOCALE_SETTINGS: LocaleSettings = {
  language: DEFAULT_APP_LOCALE
}

export function sanitizeAppLocale(value: unknown): AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value)
    ? value as AppLocale
    : DEFAULT_APP_LOCALE
}

export function sanitizeLocaleSettings(value: unknown): LocaleSettings {
  const raw = value && typeof value === 'object' ? value as Partial<LocaleSettings> : {}
  return { language: sanitizeAppLocale(raw.language) }
}

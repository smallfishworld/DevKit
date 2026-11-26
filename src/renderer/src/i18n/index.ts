import { createI18n } from 'vue-i18n'
import type { AppLocale } from '../../../shared/locale'
import { DEFAULT_APP_LOCALE } from '../../../shared/locale'
import { toolUiMessages } from './tool-ui'
import { extraToolMessages } from './extra-tools'
import { shellUiMessages } from './shell-ui'
import { panelsUiMessages } from './panels-ui'
import { diffUiMessages } from './diff-ui'
import { bridgeUiMessages } from './bridge-ui'
import { macroUiMessages } from './macro-ui'
import { pluginsUiMessages } from './plugins-ui'
import { serialUiMessages } from './serial-ui'

export const messages = {
  'zh-CN': {
    ...toolUiMessages['zh-CN'],
    ...extraToolMessages['zh-CN'],
    ...shellUiMessages['zh-CN'],
    ...panelsUiMessages['zh-CN'],
    ...diffUiMessages['zh-CN'],
    ...bridgeUiMessages['zh-CN'],
    ...macroUiMessages['zh-CN'],
    ...pluginsUiMessages['zh-CN'],
    ...serialUiMessages['zh-CN'],
    common: { close: '关闭', current: '当前' },
    language: { label: '界面语言', zhCN: '简体中文', en: 'English' },
    settings: {
      button: '设置', title: '设置', aria: '应用设置',
      appearance: '外观与终端配色', close: '关闭设置浮层',
      followSystem: '跟随系统', followSystemHint: '按 Windows 浅色/深色自动切换（深色用 DevKit 默认，浅色用 Solarized Light）',
      filterPlaceholder: '筛选配色（如 nord、solar）', filterAria: '筛选配色', noTheme: '没有匹配的配色',
      following: '跟随系统 · 当前 {name}', currentTheme: '当前 · {name}', themeHint: '配色同时应用到整个界面与终端'
    },
    shell: {
      suite: 'DevKit 嵌入式开发套件', version: '版本 {version}', versionInfo: '版本信息与检查更新',
      updateAvailableAria: '有可用更新', extensions: '扩展', extensionCenter: '扩展中心',
      appearance: '外观', minimize: '最小化', restore: '还原', maximize: '最大化', close: '关闭',
      quickOpen: '快速打开工具或切换会话', quickSwitch: '快速切换', switchAppearance: '切换外观与终端配色',
      clickCheckUpdate: '点击检查应用更新', moveBackHint: '拖动标签可移回主窗口', moveBack: '移回主窗口',
      toggleMaximize: '最大化或还原', closeWindow: '关闭窗口', serial: '串口', terminal: '终端'
    }
  },
  en: {
    ...toolUiMessages.en,
    ...extraToolMessages.en,
    ...shellUiMessages.en,
    ...panelsUiMessages.en,
    ...diffUiMessages.en,
    ...bridgeUiMessages.en,
    ...macroUiMessages.en,
    ...pluginsUiMessages.en,
    ...serialUiMessages.en,
    common: { close: 'Close', current: 'Current' },
    language: { label: 'Language', zhCN: '简体中文', en: 'English' },
    settings: {
      button: 'Settings', title: 'Settings', aria: 'Application settings',
      appearance: 'Appearance & terminal theme', close: 'Close settings',
      followSystem: 'Follow system', followSystemHint: 'Switch automatically with Windows light/dark mode (DevKit Default for dark, Solarized Light for light)',
      filterPlaceholder: 'Filter themes (for example nord or solar)', filterAria: 'Filter themes', noTheme: 'No matching themes',
      following: 'Following system · Current: {name}', currentTheme: 'Current · {name}', themeHint: 'The theme applies to the whole interface and terminals'
    },
    shell: {
      suite: 'DevKit Embedded Development Suite', version: 'Version {version}', versionInfo: 'Version information and updates',
      updateAvailableAria: 'Update available', extensions: 'Extensions', extensionCenter: 'Extension Center',
      appearance: 'Appearance', minimize: 'Minimize', restore: 'Restore', maximize: 'Maximize', close: 'Close',
      quickOpen: 'Open a tool or switch sessions', quickSwitch: 'Quick switch', switchAppearance: 'Change appearance and terminal theme',
      clickCheckUpdate: 'Check for application updates', moveBackHint: 'Drag the tab back to the main window', moveBack: 'Move to main window',
      toggleMaximize: 'Maximize or restore', closeWindow: 'Close window', serial: 'Serial', terminal: 'Terminal'
    }
  }
} as const

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_APP_LOCALE,
  fallbackLocale: DEFAULT_APP_LOCALE,
  messages
})

export function setI18nLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
}

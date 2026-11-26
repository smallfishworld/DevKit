import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as Icons from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './styles/global.css'
import { DEVKIT_TERMINAL_THEME, applyUiTheme } from './theme'
import { uiThemeFromTerminal } from '../../shared/theme'
import { installPanelOverlays } from './composables/panelOverlays'
import { i18n } from './i18n'
import { useLocaleStore } from './stores/locale'

// 首屏先应用默认终端主题衍生的界面配色，随后 AppearanceStore 会从
// userData/config.json 恢复用户选中的终端主题。
applyUiTheme(uiThemeFromTerminal(DEVKIT_TERMINAL_THEME))

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)
  app.use(i18n)
  app.use(ElementPlus)
  installPanelOverlays(app)

  // 图标全局注册，模板里用 <component :is="名字"> 解析
  for (const [name, component] of Object.entries(Icons)) {
    app.component(name, component)
  }

  // 首次挂载前恢复语言，避免已选择 English 时先闪现中文；切换语言不会重建 App。
  await useLocaleStore(pinia).init()
  app.mount('#app')
}

void bootstrap()

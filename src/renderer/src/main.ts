import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as Icons from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './styles/global.css'
import { DEVKIT_TERMINAL_THEME, applyUiTheme } from './theme'
import { uiThemeFromTerminal } from '../../shared/theme'

// 首屏先应用默认终端主题衍生的界面配色，随后 AppearanceStore 会从
// userData/config.json 恢复用户选中的终端主题。
applyUiTheme(uiThemeFromTerminal(DEVKIT_TERMINAL_THEME))

const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })

// 图标全局注册，模板里用 <component :is="名字"> 解析
for (const [name, component] of Object.entries(Icons)) {
  app.component(name, component)
}

app.mount('#app')

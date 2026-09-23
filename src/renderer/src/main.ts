import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as Icons from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './styles/global.css'
import { useAppearanceStore } from './stores/appearance'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(ElementPlus, { locale: zhCn })

// 图标全局注册，模板里用 <component :is="名字"> 解析
for (const [name, component] of Object.entries(Icons)) {
  app.component(name, component)
}

// initialize() 在首次 await 前会同步应用默认 DevKit Dark，避免首屏闪成 Element Plus 默认亮色；
// 随后从 userData/config.json 恢复用户上次的 UI/终端主题。
const appearance = useAppearanceStore(pinia)
void appearance.initialize()

app.mount('#app')

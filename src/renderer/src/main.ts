import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as Icons from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './styles/global.css'

document.documentElement.classList.add('dark')

const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })

// 图标全局注册，模板里用 <component :is="名字"> 解析
for (const [name, component] of Object.entries(Icons)) {
  app.component(name, component)
}

app.mount('#app')

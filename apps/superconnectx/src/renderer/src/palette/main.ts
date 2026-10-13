/**
 * 命令面板窗口入口(独立 BrowserWindow)。
 * 与主窗口共用 i18n / Element Plus,挂载 palette/App.vue。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { i18n } from '../locales'
import App from './App.vue'

const app = createApp(App)
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus, { locale: zhCn }).use(i18n).mount('#app')

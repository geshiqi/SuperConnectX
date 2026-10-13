/**
 * 命令面板窗口入口(独立 BrowserWindow)。
 * 与主窗口共用 i18n / Element Plus / 主题体系,挂载 palette/App.vue。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import '@superx/foundation/theme/themes.css'
import { useTheme } from '@superx/foundation/theme/useTheme'
import { i18n } from '../locales'
import App from './App.vue'

// 应用 localStorage 记忆的主题(与主窗口同源时共享);打包后 file:// 隔离场景由 App.vue 经主进程中继同步
useTheme()

const app = createApp(App)
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus, { locale: zhCn }).use(i18n).mount('#app')

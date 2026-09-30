import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { router } from '@/router'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import '@/styles/main.css'
import { applyTheme } from '@/composables/theme'

applyTheme()

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 全局事件：401 → 先清会话（丢弃残留的 me/权限，避免返回首页短暂渲染越权菜单）→ 跳登录
window.addEventListener('panel:unauthorized', () => {
  const auth = useAuthStore()
  auth.clearSession()
  router.push({ name: 'login' })
})
window.addEventListener('panel:csrf-expired', () => {
  window.location.reload()
})

// API 版本校验：前后端错配会产生难以定位的 bug，启动时显式检查
if (import.meta.env.PROD) {
  api.get<{ api: string }>('/api/v1/version')
    .then((v) => {
      if (v && v.api !== '1.0') {
        console.warn(`[panel] API 版本不匹配（后端 ${v.api} / 前端 1.0），请升级面板`)
      }
    })
    .catch(() => { /* 未登录时可忽略 */ })
}

app.mount('#app')

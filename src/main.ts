import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { router } from '@/router'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import '@/styles/main.css'
import { applyTheme } from '@/composables/theme'
import { tableNav } from '@/composables/tableNav'

applyTheme()

const app = createApp(App)
app.use(createPinia())
app.use(router)
// C7：数据表键盘方向键行导航（roving tabindex）。给主数据 <table> 加 v-table-nav 即可。
app.directive('table-nav', tableNav)

/**
 * 最后一道兜底：错误边界（ErrorBoundary）拦不住的那些——watcher / 生命周期钩子 /
 * 异步 setup 里抛出的异常。只进 console 用户永远看不到，所以必须给可见反馈。
 *
 * ⚠ 与边界分工：边界捕获后返回 false 阻止冒泡，所以不会重复弹两次。
 */
app.config.errorHandler = (err, _instance, info) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[panel] 未捕获异常（${info}）：`, err)
  // 动态 import 避免 main.ts 顶层依赖 toast 模块的初始化顺序
  void import('@/composables/useToast').then(({ toast }) => {
    toast(`页面出现异常：${msg}`, 'err')
  })
}

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
  api.get<{ api: string }>(API.version())
    .then((v) => {
      if (v && v.api !== '1.0') {
        console.warn(`[panel] API 版本不匹配（后端 ${v.api} / 前端 1.0），请升级面板`)
      }
    })
    .catch(() => { /* 未登录时可忽略 */ })
}

app.mount('#app')

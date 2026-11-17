// @vitest-environment jsdom
/**
 * 顶栏铃铛徽标必须读**共享 store**，而不是布局自己的一份 ref。
 *
 * 这是「通知页显示未读 0、顶栏仍显示 3」那类 bug 的接线判据：只有 store
 * 变化能驱动徽标，两侧才可能同一帧一致。真挂载 MainLayout 后直接改 store，
 * 观察 DOM——源码断言 `unread` 字样无法证明它来自哪里。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'

// useTablePrefs 在模块作用域调 window.matchMedia（jsdom 没有），必须在 import
// MainLayout 之前打桩；静态 import 会被提升，故用动态 import。
let MainLayout: typeof import('./MainLayout.vue')['default']
beforeAll(async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q, matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }))
  MainLayout = (await import('./MainLayout.vue')).default
})

const Dummy = defineComponent({ render: () => h('div', 'page') })

let app: App | null = null
let host: HTMLElement | null = null

beforeEach(async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'dashboard', component: Dummy, meta: { title: '概览' } },
      { path: '/notifications', name: 'notifications', component: Dummy },
      { path: '/assistant', name: 'assistant', component: Dummy },
      { path: '/settings', name: 'settings', component: Dummy },
      { path: '/login', name: 'login', component: Dummy },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: Dummy },
    ],
  })
  await router.push('/')
  await router.isReady()

  const auth = useAuthStore()
  auth.me = { user: 'admin', role: 'owner', permissions: ['*'], allowed_roots: ['/'], tier: 'standard' }
  auth.capabilities = {}

  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MainLayout as never)
  app.use(pinia)
  app.use(router)
  app.mount(host)
  await nextTick()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

const badge = () => document.querySelector('.bell .badge-dot') as HTMLElement | null
const bell = () => document.querySelector('.bell') as HTMLElement | null

describe('顶栏通知徽标：共享 store 接线', () => {
  it('store 写入 3 → 徽标 3；清零 → 徽标消失（不需要等轮询）', async () => {
    const notifications = useNotificationsStore()

    notifications.setUnread(3)
    await nextTick()
    expect(badge()?.textContent).toBe('3')
    expect(bell()?.getAttribute('title')).toBe('未读通知 3 条')

    notifications.setUnread(0)
    await nextTick()
    expect(badge()).toBeNull()
    expect(bell()?.getAttribute('title')).toBe('通知')
  })

  it('超过 99 显示 99+（避免窄屏徽标无限撑宽）', async () => {
    const notifications = useNotificationsStore()
    notifications.setUnread(120)
    await nextTick()
    expect(badge()?.textContent).toBe('99+')
  })
})

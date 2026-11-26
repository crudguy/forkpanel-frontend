// @vitest-environment jsdom
/**
 * 「顶栏 AI 入口已删、侧边栏是唯一入口」的 DOM 回归判据。
 *
 * 为什么真挂载：vue-tsc / 源码字符串断言都看不到模板最终渲染出什么。
 * 而「选择器写错」会让 `querySelector('.ai-entry') === null` 恒绿——
 * 故先做阳性对照（往顶栏塞一颗已知节点，选择器必须命中），再断言真实
 * 顶栏里没有它。侧栏那条入口同时断言还在，防止「去重」变成「功能丢失」。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

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
      { path: '/assistant', name: 'assistant', component: Dummy, meta: { title: 'AI 助手' } },
      { path: '/login', name: 'login', component: Dummy },
      // SideNav 会渲染全部导航项，兜底路由消掉「No match found」噪音
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

describe('顶栏去重：AI 助手只留侧边栏入口', () => {
  it('顶栏不再渲染 .ai-entry（先证明选择器有效，避免恒绿）', () => {
    const topbar = document.querySelector('.topbar') as HTMLElement | null
    expect(topbar, 'MainLayout 应已挂载出顶栏').not.toBeNull()

    const probe = document.createElement('a')
    probe.className = 'ai-entry'
    topbar!.appendChild(probe)
    expect(document.querySelector('.ai-entry')).toBe(probe) // 阳性对照
    probe.remove()

    expect(document.querySelector('.ai-entry')).toBeNull()
    expect(topbar!.textContent).not.toContain('AI 助手')
  })

  it('侧栏仍保留 AI 助手入口（去重不能把功能一起删掉）', () => {
    // 不能断言 textContent：禁用项的 .off-why 是 <a> 内的可见原因文本节点，
    // 会把「AI 助手」变成「AI 助手权限不足」——那是可访问性改进，不是功能丢失。
    // aria-label 恒等于 it.label（SideNav 模板 :aria-label="it.label"），
    // 既不受原因文本影响，又顺带验证读屏名字仍在；删掉入口仍会红，严格度不降。
    const labels = Array.from(document.querySelectorAll('.side a'))
      .map((a) => a.getAttribute('aria-label'))
    expect(labels).toContain('AI 助手')
  })
})

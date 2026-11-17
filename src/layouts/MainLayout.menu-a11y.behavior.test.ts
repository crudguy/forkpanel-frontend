// @vitest-environment jsdom
/**
 * 用户菜单的**弹层契约**行为测试（真挂载 MainLayout）。
 *
 * 取代原先只在源码里断言 `aria-haspopup="menu"` 的那类校验——那句话本身就是 bug：
 * 面板里既没有被 `role="menu"` 约束的 menuitem，也没有方向键导航，读屏却会按
 * 「菜单」的键盘模型期待交互。本测试盯住三件用户可观察的事：
 *   ① 触发器只声明 aria-expanded / aria-controls，且 controls 指向的面板真实存在、
 *      带 role 与名字（disclosure，不是 menu）；
 *   ② Esc 在**菜单内部**按下也能关掉，并把焦点交还触发钮（原先 escape 只挂在
 *      触发钮上，焦点一进菜单就再也关不掉）；
 *   ③ 点遮罩关闭。
 *
 * ⚠ 这三条都只能真挂载后观察：vue-tsc / 构建 / 源码字符串断言对它们全绿。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// useTablePrefs 在模块作用域就调 window.matchMedia（jsdom 没有），必须在 import
// MainLayout **之前**打桩；静态 import 会被提升到桩前面，故改用动态 import。
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
    // 顶栏按名字引用这几条路由（通知 / AI / 设置 / 登录），缺一条 RouterLink 就会抛错
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

  // 能力位全空：顶栏的信息性胶囊与维护簇自然不渲染，测试只关心用户菜单
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

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null
const trigger = () => document.querySelector('.user') as HTMLButtonElement
const panel = () => document.querySelector('#user-menu') as HTMLElement | null

function pressEsc(el: Element) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

describe('用户菜单：disclosure 契约', () => {
  it('触发器声明 expanded + controls，面板有 role 与名字，且不谎称 menu', async () => {
    const btn = trigger()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.hasAttribute('aria-haspopup')).toBe(false)

    btn.click()
    await nextTick()

    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const id = btn.getAttribute('aria-controls')!
    expect(id).toBe('user-menu')
    const p = document.getElementById(id)!
    expect(p).toBeTruthy()
    expect(p.getAttribute('role')).toBe('group')
    expect(p.getAttribute('aria-label')).toBe('用户菜单')
    // 菜单语义的硬要求（方向键导航）没有实现，就不许出现 role=menu
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('焦点在菜单内部时按 Esc 也能关闭，并把焦点交还触发钮', async () => {
    trigger().click()
    await nextTick()
    const p = panel()!
    const inside = p.querySelector('button') as HTMLButtonElement
    inside.focus()
    expect(document.activeElement).toBe(inside)

    pressEsc(inside)
    await nextTick()

    expect(panel()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('点遮罩关闭菜单（遮罩对读屏不可见）', async () => {
    trigger().click()
    await nextTick()
    const backdrop = document.querySelector('.backdrop') as HTMLElement
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    backdrop.click()
    await nextTick()
    expect(panel()).toBeNull()
  })
})

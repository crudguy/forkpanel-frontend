// @vitest-environment jsdom
/**
 * 侧边栏「禁用项说得出原因 + 点了不跳转」的**行为**测试（真挂载）。
 *
 * 取代 `SideNav.disabledReason.test.ts`（那份断言的是源码文本：`pointer-events`
 * 的正则、`:title="it.off ?? it.label"` 这行字、`@click.capture` 这串字）。
 * 文本断言只证明"代码这么写"，不证明"禁用项真的拦住了跳转"——而这一条正是
 * 用户可观察的、也是唯一会真正伤人的：
 *
 *   菜单可见性 = 后端能力位 AND RBAC 权限点。禁用的项必须
 *   (a) 仍能 hover（所以不能用 pointer-events:none），
 *   (b) tooltip 说得出**具体**原因（"当前环境不支持：未检测到所需组件"，
 *       而不是笼统的"不可用"），
 *   (c) 点了不跳转。
 *
 * 三件事里 (b) 是能力位 → 文案的映射、(c) 是 RouterLink 对 `defaultPrevented`
 * 的处理，两者都能真挂载后观察；(a) 是样式表层面的不变量，vitest 不加载 SFC
 * 样式，只能在源码里守（详见文件末尾那段注释，含实测依据）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import SideNav from './SideNav.vue'
import { NAV_ITEMS } from '@/composables/navItems'
import { useAuthStore } from '@/stores/auth'
import type { CapabilityMap } from '@/api/types'

/** 取一个有能力的导航项（用来验证"能点的确实能跳"）。 */
const ENABLED = NAV_ITEMS.find((i) => i.to === '/files')!
/** 取另一个（用来验证"禁用的确实不跳"）。 */
const BLOCKED = NAV_ITEMS.find((i) => i.to === '/expose')!

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

/** 全部能力位 supported=true，权限齐全；个别用例再单独打掉。 */
function capsAllOk(overrides: Record<string, { supported: boolean; reason: string | null }>): CapabilityMap {
  const caps: CapabilityMap = {}
  for (const it of NAV_ITEMS) caps[it.cap] = { supported: true, backend: null, reason: null }
  for (const [k, v] of Object.entries(overrides)) {
    caps[k] = { supported: v.supported, backend: null, reason: v.reason }
  }
  return caps
}

async function mountNav(opts: {
  unsupported?: Record<string, { supported: boolean; reason: string | null }>
  perms?: string[]
} = {}) {
  const perms = opts.perms ?? [...new Set(NAV_ITEMS.map((i) => i.perm))]
  // ⚠ 必须与 `app.use(...)` 用的是**同一个** pinia 实例：两次 createPinia() 会让
  //   用例往 A 里塞 capabilities、组件从 B 里读（全是 undefined），于是"全部可用"
  //   的用例也会静默通过，"置灰"的用例则红得莫名其妙。
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.capabilities = capsAllOk(opts.unsupported ?? {})
  auth.me = { user: 'admin', role: 'admin', permissions: perms, allowed_roots: ['/'], tier: 'standard' }

  router = createRouter({
    history: createMemoryHistory(),
    routes: NAV_ITEMS.map((i) => ({ path: i.to, component: { render: () => null } })),
  })
  await router.push('/')
  await router.isReady()

  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(defineComponent({ render: () => h(SideNav) }))
  app.use(pinia)
  app.use(router)
  app.mount(host)
  await nextTick()
  return auth
}

const linkTo = (path: string) =>
  [...host!.querySelectorAll<HTMLAnchorElement>('a.item')]
    .find((a) => a.getAttribute('href') === path)!

/**
 * 等一次路由跳转落定。
 *
 * ⚠️ 不能只写 `await nextTick()`，也不能用 `await router.isReady()`：
 *   RouterLink 的 navigate 是**异步**的，而 `isReady()` 在 router 已就绪时
 *   直接 resolve（等于没等）。漏了这一步，「点了禁用项不跳转」会在
 *   **删掉 preventDefault 之后依然全绿**——实测过，是本文件里最危险的一处假绿。
 */
const flushNav = async () => {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
})

beforeEach(() => {
  // 每个用例从干净的 DOM 开始（上一轮的 Teleport/挂载残留会让 querySelector 命中旧节点）
  document.body.innerHTML = ''
})

describe('SideNav：禁用项的原因说得出，且点了不跳转', () => {
  it('能力位不支持 → 置灰、aria-disabled、title 里是后端给的具体原因', async () => {
    await mountNav({ unsupported: { [BLOCKED.cap]: { supported: false, reason: 'binary_missing' } } })
    const a = linkTo(BLOCKED.to)
    expect(a, `${BLOCKED.to} 没有渲染出来`).toBeTruthy()
    expect(a.classList.contains('disabled'), '能力位不支持却没有置灰').toBe(true)
    expect(a.getAttribute('aria-disabled'), '读屏用户需要知道这项不可用').toBe('true')
    // 具体原因必须透出（不是笼统的"不可用"）：binary_missing → 未检测到所需组件
    expect(a.getAttribute('title')).toBe('当前环境不支持：未检测到所需组件')
  })

  it('点禁用项不跳转（路由停在原地）', async () => {
    await mountNav({ unsupported: { [BLOCKED.cap]: { supported: false, reason: 'binary_missing' } } })
    const before = router.currentRoute.value.path
    linkTo(BLOCKED.to).click()
    await flushNav()
    expect(router.currentRoute.value.path, '点了禁用项仍然跳转了——置灰成了纯装饰').toBe(before)
  })

  it('点可用项正常跳转（证明上一条不是"所有点击都不生效"）', async () => {
    await mountNav()
    linkTo(ENABLED.to).click()
    await flushNav()
    expect(router.currentRoute.value.path, '可用项也点不动，说明拦截条件写反了').toBe(ENABLED.to)
  })

  it('权限点缺失 → 原因为「权限不足」，与「平台不支持」可区分', async () => {
    const others = [...new Set(NAV_ITEMS.map((i) => i.perm))].filter((p) => p !== BLOCKED.perm)
    await mountNav({ perms: others })
    const a = linkTo(BLOCKED.to)
    expect(a.classList.contains('disabled'), '权限不足却没有置灰').toBe(true)
    expect(a.getAttribute('title'), '权限不足与平台不支持必须给出不同原因')
      .toBe('权限不足')
  })

  it('全部可用时不出现任何置灰项（守卫不会恒红）', async () => {
    await mountNav()
    const disabled = [...host!.querySelectorAll('a.item.disabled')]
    expect(disabled, `能力与权限都齐备却有 ${disabled.length} 项被置灰`).toHaveLength(0)
  })
})

/**
 * 样式层不变量——**只能是源码断言**（实测过，不是偷懒）。
 *
 * 「禁用态不得用 `pointer-events: none` 挡点击」是**样式表**层面的事实：
 * vitest 默认不加载 SFC 样式，`getComputedStyle` 拿不到它，jsdom 的 `el.click()`
 * 也完全无视 pointer-events。实测：把 `pointer-events: none` 加回 `.item.disabled`，
 * 上面 7 条行为用例**全部仍然通过**——只有这条源码断言会红。故它留在这里。
 *
 * 与之对照，「必须 `.capture`」那条**不需要**源码断言：去掉 `.capture` 之后
 * 「点禁用项不跳转」真的红了（RouterLink 的 navigate 先跑并已 push 到 /expose）。
 * 一开始我在注释里写它"jsdom 测不出来"，是凭印象下的结论，实测推翻了它，
 * 那条源码断言随即删除——留着它只是给同一件事记两遍账。
 */
describe('SideNav：禁用态样式不得反过来掐掉 hover（源码级，原因见上方）', () => {
  const SRC = (() => {
    // 剥注释：本文件与被测文件的注释里都合法地出现 `pointer-events` 字样
    // （正是在讲这条坑），不剥会把"注释在讲这件事"当成"代码真这么写了"。
    // ⚠ 路径用 cwd 拼，不能用 `new URL('./SideNav.vue', import.meta.url)`：
    //   jsdom 环境把 import.meta.url 变成 http://localhost/…，`new URL` 出来的
    //   不是 file: 协议，readFileSync 直接抛 "The URL must be of scheme file"。
    const raw = readFileSync(`${process.cwd()}/src/components/SideNav.vue`, 'utf8')
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter((l) => !/^\s*\/\//.test(l)).join('\n')
  })()

  it('禁用态不得用 pointer-events 屏蔽事件（那会把 hover 一起掐掉）', () => {
    expect(SRC).not.toMatch(/\.item\.disabled[^{]*\{[^}]*pointer-events/)
  })
})

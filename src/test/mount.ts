/**
 * 组件行为测试的真挂载工具（Q-06 前置物）。
 *
 * 不引 @vue/test-utils：项目已有的两个真挂载测试都走 `createApp` + `h()`，
 * 这里把那套样板收敛成一处，避免每个测试各写一遍 pinia / 清理 / flush。
 *
 * ⚠ 三个必须同一处的实例：pinia、能力矩阵、fetch 假件。
 *   两次 `createPinia()` 会让用例往 A 写 capabilities、组件从 B 读（全是
 *   undefined），"全部可用"的用例静默通过、"置灰"的用例红得莫名其妙。
 */
import { createApp, defineComponent, h, nextTick, type App, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { CAP, type Capability, type CapabilityMap } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { tableNav } from '@/composables/tableNav'
import { installApiFake, type ApiFake, type FakeRoute } from './apiFake'

export interface MountOptions {
  component: Component
  props?: Record<string, unknown>
  /** 路由表：key 用 `API.*()` 生成，值可以是常量或 (call) => 响应 */
  routes?: Record<string, FakeRoute>
  /** 能力矩阵；默认全部 supported=true */
  caps?: CapabilityMap
  /** RBAC 权限点；默认给一组常用管理权限 */
  perms?: string[]
}

export interface Mounted {
  host: HTMLElement
  app: App
  auth: ReturnType<typeof useAuthStore>
  fake: ApiFake
  flush: () => Promise<void>
  cleanup: () => void
}

/** 21 个能力位全部 supported=true；个别用例传 overrides 打掉某几位。 */
export function capsAllOk(overrides: Record<string, Partial<Capability>> = {}): CapabilityMap {
  const caps: CapabilityMap = {}
  for (const k of Object.values(CAP)) caps[k] = { supported: true, backend: null, reason: null }
  for (const [k, v] of Object.entries(overrides)) {
    caps[k] = { supported: true, backend: null, reason: null, ...v }
  }
  return caps
}

/** 让 `await fetch → await res.text() → 组件 await → 渲染` 整条链跑完。 */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await nextTick()
    await Promise.resolve()
  }
  await new Promise<void>((r) => setTimeout(r, 0))
  await nextTick()
}

const DEFAULT_PERMS = [
  'system.view', 'system.manage', 'db.view', 'db.manage',
  'container.view', 'container.manage', 'backup.view', 'backup.manage',
]

export async function mountView(opts: MountOptions): Promise<Mounted> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.capabilities = opts.caps ?? capsAllOk()
  auth.me = {
    user: 'admin', role: 'admin',
    permissions: opts.perms ?? DEFAULT_PERMS,
    allowed_roots: ['/'], tier: 'standard',
  }

  const fake = installApiFake(opts.routes ?? {})
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
  })
  await router.push('/')
  await router.isReady()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    render: () => h(opts.component, opts.props ?? {}),
  }))
  app.use(pinia)
  app.use(router)
  // 只复刻 main.ts **显式注册**的全局内容，缺了它测试环境比生产少一层，
  // 会冒出 `Failed to resolve directive: table-nav` 且与真机行为有偏差。
  // ⚠ 不要顺手在这里注册 `<Icon>`：生产 main.ts 并没有全局注册它，
  //   RefreshBtn 等组件里的 `Failed to resolve component: Icon` 是**真实的生产缺口**，
  //   在测试工具里偷偷补上等于把这个 bug 掩盖掉，warning 必须留着。
  app.directive('table-nav', tableNav)
  app.mount(host)
  await flushPromises()

  return {
    host, app, auth, fake,
    flush: flushPromises,
    cleanup: () => {
      app.unmount()
      host.remove()
      document.body.innerHTML = ''
      fake.restore()
    },
  }
}

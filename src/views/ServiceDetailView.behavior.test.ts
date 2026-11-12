// @vitest-environment jsdom
/**
 * ServiceDetailView 行为测试：锁死「状态 ↔ 启停按钮可用性」的联动与状态展示。
 *
 * 只做源码断言（按钮的 :disabled 表达式）挡不住「停止按钮在已停止时不禁用」这类
 * 回归——它在 vue-tsc / build 下全绿，用户却在已停止的服务上仍能点「停止」。
 * 真挂载组件 + API 假件，断言 DOM 里三个按钮的 disabled 状态随服务状态变化，
 * 并断言状态徽标真的显示了「运行中 / 已停止」。
 *
 * 路由参数：组件从 `route.params.unit` 取单元名，mountView 的兜底路由取不到，
 * 故 show 用空单元名登记（`API.services.show('')`），返回的 service 带真实 name
 * 供后续 journal/动作使用；本测试不触发动作，只验证初始渲染的禁用态与徽标。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import ServiceDetailView from '@/views/ServiceDetailView.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

// 有 service.manage 权限 + 全部能力 supported → canManage 为真，按钮随状态联动。
const PERMS = ['system.view', 'service.view', 'service.manage']

function btn(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`详情页找不到按钮「${text}」（定位失效会静默空集通过）`)
  return b
}

async function mountWithState(state: string, name = 'nginx.service', managed = true) {
  m = await mountView({
    component: ServiceDetailView,
    routes: {
      [API.services.show('')]: { service: { name, state, managed, enabled: true, description: null } },
      [API.services.journal(name)]: { lines: [] },
      [API.packages.list()]: { catalog: [] },
    },
    perms: PERMS,
  })
  return m!
}

describe('状态徽标：随时明确看到当前状态', () => {
  it('运行中 → 徽标显示「运行中」', async () => {
    const v = await mountWithState('active')
    expect(v.host.textContent).toContain('运行中')
  })
  it('已停止 → 徽标显示「已停止」', async () => {
    const v = await mountWithState('inactive')
    expect(v.host.textContent).toContain('已停止')
  })
})

describe('运行中 (active)', () => {
  it('启动禁用、停止/重启可用', async () => {
    const v = await mountWithState('active')
    expect(btn(v.host, '启动').disabled, '运行中不应能再启动').toBe(true)
    expect(btn(v.host, '停止').disabled, '运行中应能停止').toBe(false)
    expect(btn(v.host, '重启').disabled, '运行中应能重启').toBe(false)
  })
})

describe('已停止 (inactive)', () => {
  it('停止禁用、启动/重启可用', async () => {
    const v = await mountWithState('inactive')
    expect(btn(v.host, '停止').disabled, '已停止不应能再停止').toBe(true)
    expect(btn(v.host, '启动').disabled, '已停止应能启动').toBe(false)
    expect(btn(v.host, '重启').disabled, '已停止应能重启').toBe(false)
  })
})

describe('失败 (failed)', () => {
  it('视为未运行：停止禁用、启动/重启可用', async () => {
    const v = await mountWithState('failed')
    expect(btn(v.host, '停止').disabled).toBe(true)
    expect(btn(v.host, '启动').disabled).toBe(false)
    expect(btn(v.host, '重启').disabled).toBe(false)
  })
})

describe('过渡态不误触', () => {
  it('activating：三者统一禁用', async () => {
    const v = await mountWithState('activating')
    expect(btn(v.host, '启动').disabled).toBe(true)
    expect(btn(v.host, '停止').disabled).toBe(true)
    expect(btn(v.host, '重启').disabled).toBe(true)
  })
  it('deactivating：三者统一禁用', async () => {
    const v = await mountWithState('deactivating')
    expect(btn(v.host, '启动').disabled).toBe(true)
    expect(btn(v.host, '停止').disabled).toBe(true)
    expect(btn(v.host, '重启').disabled).toBe(true)
  })
})

describe('sshd 防失联', () => {
  it('sshd 运行中：停止仍禁用（即便正在运行）', async () => {
    const v = await mountWithState('active', 'sshd')
    expect(btn(v.host, '停止').disabled).toBe(true)
    expect(btn(v.host, '启动').disabled).toBe(true)
    expect(btn(v.host, '重启').disabled).toBe(false)
  })
})

describe('顶栏无独立刷新按钮（防冗余与闪烁）', () => {
  it('顶栏不再有独立刷新按钮：刷新职责归日志区 RefreshBtn 与启停动作回填', async () => {
    const v = await mountWithState('active')
    // 回归锁：曾在顶栏加过「刷新服务信息」图标按钮，与日志区刷新冗余，
    // 且会让操作按钮在刷新时闪成「执行中…」——必须保持移除。
    expect(v.host.querySelector('.refresh-local'),
      '顶栏不应再有独立刷新按钮（与日志区刷新冗余、且造成操作区闪烁）').toBeNull()
  })
})

describe('启停操作顺带回填 enabled（修 stale）', () => {
  it('运行中点「停止」：动作后 enabled 随 show 回填，而非沿用旧值', async () => {
    m = await mountView({
      component: ServiceDetailView,
      routes: {
        // loadSvc / 顶栏 show 用路由参数 unit=''；svcAct 动作用服务名 'nginx.service'
        [API.services.show('')]: { service: { name: 'nginx.service', state: 'active', managed: true, enabled: true, description: null } },
        [API.services.show('nginx.service')]: { service: { name: 'nginx.service', state: 'inactive', managed: true, enabled: true, description: null } },
        [API.services.stop('nginx.service')]: undefined,
        [API.services.status('nginx.service')]: { name: 'nginx.service', state: 'inactive' },
        [API.services.journal('nginx.service')]: { lines: [] },
        [API.packages.list()]: { catalog: [] },
      },
      perms: PERMS,
    })
    // 停服务（managed=true 直调 svcAct，无二次确认）
    const stop = m!.host.querySelector<HTMLButtonElement>('.m-acts .danger')!
    stop.click()
    await m!.flush()
    // 动作后 show 仍回 enabled=true，停服务不应改变自启态 ⇒ 仍「已启用」
    expect(m!.host.textContent).toContain('已启用')
    // 且确实发了 stop + status + show（动作用的服务名端点都命中）
    expect(m!.fake.count('/api/v1/services/nginx.service/stop')).toBe(1)
    expect(m!.fake.count('/api/v1/services/nginx.service/status')).toBeGreaterThanOrEqual(1)
    expect(m!.fake.count('/api/v1/services/nginx.service')).toBeGreaterThanOrEqual(1)
  })
})

describe('无管理权限', () => {
  it('即便运行中，三个按钮也全部禁用', async () => {
    m = await mountView({
      component: ServiceDetailView,
      routes: {
        [API.services.show('')]: { service: { name: 'nginx.service', state: 'active', managed: true, enabled: true, description: null } },
        [API.services.journal('nginx.service')]: { lines: [] },
        [API.packages.list()]: { catalog: [] },
      },
      // 缺 service.manage → canManage 为假
      perms: ['system.view', 'service.view'],
    })
    expect(btn(m!.host, '启动').disabled).toBe(true)
    expect(btn(m!.host, '停止').disabled).toBe(true)
    expect(btn(m!.host, '重启').disabled).toBe(true)
  })
})

describe('配置防呆：默认 drop-in + 新 drop-in 预填模板 + 非可写单元文件保存拦截', () => {
  const PERMS_CFG = ['system.view', 'service.view', 'service.manage']
  function btnByText(root: HTMLElement, sub: string): HTMLButtonElement {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((x) => x.textContent?.includes(sub))
    if (!b) throw new Error(`找不到含「${sub}」的按钮`)
    return b
  }
  function mountCfg(routes: Record<string, unknown>) {
    return mountView({ component: ServiceDetailView, routes: routes as any, perms: PERMS_CFG })
  }

  it('默认写入目标是 drop-in，且新 drop-in 预填 [Service] 起步模板', async () => {
    m = await mountCfg({
      [API.services.show('')]: { service: { name: 'nginx.service', state: 'active', managed: true, enabled: true, description: null } },
      [API.services.journal('nginx.service')]: { lines: [] },
      [API.packages.list()]: { catalog: [] },
      // 新 drop-in：exists=false、writable=true（位于 /etc）
      [API.services.config('')]: { path: '/etc/systemd/system/nginx.service.d/override.conf', content: '', writable: true, exists: false },
    })
    btnByText(m!.host, '配置').click()
    await m!.flush()
    // 默认选中 drop-in（段按钮带 active）——把安全项作为默认展示，规避用户往单元文件里塞配置
    const dropinBtn = btnByText(m!.host, 'drop-in')
    expect(dropinBtn.classList.contains('active'), '默认应选中 drop-in').toBe(true)
    // 新 drop-in 预填模板：文本框含 [Service] 段头，引导起步（避免空白框 + 忘写段头）
    const ta = m!.host.querySelector<HTMLTextAreaElement>('.lined-ta')
    expect(ta, '应渲染配置文本框').not.toBeNull()
    expect(ta!.value).toContain('[Service]')
  })

  it('直接保存位于发行版目录（/lib）的单元文件：先弹二次确认、不立即写', async () => {
    m = await mountCfg({
      [API.services.show('')]: { service: { name: 'nginx.service', state: 'active', managed: true, enabled: true, description: null } },
      [API.services.journal('nginx.service')]: { lines: [] },
      [API.packages.list()]: { catalog: [] },
      // 单元文件在 /lib（writable=false）→ 触发保存拦截；PUT 由同一路由键按 method 分发
      [API.services.config('')]: (ctx: any) =>
        ctx.method === 'GET'
          ? { path: '/lib/systemd/system/nginx.service', content: 'EXISTING', writable: false, exists: true }
          : null,
    })
    btnByText(m!.host, '配置').click()
    await m!.flush()
    btnByText(m!.host, '单元文件').click()
    await m!.flush()
    btnByText(m!.host, '保存配置').click()
    await m!.flush()
    // 二次确认框已弹出（Teleport 到 body），且尚未发出 PUT
    expect(document.body.textContent, '应弹出单元文件编辑确认框').toContain('位于发行版目录')
    expect(m!.fake.count(API.services.config(''), 'PUT'), '保存前应拦截、不立即写').toBe(0)
    // 确认执行后才真正写入
    btnByText(document.body, '确认执行').click()
    await m!.flush()
    expect(m!.fake.count(API.services.config(''), 'PUT'), '确认后才会写').toBeGreaterThanOrEqual(1)
  })
})

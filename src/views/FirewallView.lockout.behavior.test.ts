// @vitest-environment jsdom
// P0/P1：SSH 失联保护 + 禁用端口入口的真实挂载行为测试。
// 判据全部来自 DOM 与 POST body —— 源码文本断言抓不到「确认框没弹 / 高危开关没带」。
import { describe, it, expect, beforeEach } from 'vitest'
import FirewallView from './FirewallView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import { withToastHost, clearToasts, toastTexts, buttonByText, setInput } from '@/test/toastHarness'

const PERMS = ['firewall.manage', 'system.view', 'system.manage']

interface ApplyBody {
  rules: Array<{ ports: string; protocol: string; action: string }>
  allow_lockout_risk?: boolean
}

async function setup(protectedPorts: number[] = []): Promise<Mounted> {
  return mountView({
    component: withToastHost(FirewallView),
    caps: capsAllOk(),
    perms: PERMS,
    routes: {
      [API.firewall.rules()]: (c) => c.method === 'POST'
        ? { added: 1, removed: 0, unchanged: 0, warnings: [] }
        : { backend: 'ufw', active: true, rules: [], protected_ports: protectedPorts },
      [API.firewall.fail2ban()]: { available: false, active: false, jails: [] },
    },
  })
}

function actionSelect(m: Mounted): HTMLSelectElement {
  const el = m.host.querySelector<HTMLSelectElement>('select.fw-action')
  if (!el) throw new Error('找不到动作下拉框（select.fw-action）')
  return el
}

function portsInput(m: Mounted): HTMLInputElement {
  const el = m.host.querySelector<HTMLInputElement>('input[placeholder^="80,443"]')
  if (!el) throw new Error('找不到端口输入框')
  return el
}

/** Vue 受控 select 只能用原生 setter + change 事件（见项目 E2E 约定）。 */
function setAction(m: Mounted, value: string): void {
  const el = actionSelect(m)
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function prepare(m: Mounted): Promise<void> {
  buttonByText(m.host, '应用').click()
  await m.flush()
}

function dlg(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.mask')
  if (!el) throw new Error('确认框未出现')
  return el
}

function lastBody(m: Mounted): ApplyBody {
  return m.fake.lastBody(API.firewall.rules(), 'POST') as ApplyBody
}

beforeEach(clearToasts)

describe('防火墙禁用端口入口（真挂载）', () => {
  it('动作下拉含 allow/deny/reject，封禁普通端口的 POST 带 action=deny 但不带高危开关', async () => {
    const m = await setup()
    expect([...actionSelect(m).options].map(o => o.value)).toEqual(['allow', 'deny', 'reject'])

    setAction(m, 'deny')
    setInput(portsInput(m), '8080')
    await prepare(m)

    expect(dlg().textContent, '普通封禁不该弹高危确认').toContain('确认封禁端口')
    expect(dlg().querySelector('.btn-danger')).toBeNull()
    buttonByText(document, '确定').click()
    await m.flush()

    const body = lastBody(m)
    expect(body.rules[0].action).toBe('deny')
    expect(body.rules[0].ports).toBe('8080')
    expect(body.allow_lockout_risk, '未命中 SSH 端口不能带高危开关').toBeUndefined()
    expect(toastTexts()).toContain('已封禁端口 8080')
    m.fake.assertClean(); m.cleanup()
  })

  it('SSH 改到 2222 后封 2222：弹高危确认，POST 带 allow_lockout_risk=true', async () => {
    // 保护集由后端现读下发为 [22, 2222]，不再是写死的 [22]
    const m = await setup([22, 2222])
    setAction(m, 'deny')
    setInput(portsInput(m), '2222')
    await prepare(m)

    const d = dlg()
    expect(d.textContent).toContain('确认封禁 SSH 端口（高危）')
    expect(d.textContent, '确认框必须把失联后果说透').toContain('失联')
    expect(d.querySelector('.btn-danger'), '高危确认必须是 danger 样式').not.toBeNull()
    buttonByText(document, '确认执行').click()
    await m.flush()

    expect(lastBody(m).allow_lockout_risk).toBe(true)
    m.fake.assertClean(); m.cleanup()
  })

  it('放行 SSH 端口不弹高危、不带 allow_lockout_risk', async () => {
    const m = await setup([22, 2222])
    // 默认动作就是 allow
    setInput(portsInput(m), '2222')
    await prepare(m)

    expect(dlg().textContent).toContain('确认放行端口')
    expect(dlg().querySelector('.btn-danger')).toBeNull()
    buttonByText(document, '确定').click()
    await m.flush()

    const body = lastBody(m)
    expect(body.rules[0].action).toBe('allow')
    expect(body.allow_lockout_risk, '放行绝不能带上高危开关').toBeUndefined()
    m.fake.assertClean(); m.cleanup()
  })

  it('端口范围命中 SSH 时也走高危确认', async () => {
    const m = await setup([2222])
    setAction(m, 'reject')
    setInput(portsInput(m), '2200-2300')
    await prepare(m)

    expect(dlg().textContent).toContain('高危')
    m.fake.assertClean(); m.cleanup()
  })

  it('封 all 无条件弹高危确认，即使前端没拿到保护端口集', async () => {
    const m = await setup([])
    setAction(m, 'deny')
    setInput(portsInput(m), 'all')
    await prepare(m)

    expect(dlg().textContent).toContain('高危')
    m.fake.assertClean(); m.cleanup()
  })
})

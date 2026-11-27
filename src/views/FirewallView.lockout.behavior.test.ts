// @vitest-environment jsdom
// SSH 失联保护的真实挂载行为测试。
// 判据全部来自 DOM 与 POST body —— 源码文本断言抓不到「确认框没弹 / 迁移行没展开 /
// 新端口没带」这类静默失败。
import { describe, it, expect, beforeEach } from 'vitest'
import FirewallView from './FirewallView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import { withToastHost, clearToasts, toastTexts, buttonByText, setInput } from '@/test/toastHarness'
import { fakeError } from '@/test/apiFake'

const PERMS = ['firewall.manage', 'system.view', 'system.manage']

interface ApplyBody {
  rules: Array<{ ports: string; protocol: string; action: string }>
  new_ssh_port?: number
}

const OK_BODY = { added: 1, removed: 0, unchanged: 0, warnings: [] }

async function setup(
  protectedPorts: number[] = [],
  postResponse: Record<string, unknown> = OK_BODY,
): Promise<Mounted> {
  return mountView({
    component: withToastHost(FirewallView),
    caps: capsAllOk(),
    perms: PERMS,
    routes: {
      [API.firewall.rules()]: (c) => c.method === 'POST'
        ? postResponse
        : { backend: 'ufw', active: true, rules: [], protected_ports: protectedPorts,
            default_policy: 'accept', listening_ports: [22, 80, 4443] },
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

function newPortInput(m: Mounted): HTMLInputElement {
  const el = m.host.querySelector<HTMLInputElement>('input[placeholder="如 2222"]')
  if (!el) throw new Error('找不到新 SSH 端口输入框（命中 SSH 时应展开）')
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

function inlineError(m: Mounted): string {
  // 校验提示已改为就近挂在出问题的输入框下方（.field-err）；
  // 兼容仍走整段条（.err）的归属不明错误。
  return m.host.querySelector('.field-err')?.textContent ?? m.host.querySelector('.err')?.textContent ?? ''
}

function lastBody(m: Mounted): ApplyBody {
  return m.fake.lastBody(API.firewall.rules(), 'POST') as ApplyBody
}

beforeEach(clearToasts)

describe('防火墙禁用端口入口（真挂载）', () => {
  it('入站生效状态：22 作为监听端口以「默认放行」展示，并说清 accept 的含义', async () => {
    // 老板问「22 默认开启吗、为什么列表没有」：规则表只列显式规则，
    // 默认策略与监听端口是另一层只读观察值，必须单独可见。
    const m = await setup([22])
    const card = m.host.querySelector('.exposure-card')
    expect(card, '必须展示入站生效状态区').not.toBeNull()
    expect(card!.textContent).toContain('放行（accept）')
    expect(card!.textContent).toContain('未列出的端口默认可访问')
    // 文案 2026-11-27 精简：只说「只读、不对应规则」，不再解释 127.0.0.1/::1 的排除细节；
    // 封禁语义由「封禁优先于放行」承担（原「新封禁插到规则链首」是实现细节，已删）。
    expect(card!.textContent, '必须声明这些不是可删规则').toContain('只读')
    expect(card!.textContent, '必须声明这些不是可删规则').toContain('不对应规则')
    expect(card!.textContent, '必须说明封禁优先，否则用户会按列表顺序误判').toContain('封禁优先于放行')
    const chips = [...card!.querySelectorAll('.exposure-chip')].map(x => x.textContent?.trim() ?? '')
    expect(chips.some(t => t.startsWith('22') && t.includes('默认放行')), '22 应显示为默认放行').toBe(true)
    m.fake.assertClean(); m.cleanup()
  })

  it('动作下拉含 allow/deny/reject；普通封禁不展开迁移行，POST 不带 new_ssh_port', async () => {
    const m = await setup()
    expect([...actionSelect(m).options].map(o => o.value)).toEqual(['allow', 'deny', 'reject'])

    setAction(m, 'deny')
    setInput(portsInput(m), '8080')
    await m.flush()
    expect(m.host.querySelector('.migrate-row'), '未命中 SSH 不该展开新端口输入').toBeNull()

    await prepare(m)
    expect(dlg().textContent, '普通封禁不该弹高危确认').toContain('确认封禁端口')
    expect(dlg().querySelector('.btn-danger')).toBeNull()
    buttonByText(document, '确定').click()
    await m.flush()

    const body = lastBody(m)
    expect(body.rules[0].action).toBe('deny')
    expect(body.rules[0].ports).toBe('8080')
    expect(body.new_ssh_port, '未命中 SSH 不能带迁移端口').toBeUndefined()
    expect(toastTexts()).toContain('已封禁端口 8080')
    m.fake.assertClean(); m.cleanup()
  })

  it('SSH 改到 2222 后封 2222：未填新端口被拦；填了才弹须迁移确认，POST 带 new_ssh_port', async () => {
    // 保护集由后端现读下发为 [22, 2222]，不再是写死的 [22]
    const m = await setup([22, 2222], { ...OK_BODY, ssh_migrated_to: 2223 })
    setAction(m, 'deny')
    setInput(portsInput(m), '2222')
    await m.flush()

    // 输入阶段就展开，不必先点「应用」才知道要迁移
    expect(newPortInput(m)).toBeTruthy()

    // 没填新端口：不弹框、行内给出原因、不发 POST
    await prepare(m)
    expect(document.querySelector('.mask')).toBeNull()
    expect(inlineError(m)).toContain('请填写新 SSH 端口')

    setInput(newPortInput(m), '2223')
    await prepare(m)

    const d = dlg()
    expect(d.textContent).toContain('确认封禁 SSH 端口（须迁移）')
    expect(d.textContent, '确认框必须说明失联后果').toContain('失联')
    expect(d.textContent, '确认框必须说明失败回滚').toContain('回滚')
    expect(d.querySelector('.btn-danger'), '迁移确认必须是 danger 样式').not.toBeNull()
    buttonByText(document, '确认执行').click()
    await m.flush()

    expect(lastBody(m).new_ssh_port).toBe(2223)
    expect(toastTexts()).toContain('已将 SSH 迁移到端口 2223，请用新端口重新连接')
    m.fake.assertClean(); m.cleanup()
  })

  it('放行 SSH 端口不展开迁移行、不带 new_ssh_port', async () => {
    const m = await setup([22, 2222])
    // 默认动作就是 allow
    setInput(portsInput(m), '2222')
    await m.flush()
    expect(m.host.querySelector('.migrate-row')).toBeNull()

    await prepare(m)
    expect(dlg().textContent).toContain('确认放行端口')
    expect(dlg().querySelector('.btn-danger')).toBeNull()
    buttonByText(document, '确定').click()
    await m.flush()

    const body = lastBody(m)
    expect(body.rules[0].action).toBe('allow')
    expect(body.new_ssh_port, '放行绝不能带上迁移端口').toBeUndefined()
    m.fake.assertClean(); m.cleanup()
  })

  it('端口范围命中 SSH：新端口落在封禁范围内被拦，换范围外的端口才放行', async () => {
    const m = await setup([2222])
    setAction(m, 'reject')
    setInput(portsInput(m), '2200-2300')
    await m.flush()
    expect(newPortInput(m)).toBeTruthy()

    setInput(newPortInput(m), '2233')
    await prepare(m)
    expect(document.querySelector('.mask')).toBeNull()
    expect(inlineError(m)).toContain('封禁的端口范围内')

    setInput(newPortInput(m), '2323')
    await prepare(m)
    expect(dlg().textContent).toContain('须迁移')
    buttonByText(document, '确认执行').click()
    await m.flush()

    expect(lastBody(m).new_ssh_port).toBe(2323)
    m.fake.assertClean(); m.cleanup()
  })

  it('新端口等于当前自定义 SSH 端口被拦（不能只盯 22）', async () => {
    const m = await setup([22, 2222])
    setAction(m, 'deny')
    setInput(portsInput(m), '2222')
    await m.flush() // 等 migrationRequired 计算并重渲染，否则新端口行还没出现
    setInput(newPortInput(m), '2222')
    await prepare(m)

    expect(document.querySelector('.mask')).toBeNull()
    expect(inlineError(m)).toContain('与当前 SSH 端口相同')
    m.fake.assertClean(); m.cleanup()
  })

  it('封 all：展开迁移行，但任何新端口都无处可迁，行内提示缩小范围', async () => {
    // all 无条件命中，即使前端没拿到保护端口集
    const m = await setup([])
    setAction(m, 'deny')
    setInput(portsInput(m), 'all')
    await m.flush()
    expect(newPortInput(m)).toBeTruthy()

    setInput(newPortInput(m), '2222')
    await prepare(m)
    expect(document.querySelector('.mask')).toBeNull()
    expect(inlineError(m)).toContain('不能封禁全部端口')
    m.fake.assertClean(); m.cleanup()
  })

  it('后端 SSH 失联拦截（409/10005）显示中文原因，而不是「已有同名资源」', async () => {
    // 旧后端没下发 protected_ports 时前端无法提前提示，提交后仍靠后端兜底拦截；
    // 界面必须显示后端中文 message，而不是与场景无关的重名文案。
    const reason = '该规则会封禁当前 SSH 端口，必须同时提供一个新的 SSH 端口用于迁移，避免失联'
    const m = await mountView({
      component: withToastHost(FirewallView),
      caps: capsAllOk(),
      perms: PERMS,
      routes: {
        [API.firewall.rules()]: (c) => c.method === 'POST'
          ? fakeError(409, 10005, reason)
          : { backend: 'ufw', active: true, rules: [], protected_ports: [] },
        [API.firewall.fail2ban()]: { available: false, active: false, jails: [] },
      },
    })
    setAction(m, 'deny')
    setInput(portsInput(m), '22')
    await prepare(m)
    buttonByText(document, '确定').click()
    await m.flush()

    const errBar = m.host.querySelector('.err-bar, .err')
    expect(errBar?.textContent, '必须显示后端给的 SSH 失联原因').toContain('SSH 端口')
    expect(errBar?.textContent, '不能显示与场景无关的重名文案').not.toContain('已有同名资源')
    m.fake.assertClean(); m.cleanup()
  })
})

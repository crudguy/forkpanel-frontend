// @vitest-environment jsdom
/**
 * 公网暴露向导的**可观察行为**——真挂载测试。
 *
 * 取代 `ExposeWizardView.test.ts` 里除「端点来源」以外的全部源码文本断言。
 * 那一页是全项目唯一能把 root 面板挂到公网的界面，旧断言只证明"代码这么写"：
 * 把按钮直接绑 `doApply`、把 `RiskBanner` 塞进 `v-if="rows.length"`、把失败原因
 * 只写进 toast——源码断言可以照绿，用户却已经站在裸奔的面板前了。
 *
 * 夹具纪律：
 * - 路由 key 一律 `API.*()`，不写 `/api/v1` 字面量（契约门禁会扫 *.test.ts）。
 * - 每个用例末尾 `assertClean()`：组件偷偷多发一个请求也必须响亮失败，
 *   否则"未登记请求悄悄返回空 → 渲染空 → 断言看不见"会成片假绿。
 * - 输入框走原生 setter + `input` 事件（Vue 受控输入），radio 走 `checked` + `change`。
 * - `ConfirmDialog` 用 `Teleport to="body"`，确认框要去 `document.body` 找，
 *   不是 `m.host`；按 `.modal-title` 精确定位，避免两个确认框串台。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import { CAP, type ExposeStatus } from '@/api/types'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { fakeError, type FakeRoute } from '@/test/apiFake'
import ExposeWizardView from '@/views/ExposeWizardView.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

/** 状态夹具：默认"未暴露、脚本已装、能力位支持"。 */
function status(over: Partial<ExposeStatus> = {}): ExposeStatus {
  return {
    exposed: false, tls: false, script_installed: true,
    supported: true, unsupported_reason: null, ...over,
  }
}

/** 只登记 status；写端点由各用例按需补。 */
function routesFor(s: ExposeStatus = status()): Record<string, FakeRoute> {
  return { [API.system.expose.status()]: s }
}

const APPLY_OK = { domain: 'panel.example.com', output: 'STEP1 nginx ok\nSTEP2 firewall ok' }
const REMOVE_OK = { output: 'removed /etc/nginx/conf.d/forkpanel-public-access.conf' }
const APPLY_ERR = 'expose-public.sh: nginx 配置校验失败（第 3 行）'
const REMOVE_ERR = '撤销失败：nginx 反代配置不存在'

// ── DOM 定位：定位失效必须抛，不能让空集静默通过 ──

function button(mounted: Mounted, text: string): HTMLButtonElement {
  const b = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')]
    .find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`页面里找不到按钮「${text}」（定位失效会静默空集通过）`)
  return b
}

function dialog(title: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.mask')]
    .find((mask) => mask.querySelector('.modal-title')?.textContent?.trim() === title) ?? null
}

function confirmButton(mask: HTMLElement): HTMLButtonElement {
  const b = mask.querySelector<HTMLButtonElement>('.modal-actions .btn-danger')
  if (!b) throw new Error('确认框里找不到 .btn-danger 确认按钮')
  return b
}

/** Vue 受控输入：必须用原型上的原生 setter 派发事件，直接赋 value 不会触发 v-model。 */
function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string, evt = 'input') {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event(evt, { bubbles: true }))
}

function applyForm(mounted: Mounted) {
  const domain = mounted.host.querySelector<HTMLInputElement>('input[placeholder="panel.example.com"]')
  const allow = mounted.host.querySelector<HTMLTextAreaElement>('textarea')
  if (!domain || !allow) throw new Error('未暴露态表单里找不到域名 / 网段输入框')
  setNative(domain, 'panel.example.com')
  setNative(allow, '203.0.113.10\n198.51.100.0/24')
}

function chooseTls(mounted: Mounted, value: string) {
  const radio = mounted.host.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)
  if (!radio) throw new Error(`找不到 TLS 单选项 ${value}`)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(radio, true)
  radio.dispatchEvent(new Event('change', { bubbles: true }))
}

function certInput(mounted: Mounted, placeholder: string): HTMLInputElement {
  const el = mounted.host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!el) throw new Error(`custom 模式下找不到证书输入框 ${placeholder}`)
  return el
}

function outputPre(mounted: Mounted): HTMLElement {
  const el = mounted.host.querySelector<HTMLElement>('pre.output')
  if (!el) throw new Error('页面里没有 <pre class="output">（脚本输出没落地）')
  return el
}

// ── 1. 二次确认 ──

describe('二次确认：按钮只开确认框，确认才提交', () => {
  it('点「开启公网访问」只打开确认框，不发 apply；摘要带上域名与网段', async () => {
    m = await mountView({ component: ExposeWizardView, routes: routesFor() })
    applyForm(m)
    button(m, '开启公网访问').click()
    await m.flush()

    const mask = dialog('确认开启公网访问')
    expect(mask, '必须出现危险确认框').not.toBeNull()
    expect(mask!.querySelector('.modal-lead')?.textContent).toContain('panel.example.com')
    expect(mask!.querySelector('.modal-lead')?.textContent).toContain('203.0.113.10')
    expect(m.fake.count(API.system.expose.apply(), 'POST'), '点按钮本身绝不许提交').toBe(0)
  })

  it('点确认框的「确认执行」才 POST apply，请求体与表单一致，成功输出落进 <pre>', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: { ...routesFor(), [API.system.expose.apply()]: APPLY_OK },
    })
    applyForm(m)
    button(m, '开启公网访问').click()
    await m.flush()
    confirmButton(dialog('确认开启公网访问')!).click()
    await m.flush()

    expect(m.fake.count(API.system.expose.apply(), 'POST')).toBe(1)
    expect(m.fake.lastBody(API.system.expose.apply(), 'POST')).toEqual({
      domain: 'panel.example.com',
      allow: ['203.0.113.10', '198.51.100.0/24'],
      self_signed: false,
      fullchain: null,
      key: null,
      no_firewall: false,
    })
    expect(outputPre(m).textContent).toContain('STEP1 nginx ok')
    expect(m.host.textContent).toContain('已在 panel.example.com 开启公网访问')
  })

  it('撤销同理：按钮只开确认框，确认才 POST remove', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: {
        ...routesFor(status({ exposed: true, tls: true })),
        [API.system.expose.remove()]: REMOVE_OK,
      },
    })
    button(m, '撤销公网访问').click()
    await m.flush()
    expect(dialog('确认撤销公网访问')).not.toBeNull()
    expect(m.fake.count(API.system.expose.remove(), 'POST')).toBe(0)

    confirmButton(dialog('确认撤销公网访问')!).click()
    await m.flush()
    expect(m.fake.count(API.system.expose.remove(), 'POST')).toBe(1)
    expect(outputPre(m).textContent).toContain('removed /etc/nginx/conf.d')
  })

  it('无 system.manage 时按钮置灰，点了也不打开确认框', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: routesFor(),
      perms: ['system.view'],
    })
    const b = button(m, '开启公网访问')
    expect(b.disabled).toBe(true)
    expect(b.title).toBe('无 system.manage 权限')
    b.click()
    await m.flush()
    expect(dialog('确认开启公网访问')).toBeNull()
    expect(m.fake.count(API.system.expose.apply(), 'POST')).toBe(0)
  })
})

// ── 2. 能力位不支持 ──

describe('能力不支持：说明原因，而非静默置灰', () => {
  it('能力位与 status 都不支持 → EmptyState 且 reason 是中文映射', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: routesFor(status({ supported: false, unsupported_reason: 'non_root' })),
      caps: capsAllOk({ [CAP.EXPOSE_MANAGE]: { supported: false, reason: 'non_root' } }),
    })
    expect(m.host.querySelector('.empty .title')?.textContent).toBe('当前环境不支持公网暴露向导')
    expect(m.host.querySelector('.empty .reason')?.textContent).toContain('面板未以 root 运行')
    expect([...m.host.querySelectorAll('button')].some((b) => b.textContent?.trim() === '开启公网访问'))
      .toBe(false)
  })

  it('status.supported=true 时能力位尚未加载完也放行进页面（加载态兜底真的生效）', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: routesFor(),
      caps: capsAllOk({ [CAP.EXPOSE_MANAGE]: { supported: false, reason: 'non_root' } }),
    })
    expect(m.host.querySelector('.empty'), '能力位还没到不许闪一个"不支持"').toBeNull()
    expect(m.host.textContent).toContain('仅本机可访问')
    expect(button(m, '开启公网访问').disabled, '能看但还不能改').toBe(true)
  })
})

// ── 3. 脚本输出 ──

describe('脚本输出：失败时是唯一线索', () => {
  it('apply 失败 → 后端中文原文写进 <pre>，标题「开启失败」，顶部 error 清空', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: { ...routesFor(), [API.system.expose.apply()]: fakeError(500, 10901, APPLY_ERR) },
    })
    applyForm(m)
    button(m, '开启公网访问').click()
    await m.flush()
    confirmButton(dialog('确认开启公网访问')!).click()
    await m.flush()

    expect(outputPre(m).textContent).toContain(APPLY_ERR)
    expect(m.host.textContent).toContain('开启失败')
    expect(m.host.querySelector('.err'), '原因只留在 <pre>，不再重复堆顶部横幅').toBeNull()
  })

  it('remove 失败同口径写进 <pre>，标题「撤销失败」', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: {
        ...routesFor(status({ exposed: true })),
        [API.system.expose.remove()]: fakeError(500, 10901, REMOVE_ERR),
      },
    })
    button(m, '撤销公网访问').click()
    await m.flush()
    confirmButton(dialog('确认撤销公网访问')!).click()
    await m.flush()

    expect(outputPre(m).textContent).toContain(REMOVE_ERR)
    expect(m.host.textContent).toContain('撤销失败')
    expect(m.host.querySelector('.err')).toBeNull()
  })
})

// ── 4. 状态未知 ──

describe('状态未知不得伪装成「仅本机可访问」', () => {
  it('status 读取失败 → 显示「状态未知」，不显示确定态结论，也不渲染向导表单', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: { [API.system.expose.status()]: fakeError(500, 10901, 'status 读取失败') },
    })
    expect(m.host.textContent).toContain('状态未知')
    expect(m.host.textContent).not.toContain('仅本机可访问')
    expect(m.host.querySelector('input[placeholder="panel.example.com"]'), '未知态不许给表单').toBeNull()
  })

  it('阳性对照：status 正常且未暴露时确实显示「仅本机可访问」并渲染表单', async () => {
    m = await mountView({ component: ExposeWizardView, routes: routesFor() })
    expect(m.host.textContent).toContain('仅本机可访问')
    expect(m.host.querySelector('input[placeholder="panel.example.com"]')).not.toBeNull()
  })
})

// ── 5. 证书成对 ──

describe('证书成对（只给一个会静默回退成自签）', () => {
  it('custom 模式只填一个 → 拦下，不发 apply，不打开确认框', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: { ...routesFor(), [API.system.expose.apply()]: APPLY_OK },
    })
    chooseTls(m, 'custom')
    await m.flush()
    applyForm(m)
    setNative(certInput(m, '/etc/ssl/certs/panel.fullchain.pem'), '/etc/ssl/certs/panel.fullchain.pem')
    button(m, '开启公网访问').click()
    await m.flush()

    expect(m.host.querySelector('.err')?.textContent).toContain('证书链与私钥必须成对填写')
    expect(m.fake.count(API.system.expose.apply(), 'POST')).toBe(0)
    expect(dialog('确认开启公网访问')).toBeNull()
  })

  it('custom 填齐 → 请求体带 fullchain / key，且 self_signed 为 false', async () => {
    m = await mountView({
      component: ExposeWizardView,
      routes: { ...routesFor(), [API.system.expose.apply()]: APPLY_OK },
    })
    chooseTls(m, 'custom')
    await m.flush()
    applyForm(m)
    setNative(certInput(m, '/etc/ssl/certs/panel.fullchain.pem'), '/etc/ssl/certs/panel.fullchain.pem')
    setNative(certInput(m, '/etc/ssl/private/panel.key'), '/etc/ssl/private/panel.key')
    button(m, '开启公网访问').click()
    await m.flush()
    expect(dialog('确认开启公网访问'), '两个都给了才放行到确认框').not.toBeNull()
    confirmButton(dialog('确认开启公网访问')!).click()
    await m.flush()

    expect(m.fake.lastBody(API.system.expose.apply(), 'POST')).toMatchObject({
      fullchain: '/etc/ssl/certs/panel.fullchain.pem',
      key: '/etc/ssl/private/panel.key',
      self_signed: false,
    })
  })
})

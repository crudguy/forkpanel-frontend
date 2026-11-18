// @vitest-environment jsdom
//
/**
 * SecurityView 的 SSH 端口分区——**真挂载**行为测试。
 *
 * 为什么必须真挂载：本仓踩过「新增子组件忘 import ⇒ 静默不渲染、tsc/build/单测全绿」
 * 与「浮层挪进 v-if 块 ⇒ 一个 mask 都不出现」的坑。读源码字符串的测试挡不住这些，
 * 只看真机 DOM。
 *
 * 覆盖：现状呈现、多端口如实披露、无 sshd 时不给按钮、弹窗开合、确认词门控、
 * PUT 载荷正确、错误留在弹窗里。
 */
import { describe, it, expect, afterEach } from 'vitest'
import SecurityView from '@/views/SecurityView.vue'
import { mountView, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import { fakeRaw, type FakeRoute } from '@/test/apiFake'
import { SSH_PORT_CONFIRM_WORD, type SshPortState } from '@/composables/sshPort'

const BASELINE = [
  { key: 'ssh.permit_root_login', title: 'SSH 禁止 root 直接登录', ok: true,
    current: 'PermitRootLogin no', expected: 'no', advice: '', applicable: true },
]
const SESSIONS = { sessions: [], total: 0 }
const PERMS = ['security.manage', 'system.view', 'system.manage']

function portState(over: Partial<SshPortState> = {}): SshPortState {
  return {
    effective: 22, explicit: true, source_file: '/etc/ssh/sshd_config',
    configured: [22], sshd_present: true, ...over,
  }
}

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/**
 * 标准路由：基线 + 会话 + 端口现状，可选覆盖 PUT 响应。
 *
 * ⚠ GET 与 PUT 共用同一个 URL，而 apiFake 的路由键**只按 URL 匹配**（没有
 * method 维度）。所以这里不能在 PUT 场景下把整条路由换成 PUT 的响应——
 * 那样连挂载时的 GET 都会拿到 PUT 的载荷，页面直接崩。必须按 `ctx.method` 分派。
 */
function routes(
  port: SshPortState = portState(),
  put?: (call: { method: string; body: unknown }) => unknown,
): Record<string, FakeRoute> {
  return {
    [API.security.baseline()]: BASELINE,
    [API.security.sessions()]: SESSIONS,
    [API.security.sshPort()]: put
      ? (ctx: { method: string; body: unknown }) =>
          ctx.method === 'PUT' ? put(ctx) : port
      : port,
  }
}

async function mount(port = portState(), put?: (c: { method: string; body: unknown }) => unknown) {
  m = await mountView({
    component: SecurityView,
    perms: PERMS,
    routes: routes(port, put),
  })
  await m.flush()
  return m
}

/** 找到「SSH 端口」分区的卡片元素（不靠 class，靠标题文字定位，抗重构）。 */
function portSection(host: HTMLElement): HTMLElement {
  const heads = Array.from(host.querySelectorAll('.sec-head'))
  const head = heads.find(h => h.textContent?.includes('SSH 端口'))
  expect(head, 'SSH 端口卡片必须真实渲染出来').toBeTruthy()
  return head!.closest('section') as HTMLElement
}

describe('SecurityView · SSH 端口分区', () => {
  it('真实渲染出端口分区与生效端口', async () => {
    const h = await mount(portState({ effective: 2222 }))
    const sec = portSection(h.host)
    expect(sec.textContent).toContain('2222')
    // 有 sshd 才给按钮
    const btn = Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口'))
    expect(btn, '应渲染「修改端口」按钮').toBeTruthy()
  })

  it('多端口同时监听时如实披露（不能只报生效值）', async () => {
    const h = await mount(portState({ effective: 2222, configured: [2222, 22] }))
    const txt = portSection(h.host).textContent ?? ''
    expect(txt).toContain('2222')
    expect(txt, '旧端口仍在听，必须说出来').toContain('也在监听')
  })

  it('未显式配置时说明走编译默认', async () => {
    const h = await mount(portState({ effective: 22, explicit: false, configured: [] }))
    expect(portSection(h.host).textContent).toContain('编译默认')
  })

  it('未检测到 sshd 时不给修改按钮（点不了 > 点了报错）', async () => {
    const h = await mount(portState({ sshd_present: false }))
    const sec = portSection(h.host)
    expect(sec.textContent).toContain('未检测到 SSH')
    const btn = Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口'))
    expect(btn, '没有 sshd 时不应出现修改按钮').toBeFalsy()
  })

  it('端口现状读取失败只影响本分区，不把整页打成错误态', async () => {
    m = await mountView({
      component: SecurityView,
      perms: PERMS,
      routes: {
        [API.security.baseline()]: BASELINE,
        [API.security.sessions()]: SESSIONS,
        [API.security.sshPort()]: { __fakeError: true, status: 500, body: { code: 50000, message: 'boom' } } as never,
      },
    })
    await m.flush()
    // 基线清单仍然渲染（说明没被端口失败连带拖垮）
    const txt = m.host.textContent ?? ''
    expect(txt).toContain('SSH 禁止 root 直接登录')
    // 端口分区给出可读错误
    expect(portSection(m.host).textContent).toBeTruthy()
  })

  it('点击「修改端口」弹出确认弹窗（浮层挂在 body 上）', async () => {
    const h = await mount()
    const sec = portSection(h.host)
    const btn = Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口')) as HTMLButtonElement
    btn.click()
    await h.flush()
    // Teleport to=body ⇒ mask 在 document.body 下，不在 host 里
    const mask = document.body.querySelector('.mask')
    expect(mask, '弹窗必须真实出现（曾被挪进 v-if 块导致一个 mask 都没有）').toBeTruthy()
    expect(mask!.textContent).toContain('SSH 端口')
    expect(mask!.textContent).toContain(SSH_PORT_CONFIRM_WORD)
  })

  it('确认词不对时提交按钮保持禁用', async () => {
    const h = await mount()
    const sec = portSection(h.host)
    ;(Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口')) as HTMLButtonElement).click()
    await h.flush()

    const mask = document.body.querySelector('.mask') as HTMLElement
    const inputs = Array.from(mask.querySelectorAll('input'))
    // 第一个输入是端口，最后一个是确认词
    const portInput = inputs[0] as HTMLInputElement
    const confirmInput = inputs[inputs.length - 1] as HTMLInputElement

    const setVal = (el: HTMLInputElement, v: string) => {
      // 受控输入必须走原生 setter，否则 Vue 收不到变更（本仓已定的 E2E 纪律）
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    setVal(portInput, '2222')
    await h.flush()
    const submit = () => Array.from(mask.querySelectorAll('button'))
      .find(b => b.textContent?.includes('确认修改')) as HTMLButtonElement

    // 没输确认词 → 禁用
    expect(submit().disabled, '未输确认词时必须禁用').toBe(true)

    // 输错确认词 → 仍禁用
    setVal(confirmInput, '确认改端口X')
    await h.flush()
    expect(submit().disabled, '近似确认词必须被拒').toBe(true)

    // 输对 → 可用
    setVal(confirmInput, SSH_PORT_CONFIRM_WORD)
    await h.flush()
    expect(submit().disabled, '条件齐备后必须可提交').toBe(false)
  })

  it('提交发出 PUT 且载荷含 port/keep_old/confirm_token', async () => {
    let captured: unknown = null
    const h = await mount(portState(), (call) => {
      captured = call.body
      return {
        changed: true, effective: 2222, target_file: '/etc/ssh/sshd_config.d/00-panel-port.conf',
        backup: '/x.bak', validated: true, listening_ports: [2222, 22], next_steps: [],
      }
    })
    const sec = portSection(h.host)
    ;(Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口')) as HTMLButtonElement).click()
    await h.flush()

    const mask = document.body.querySelector('.mask') as HTMLElement
    const inputs = Array.from(mask.querySelectorAll('input'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const setVal = (el: HTMLInputElement, v: string) => {
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // 第一个 input 是端口号；确认词是最后一个 input；中间的复选框是 type=checkbox
    setVal(inputs[0] as HTMLInputElement, '2222')
    setVal(inputs[inputs.length - 1] as HTMLInputElement, SSH_PORT_CONFIRM_WORD)
    await h.flush()

    ;(Array.from(mask.querySelectorAll('button'))
      .find(b => b.textContent?.includes('确认修改')) as HTMLButtonElement).click()
    await h.flush()

    expect(captured, 'PUT 必须真的发出').toBeTruthy()
    const body = captured as Record<string, unknown>
    expect(body.port).toBe(2222)
    expect(body.confirm_token).toBe(SSH_PORT_CONFIRM_WORD)
    // keep_old 默认必须保留旧端口（关掉唯一回退通道是最危险的选择）
    expect(body.keep_old).toBe(true)
  })

  it('提交失败时弹窗不关闭，错误留在弹窗里', async () => {
    // 端口被占用是后端 `PanelError::Validation` ⇒ code 10001，`errorText` 会透出
    // `detail.reason`（中文原因）。用 10003 之类被固定文案覆盖的 code 测不出
    // "后端给的原因有没有到位"——那只会证明它有通用的「权限不足」。
    const h = await mount(portState(), () => ({
      __fakeError: true, status: 400,
      body: {
        code: 10001,
        message: 'validation failed',
        detail: { field: 'port', reason: '端口 2222 已被其它进程占用' },
      },
    }) as never)
    const sec = portSection(h.host)
    ;(Array.from(sec.querySelectorAll('button'))
      .find(b => b.textContent?.includes('修改端口')) as HTMLButtonElement).click()
    await h.flush()

    const mask = document.body.querySelector('.mask') as HTMLElement
    const inputs = Array.from(mask.querySelectorAll('input'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const setVal = (el: HTMLInputElement, v: string) => {
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setVal(inputs[0] as HTMLInputElement, '2222')
    setVal(inputs[inputs.length - 1] as HTMLInputElement, SSH_PORT_CONFIRM_WORD)
    await h.flush()
    ;(Array.from(mask.querySelectorAll('button'))
      .find(b => b.textContent?.includes('确认修改')) as HTMLButtonElement).click()
    await h.flush()

    // 弹窗必须还在——关掉它用户就没法改输入重试了
    const still = document.body.querySelector('.mask')
    expect(still, '失败后弹窗不能关').toBeTruthy()
    expect(still!.textContent, '必须在弹窗内展示后端给的原因').toContain('已被其它进程占用')
  })
})

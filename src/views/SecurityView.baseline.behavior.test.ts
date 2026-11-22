// @vitest-environment jsdom
/**
 * 安全基线页四项 UI 改造的**真挂载**行为测试：
 *  ① 通过 / 风险 / 不适用三种状态都能查看与筛选（含汇总卡直达）；
 *  ② 清单每项明确分「说明 / 操作」两区，可修与不可修规则统一；
 *  ③ SSH 端口模块突出当前端口、修改入口、风险提示；
 *  ④ SSH 登录记录展示五要素并支持查询筛选。
 *
 * 只读源码字符串的断言挡不住「组件没 import 静默不渲染」「浮层挪错层级」
 * 这类本仓踩过的坑，所以这里一律看真实 DOM 与真实请求。
 */
import { describe, it, expect, afterEach } from 'vitest'
import SecurityView from '@/views/SecurityView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import { fakeError, type FakeRoute } from '@/test/apiFake'
import { CAP } from '@/api/types'

const BASELINE = [
  { key: 'ssh.permit_root_login', title: '禁止 root 登录', ok: false,
    current: 'yes', expected: 'no', advice: '请改为 no', applicable: true },
  { key: 'ssh.password_auth', title: '禁用密码登录', ok: true,
    current: 'no', expected: 'no', advice: '', applicable: true },
  { key: 'ssh.pubkey_auth', title: '公钥认证', ok: true,
    current: 'yes', expected: 'yes', advice: '', applicable: true },
  { key: 'svc.ufw', title: '防火墙状态', ok: false,
    current: 'off', expected: 'on', advice: '需要手工开启 ufw', applicable: true },
  { key: 'os.defender', title: 'Defender', ok: true,
    current: '-', expected: '-', advice: '', applicable: false },
]
const SESSIONS = { sessions: [], total: 0 }
const PORT = {
  effective: 2222, explicit: true, source_file: '/etc/ssh/sshd_config',
  configured: [2222, 22], sshd_present: true,
}
const LOGS = {
  rows: [
    { ts_unix: 1763800000, ip: '5.6.7.8', user: 'systemd', result: 'failed',
      risk: 'brute_force', detail: 'Failed password for invalid user systemd from 5.6.7.8 port 1 ssh2' },
    { ts_unix: 1763799900, ip: '10.0.0.9', user: 'admin', result: 'success',
      risk: 'none', detail: 'Accepted publickey for admin from 10.0.0.9 port 2 ssh2' },
  ],
  total: 2, source: 'journald', truncated: false,
}

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

interface MountOver {
  logs?: typeof LOGS
  routes?: Record<string, FakeRoute>
  caps?: ReturnType<typeof capsAllOk>
  perms?: string[]
}

async function mountPage(over: MountOver = {}) {
  const logs = over.logs ?? LOGS
  m = await mountView({
    component: SecurityView,
    perms: over.perms ?? ['security.manage', 'system.view', 'system.manage', 'firewall.manage'],
    caps: over.caps ?? capsAllOk(),
    routes: {
      [API.security.baseline()]: BASELINE,
      [API.security.sessions()]: SESSIONS,
      [API.security.sshPort()]: PORT,
      [API.security.sshLogins()]: logs,
      [API.firewall.fail2banBan()]: { jail: 'forkpanel', ip: '5.6.7.8', already_banned: false },
      ...(over.routes ?? {}),
    },
  })
  await m.flush()
  return m
}

function section(host: HTMLElement, title: string): HTMLElement {
  const head = [...host.querySelectorAll('.sec-head')]
    .find(h => h.textContent?.includes(title))
  expect(head, `${title} 分区必须真实渲染`).toBeTruthy()
  return head!.closest('section') as HTMLElement
}

describe('SecurityView · 基线状态与信息结构', () => {
  it('通过 / 风险 / 不适用三种状态都能单独查看与筛选', async () => {
    const h = await mountPage()
    const items = () => h.host.querySelectorAll('.checks li.bl-item')
    expect(items()).toHaveLength(BASELINE.length)

    const tab = (label: string) => [...h.host.querySelectorAll('.bl-tab')]
      .find(b => (b.textContent ?? '').includes(label)) as HTMLButtonElement
    tab('风险').click(); await h.flush()
    expect(items()).toHaveLength(2)
    expect([...items()].every(li => li.querySelector('.badge-danger'))).toBe(true)

    tab('通过').click(); await h.flush()
    expect(items()).toHaveLength(2)

    tab('不适用').click(); await h.flush()
    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('Defender')

    tab('全部').click(); await h.flush()
    expect(items()).toHaveLength(BASELINE.length)
  })

  it('汇总卡点击直达对应状态清单', async () => {
    const h = await mountPage()
    const cards = h.host.querySelectorAll('.stat-click')
    expect(cards).toHaveLength(3)
    ;(cards[2] as HTMLElement).click() // 不适用
    await h.flush()
    expect(h.host.querySelectorAll('.checks li.bl-item')).toHaveLength(1)
    expect(h.host.querySelector('.bl-tab.active')?.textContent).toContain('不适用')
  })

  it('每项分说明区与操作区，可修 / 不可修 / 通过 / 不适用规则统一', async () => {
    const h = await mountPage()
    const items = [...h.host.querySelectorAll('.checks li.bl-item')]
    expect(items.every(li => li.querySelector('.bl-info') && li.querySelector('.bl-op'))).toBe(true)
    const texts = items.map(li => li.textContent ?? '')
    expect(texts.some(t => t.includes('说明：请改为 no') && t.includes('修复'))).toBe(true)
    expect(texts.some(t => t.includes('需按说明手工处理'))).toBe(true)
    expect(texts.some(t => t.includes('已符合，无需操作'))).toBe(true)
    expect(texts.some(t => t.includes('当前环境不适用，无需操作'))).toBe(true)
  })
})

describe('SecurityView · SSH 端口与登录记录', () => {
  it('端口模块突出当前端口、修改入口、风险提示与关键信息', async () => {
    const h = await mountPage()
    const sec = section(h.host, 'SSH 端口')
    expect(sec.querySelector('.port-num')?.textContent?.trim()).toBe('2222')
    expect(sec.querySelector('.port-entry button')?.textContent).toContain('修改端口')
    expect(sec.querySelector('.port-risk')?.textContent).toContain('防火墙')
    expect(sec.textContent).toContain('也在监听')
    expect(sec.textContent).toContain('确认改端口')
  })

  it('登录记录展示来源 IP / 用户 / 结果 / 风险类型，并支持按 IP 查询', async () => {
    const h = await mountPage()
    const sec = section(h.host, 'SSH 登录记录')
    const rows = sec.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('5.6.7.8')
    expect(rows[0].textContent).toContain('systemd')
    expect(rows[0].textContent).toContain('疑似爆破')
    expect(rows[1].textContent).toContain('admin')
    expect(rows[1].textContent).toContain('成功')

    // Vue 受控输入必须走原生 setter + input 事件，直接赋值不触发响应式
    const input = sec.querySelector('input[placeholder="来源 IP"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '5.6.7.8')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await h.flush()
    const query = [...sec.querySelectorAll('button')]
      .find(b => b.textContent?.includes('查询')) as HTMLButtonElement
    query.click()
    await h.flush()

    const url = h.fake.calls
      .filter(c => c.url.startsWith('/api/v1/security/ssh-logins'))
      .at(-1)?.url ?? ''
    expect(url).toContain('ip=5.6.7.8')
    expect(h.fake.unexpected).toHaveLength(0)
  })
})

describe('SecurityView · 从日志 IP 直接封禁', () => {
  function banButton(h: Mounted, ip = '5.6.7.8'): HTMLButtonElement | undefined {
    const sec = section(h.host, 'SSH 登录记录')
    const row = [...sec.querySelectorAll('tbody tr')].find(tr => tr.textContent?.includes(ip))
    return ([...(row?.querySelectorAll('button') ?? [])]
      .find(b => b.textContent?.includes('封禁')) as HTMLButtonElement) || undefined
  }

  it('有权限与能力位时按钮可见，点击只提交该行 IP', async () => {
    const h = await mountPage()
    const btn = banButton(h)
    expect(btn, '封禁按钮必须真实渲染到日志行').toBeTruthy()
    expect(btn!.title).toContain('出口 IP')
    expect(banButton(h, '10.0.0.9'), '另一行也应可封禁').toBeTruthy()
    btn!.click()
    await h.flush()
    expect(h.fake.count(API.firewall.fail2banBan(), 'POST')).toBe(1)
    expect(h.fake.lastBody(API.firewall.fail2banBan(), 'POST')).toEqual({ ip: '5.6.7.8' })
    h.fake.assertClean()
  })

  it('能力位不支持时不渲染按钮，页面如实说明不可管理', async () => {
    const h = await mountPage({ caps: capsAllOk({ [CAP.FAIL2BAN]: { supported: false } }) })
    expect(banButton(h)).toBeFalsy()
    expect(section(h.host, 'SSH 登录记录').textContent).toContain('不可管理')
    h.fake.assertClean()
  })

  it('后端拒绝时错误条如实展示，不假装成功', async () => {
    const h = await mountPage({
      routes: {
        [API.firewall.fail2banBan()]: fakeError(
          400, 10001, '参数校验失败', { reason: 'IP 格式非法或不可封禁（回环/未指定地址）' }),
      },
    })
    banButton(h)!.click()
    await h.flush()
    const err = section(h.host, 'SSH 登录记录').querySelector('.err-bar')?.textContent ?? ''
    expect(err).toContain('封禁 5.6.7.8 失败')
    expect(err).toContain('IP 格式非法')
    h.fake.assertClean()
  })

  it('已封禁时如实提示，且不额外重复下发', async () => {
    const h = await mountPage({
      routes: {
        [API.firewall.fail2banBan()]: { jail: 'forkpanel', ip: '5.6.7.8', already_banned: true },
      },
    })
    banButton(h)!.click()
    await h.flush()
    expect(h.fake.count(API.firewall.fail2banBan(), 'POST')).toBe(1)
    expect(section(h.host, 'SSH 登录记录').querySelector('.err-bar')).toBeFalsy()
    h.fake.assertClean()
  })
})

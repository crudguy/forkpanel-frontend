// @vitest-environment jsdom
//
// F-18 后半（证书）：续期 / 自动续期 / 删除 / 申请之后，列表必须按服务端真值刷新，
// 且成功要有 toast。共用夹具见 `src/test/toastHarness.ts`。
import { describe, it, expect, beforeEach } from 'vitest'
import CertsView from './CertsView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import { withToastHost, clearToasts, toastTexts, buttonByText, setInput } from '@/test/toastHarness'

const PERMS = ['ssl.manage', 'site.view', 'system.view']

const CERT = {
  id: 3, domain: 'demo.example.com', issuer: 'R3', not_after: 1_900_000_000,
  days_left: 42, auto_renew: false, source: 'acme',
}

const SITE = {
  id: 9, name: 'demo', domains: ['demo.example.com'], root: '/var/www/demo',
  kind: 'static', enabled: true, deployed: true, tls: true, waf_enabled: false,
  waf_profile: null, waf_rate_per_sec: null, upstreams: null,
}

function mount(routes: Record<string, FakeRoute>): Promise<Mounted> {
  return mountView({
    component: withToastHost(CertsView),
    caps: capsAllOk(),
    perms: PERMS,
    routes: {
      [API.certs.list()]: [CERT],
      [API.sites.list()]: [SITE],
      [API.certs.renewSweep()]: { last_at: 0, last_queued: 0, next_at: 0 },
      ...routes,
    },
  })
}

/** 打开「申请证书」弹窗（工具条按钮），再按需切到 ACME 渠道并填邮箱。 */
async function openApply(m: Mounted, method: 'self-signed' | 'http-01'): Promise<void> {
  buttonByText(m.host, /申请证书/).click()
  await m.flush()
  if (method === 'http-01') {
    const radio = document.querySelector<HTMLInputElement>('.mask input[value="http-01"]')
    if (!radio) throw new Error('找不到 ACME 渠道单选项')
    radio.click()
    await m.flush()
    const email = document.querySelector<HTMLInputElement>('.mask input[type="email"]')
    if (!email) throw new Error('切到 ACME 后应出现邮箱输入框')
    setInput(email, 'ops@example.com')
  }
}

beforeEach(clearToasts)

describe('F-18 后半 · 证书写操作的反馈', () => {
  it('开关自动续期：toast + 重新拉列表（原先只改本地对象，列表不刷新）', async () => {
    let lists = 0
    const m = await mount({
      [API.certs.list()]: () => {
        lists += 1
        return [lists === 1 ? CERT : { ...CERT, auto_renew: true }]
      },
      [API.certs.autoRenew(3)]: { ok: true },
    })
    const sw = m.host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(sw, 'ACME 证书应有自动续期开关').not.toBeNull()
    expect(sw!.checked).toBe(false)
    sw!.click()
    await m.flush()

    expect(m.fake.count(API.certs.autoRenew(3), 'PATCH')).toBe(1)
    expect(toastTexts()).toContain('demo.example.com 自动续期已开启')
    expect(m.fake.count(API.certs.list(), 'GET'), '写后没有重新拉列表').toBe(2)
    expect(sw!.checked, '开关状态应以服务端返回为准').toBe(true)
    m.fake.assertClean(); m.cleanup()
  })

  it('删除证书：toast 带域名，且重载后回到空态', async () => {
    let lists = 0
    const m = await mount({
      [API.certs.list()]: () => {
        lists += 1
        return lists === 1 ? [CERT] : []
      },
      [API.certs.remove(3)]: { ok: true },
    })
    buttonByText(m.host, /删除/).click()
    await m.flush()
    // ⚠ 确认框按钮必须限定在 .mask 内查：行内那个「删除」也在 document 上、且排在前面，
    //   用 document 查会又点一次行按钮——等于什么都没做，DELETE 数会是 0（假绿风险）
    const mask = document.querySelector<HTMLElement>('.mask')
    expect(mask, '删除前必须先弹确认框').not.toBeNull()
    buttonByText(mask!, '删除').click()
    await m.flush()

    expect(m.fake.count(API.certs.remove(3), 'DELETE')).toBe(1)
    expect(toastTexts()).toContain('已删除证书 demo.example.com')
    expect(m.host.textContent, '删完没有重载：空表没回到空态').toContain('暂无证书')
    m.fake.assertClean(); m.cleanup()
  })

  it('ACME 申请：toast 说清是「提交任务」，并且也重载（原先只有自签才刷）', async () => {
    const m = await mount({ [API.sites.sslApply(9)]: { ok: true } })
    await openApply(m, 'http-01')
    buttonByText(document, '申请').click()
    await m.flush()

    expect(m.fake.count(API.sites.sslApply(9), 'POST')).toBe(1)
    expect(m.fake.lastBody(API.sites.sslApply(9), 'POST')).toMatchObject({ method: 'http-01' })
    expect(toastTexts()).toContain('已提交 demo 的 ACME 签发任务')
    expect(m.fake.count(API.certs.list(), 'GET'), 'ACME 申请后没有重载').toBe(2)
    m.fake.assertClean(); m.cleanup()
  })

  it('自签申请：仍然重载（回归，别把原来的刷新弄丢）', async () => {
    const m = await mount({ [API.sites.sslApply(9)]: { ok: true } })
    await openApply(m, 'self-signed')
    buttonByText(document, '申请').click()
    await m.flush()

    expect(m.fake.lastBody(API.sites.sslApply(9), 'POST')).toMatchObject({ method: 'self-signed' })
    expect(toastTexts()).toContain('已为 demo 签发面板自签证书')
    expect(m.fake.count(API.certs.list(), 'GET')).toBe(2)
    m.fake.assertClean(); m.cleanup()
  })
})

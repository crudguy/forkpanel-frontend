// @vitest-environment jsdom
//
// F-18 后半（防火墙）：放行 / 启停 / 删规则成功后必须有**看得见的**回执，且列表真重载。
// 共用夹具见 `src/test/toastHarness.ts`（为什么必须真挂 ToastHost 也写在那里）。
import { describe, it, expect, beforeEach } from 'vitest'
import FirewallView from './FirewallView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { fakeError, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import {
  withToastHost, clearToasts, toastTexts, buttonByText, refreshBtn,
  setInput, wait, delayNextFetch,
} from '@/test/toastHarness'

const PERMS = ['firewall.manage', 'system.view', 'system.manage']

interface RuleDto {
  id: string; ports: string; protocol: string; action: string
  direction: string; source: string | null; comment: string | null; panel_managed: boolean
}

function rule(over: Partial<RuleDto> = {}): RuleDto {
  return {
    id: 'p1', ports: '80', protocol: 'tcp', action: 'allow',
    direction: 'in', source: null, comment: null, panel_managed: true, ...over,
  }
}

function mount(routes: Record<string, FakeRoute>): Promise<Mounted> {
  return mountView({
    component: withToastHost(FirewallView),
    caps: capsAllOk(),
    perms: PERMS,
    routes: { [API.firewall.fail2ban()]: { available: false, active: false, jails: [] }, ...routes },
  })
}

function portsInput(m: Mounted): HTMLInputElement {
  const el = m.host.querySelector<HTMLInputElement>('input[placeholder^="80,443"]')
  if (!el) throw new Error('找不到端口输入框')
  return el
}

/** 走完「应用 → 确认框 → 确定」这条真实路径（apply 只能被确认框触发）。 */
async function applyPort(m: Mounted, ports: string): Promise<void> {
  setInput(portsInput(m), ports)
  buttonByText(m.host, '应用').click()
  await m.flush()
  buttonByText(document, '确定').click()
  await m.flush()
}

beforeEach(clearToasts)

describe('F-18 后半 · 防火墙写操作的反馈', () => {
  it('放行端口：toast 说出放行了哪些端口，且重载把新规则渲染进表', async () => {
    let gets = 0
    const m = await mount({
      [API.firewall.rules()]: (c) => {
        if (c.method === 'POST') return { added: 1, removed: 0, unchanged: 0, warnings: [] }
        gets += 1
        return { backend: 'ufw', active: true, rules: gets === 1 ? [] : [rule({ ports: '8080' })] }
      },
    })
    await applyPort(m, '8080')

    expect(m.fake.count(API.firewall.rules(), 'POST')).toBe(1)
    expect(toastTexts()).toContain('已放行端口 8080')
    // 端口输入框已被清空，所以页面上出现的 8080 只能来自重载后的规则表
    expect(portsInput(m).value).toBe('')
    expect(m.host.textContent, '写后没有重载：新规则没进表').toContain('8080')
    expect(m.fake.count(API.firewall.rules(), 'GET')).toBe(2)
    m.fake.assertClean(); m.cleanup()
  })

  it('重复放行同一端口：提示区分「已在放行列表中」，不说成又加了一条', async () => {
    const m = await mount({
      [API.firewall.rules()]: (c) => (c.method === 'POST'
        ? { added: 0, removed: 0, unchanged: 1, warnings: [] }
        : { backend: 'ufw', active: true, rules: [rule({ ports: '8080' })] }),
    })
    await applyPort(m, '8080')

    expect(toastTexts()).toContain('端口 8080 已在放行列表中')
    expect(toastTexts()).not.toContain('已放行端口 8080')
    m.fake.assertClean(); m.cleanup()
  })

  it('关闭防火墙：确认后给 toast，并把新状态重载回来', async () => {
    let gets = 0
    const m = await mount({
      [API.firewall.rules()]: () => {
        gets += 1
        return { backend: 'ufw', active: gets === 1, rules: [] }
      },
      [API.firewall.setEnabled()]: { ok: true },
    })
    buttonByText(m.host, '关闭').click()
    await m.flush()
    buttonByText(document, '确认执行').click()
    await m.flush()

    expect(m.fake.count(API.firewall.setEnabled(), 'PUT')).toBe(1)
    expect(toastTexts()).toContain('已关闭防火墙')
    expect(m.fake.count(API.firewall.rules(), 'GET')).toBe(2)
    expect(m.host.textContent).toContain('未启用')
    m.fake.assertClean(); m.cleanup()
  })

  it('删除规则：toast 说明删的是哪一条（规则没有 name，用方向+端口/协议）', async () => {
    let gets = 0
    const m = await mount({
      [API.firewall.rules()]: () => {
        gets += 1
        return { backend: 'ufw', active: true, rules: gets === 1 ? [rule({ ports: '80' })] : [] }
      },
      [API.firewall.removeRule('p1')]: { ok: true },
    })
    buttonByText(m.host, /删除/).click()
    await m.flush()
    buttonByText(document, '确认执行').click()
    await m.flush()

    expect(m.fake.count(API.firewall.removeRule('p1'), 'DELETE')).toBe(1)
    expect(toastTexts()).toContain('已删除规则 入站 80/tcp')
    expect(m.host.textContent, '删完没有重载：空表没回到空态').toContain('暂无规则')
    m.fake.assertClean(); m.cleanup()
  })

  it('重载还没回来之前不许解除 busy（await 的真实作用：不给重复提交留窗口）', async () => {
    const m = await mount({
      [API.firewall.rules()]: (c) => (c.method === 'POST'
        ? { added: 1, removed: 0, unchanged: 0, warnings: [] }
        : { backend: 'ufw', active: true, rules: [] }),
    })
    // 装好延迟再点：此刻首屏那次 GET 已经走完，被推后的必然是写后重载
    const restore = delayNextFetch(API.firewall.rules(), 'GET', 80)
    try {
      await applyPort(m, '8080')
      // POST 已回、toast 已弹，重载仍在路上
      expect(toastTexts()).toContain('已放行端口 8080')
      expect(refreshBtn(m).disabled, '重载未回来就解除了 busy：这段窗口里能重复提交').toBe(true)
      await wait(200)
      await m.flush()
      expect(refreshBtn(m).disabled, '重载回来后应恢复可用').toBe(false)
    } finally { restore() }
    m.fake.assertClean(); m.cleanup()
  })

  it('放行失败：不许出现成功提示（否则失败被伪装成成功）', async () => {
    const m = await mount({
      [API.firewall.rules()]: (c) => (c.method === 'POST'
        // 10001 只在 detail.reason 是中文时原样透出（见 client.ts 的 errorText），
        // 直接塞 message 会被压成通用「提交内容有误」，断言就变成验映射而不是验接线
        ? fakeError(400, 10001, 'invalid', { reason: '快照写入失败，已回滚' })
        : { backend: 'ufw', active: true, rules: [] }),
    })
    await applyPort(m, '8080')

    expect(toastTexts().filter((t) => t.startsWith('已放行'))).toEqual([])
    expect(m.host.textContent).toContain('快照写入失败，已回滚')
    m.fake.assertClean(); m.cleanup()
  })
})

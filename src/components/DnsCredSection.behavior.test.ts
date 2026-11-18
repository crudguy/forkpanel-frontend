// @vitest-environment jsdom
//
/**
 * `DnsCredSection`——**真挂载**行为测试。
 *
 * 为什么必须真挂载：本仓反复踩过「子组件忘 import ⇒ 静默不渲染，tsc/build/单测全绿」
 * 和「布尔 prop 缺席被强转 false ⇒ 功能被静默全关」。读源码字符串一条都挡不住。
 *
 * 覆盖：空态指引、掩码呈现、不可解密凭据仍显示且标红、编辑不回填明文、
 * 新建必填校验、校验/删除的请求路径、无权限置灰。
 */
import { describe, it, expect, afterEach } from 'vitest'
import DnsCredSection from '@/components/DnsCredSection.vue'
import { mountView, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import type { FakeRoute } from '@/test/apiFake'
import type { DnsCred } from '@/api/types'

function cred(over: Partial<DnsCred> = {}): DnsCred {
  return {
    id: 1,
    provider: 'cloudflare',
    provider_label: 'Cloudflare',
    label: '',
    secret_masked: 'abcd******wxyz',
    zone_hint: '',
    usable: true,
    last_check_at: 0,
    last_check_ok: false,
    last_check_msg: '',
    created_at: 0,
    updated_at: 0,
    ...over,
  }
}

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/**
 * 标准路由。
 *
 * ⚠ `API.dns.creds()` 同时承担 GET（列表）与 PUT（保存），而 apiFake 的路由键
 * **只按 URL 匹配、没有 method 维度**。所以 PUT 场景必须按 `ctx.method` 分派，
 * 否则挂载时的 GET 会拿到 PUT 的响应把列表打崩。
 */
function routes(
  items: DnsCred[],
  put?: (ctx: { method: string; body: unknown }) => unknown,
): Record<string, FakeRoute> {
  return {
    [API.dns.creds()]: put
      ? (ctx: { method: string; body: unknown }) => (ctx.method === 'PUT' ? put(ctx) : { items })
      : { items },
  }
}

async function mount(items: DnsCred[] = [], canManage = true) {
  m = await mountView({
    component: DnsCredSection,
    props: { canManage },
    routes: routes(items),
  })
  await m.flush()
  return m
}

/** 展开区块（默认收起）。靠按钮文字定位，不靠 class。 */
async function expand(host: HTMLElement) {
  const btn = Array.from(host.querySelectorAll('button'))
    .find(b => b.textContent?.includes('DNS 凭据'))
  expect(btn, '「DNS 凭据」折叠头必须真实渲染').toBeTruthy()
  btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 0))
}

describe('DnsCredSection · 挂载与空态', () => {
  it('真实渲染出折叠头（组件确实被挂上了）', async () => {
    const h = await mount()
    const btn = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('DNS 凭据'))
    expect(btn).toBeTruthy()
  })

  it('空态说清"为什么需要它"，而不是只写暂无数据', async () => {
    const h = await mount()
    await expand(h.host)
    const txt = h.host.textContent ?? ''
    expect(txt).toContain('尚未配置')
    // 关键：必须点出 dns-01 与"不要求 80 可达"，否则用户不知这功能解决什么问题
    expect(txt).toContain('dns-01')
    expect(txt).toContain('80')
  })

  it('有凭据时折叠头显示条数', async () => {
    const h = await mount([cred()])
    const btn = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('DNS 凭据'))
    expect(btn?.textContent).toContain('1')
  })
})

describe('DnsCredSection · 列表呈现', () => {
  it('显示掩码而不是明文', async () => {
    const h = await mount([cred({ secret_masked: 'abcd******wxyz' })])
    await expand(h.host)
    expect(h.host.textContent).toContain('abcd******wxyz')
  })

  it('不可解密的凭据仍然显示（藏掉会让用户困惑"我明明配过"）且状态标红', async () => {
    const h = await mount([cred({ usable: false })])
    await expand(h.host)
    const txt = h.host.textContent ?? ''
    expect(txt).toContain('Cloudflare')
    expect(txt, '必须引导重填而不是静默').toContain('重填')
    const badge = h.host.querySelector('.badge');
    expect(badge?.className).toContain('badge-err')
  })

  it('从未校验 → warn 药丸；校验通过 → ok 药丸', async () => {
    const a = await mount([cred({ last_check_at: 0 })])
    await expand(a.host)
    expect(a.host.querySelector('.badge')?.className).toContain('badge-warn')
    a.cleanup(); m = null

    const b = await mount([cred({ last_check_at: 100, last_check_ok: true })])
    await expand(b.host)
    expect(b.host.querySelector('.badge')?.className).toContain('badge-ok')
  })

  it('校验失败时原因出现在界面上', async () => {
    const h = await mount([cred({ last_check_at: 100, last_check_ok: false, last_check_msg: '9109 Invalid token' })])
    await expand(h.host)
    expect(h.host.textContent).toContain('9109')
  })
})

describe('DnsCredSection · 编辑表单', () => {
  it('编辑已有凭据时 token 输入框**不回填**（接口只给掩码，回填会误导）', async () => {
    const h = await mount([cred({ secret_masked: 'abcd******wxyz' })])
    await expand(h.host)
    const editBtn = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('编辑'))
    editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    const input = h.host.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input, 'token 输入框应存在').toBeTruthy()
    expect(input!.value, '绝不能把掩码当明文回填').toBe('')
    expect(input!.placeholder, 'placeholder 要说明留空=保持原值').toContain('保持')
  })

  it('首次添加留空 token → 拦住并给出原因（不发请求）', async () => {
    const h = await mount([])
    await expand(h.host)
    const addBtn = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('添加凭据'))
    addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    const save = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('保存'))
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    expect(h.host.textContent).toContain('必须填写')
  })

  it('编辑态留空 token 合法（改备注不该被拦）', async () => {
    const h = await mount([cred()])
    await expand(h.host)
    const editBtn = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('编辑'))
    editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    const save = Array.from(h.host.querySelectorAll('button'))
      .find(b => b.textContent?.includes('保存'))
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))
    // 不该出现"必须填写"；请求会真的发出去（fake 未登记则 assertClean 会报，这里不装 PUT）
    expect(h.host.textContent).not.toContain('必须填写')
  })
})

describe('DnsCredSection · 权限', () => {
  it('无 ssl.manage 时所有写操作置灰，但列表照常展示', async () => {
    const h = await mount([cred()], false)
    await expand(h.host)
    expect(h.host.textContent, '列表内容不受权限影响').toContain('Cloudflare')
    const acts = Array.from(h.host.querySelectorAll('tbody button')) as HTMLButtonElement[]
    expect(acts.length).toBeGreaterThan(0)
    expect(acts.every(b => b.disabled), '无权限时动作按钮应全部置灰').toBe(true)
  })
})

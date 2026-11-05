// @vitest-environment jsdom
// F-07：状态读取失败（loaded=false）时「启用/关闭」按钮必须禁用且不下发切换。
// 真挂载 —— 源码断言抓不到「按钮 disabled 属性没跟着 loaded 走」这类回归。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import FirewallView from './FirewallView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { fakeError } from '@/test/apiFake'
import { API } from '@/api/endpoints'

const PERMS = ['firewall.manage', 'system.view', 'system.manage']

// 接线守卫：`toggleActive` 里的 `!loaded` 兜底在行为上会被 `setActive` 的同款
// 兜底盖住（黑盒下两层纵深防御不可区分），只能用源码断言钉住它「还在接线」。
// 这是 B 类接线事实，不是「拿源码镜像当结论」——行为部分全部由上面的真挂载覆盖。
const SRC = readFileSync(resolve(process.cwd(), 'src/views/FirewallView.vue'), 'utf8')
function scriptBody(): string {
  const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  if (!body.includes('function toggleActive()') || body.length < 4000) {
    throw new Error('FirewallView.vue 读取异常——接线守卫的扫描前提不成立')
  }
  return body
}

/** 切换按钮：靠文案定位，避免依赖按钮在工具条里的次序。 */
function toggle(m: Mounted): HTMLButtonElement {
  const hit = [...m.host.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /^(关闭|启用|状态未知)$/.test((b.textContent ?? '').trim()))
  if (!hit) throw new Error('找不到防火墙切换按钮（关闭/启用/状态未知）')
  return hit
}

function badge(m: Mounted): string {
  const b = [...m.host.querySelectorAll<HTMLElement>('.badge')]
    .find((x) => /已启用|未启用|状态未知|不可用/.test(x.textContent ?? ''))
  return (b?.textContent ?? '').trim()
}

interface Setup {
  m: Mounted
  setFail: (v: boolean) => void
}

async function setup(opts: { fail?: boolean; perms?: string[] } = {}): Promise<Setup> {
  let fail = opts.fail ?? false
  const routes = {
    [API.firewall.rules()]: () => (fail
      ? fakeError(500, 10001, '读取防火墙状态失败')
      : { backend: 'ufw', active: true, rules: [] }),
    [API.firewall.fail2ban()]: { available: false, active: false, jails: [] },
    // 登记但断言「一次都不许调用」：状态未知时点按钮绝不能下发切换。
    [API.firewall.setEnabled()]: { ok: true },
  }
  const m = await mountView({
    component: FirewallView,
    routes,
    caps: capsAllOk(),
    perms: opts.perms ?? PERMS,
  })
  return { m, setFail: (v: boolean) => { fail = v } }
}

describe('F-07 接线守卫（纵深防御不得被顺手删掉）', () => {
  it('toggleActive 与 setActive 各有一道 !loaded 兜底，共恰好 2 处', () => {
    const body = scriptBody()
    expect((body.match(/if \(!loaded\.value\) return/g) ?? []).length).toBe(2)
    const a = body.indexOf('function toggleActive()')
    const b = body.indexOf('async function setActive(')
    // 用代码锚点而非注释行：scriptBody() 已剔注释，注释锚点会取到 -1
    const c = body.indexOf('async function doDelete(')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(body.slice(a, b)).toContain('if (!loaded.value) return')
    expect(body.slice(b, c)).toContain('if (!loaded.value) return')
  })

  it('模板的 disabled 与文案都带 !loaded 判据', () => {
    const body = scriptBody()
    expect(body).toContain(':disabled="busy || !canManage || !loaded"')
    expect(body).toContain("{{ !loaded ? '状态未知' : (active ? '关闭' : '启用') }}")
  })
})

describe('F-07 防火墙状态未知时的切换门控', () => {
  it('状态读取成功：按钮可点、文案反映真实 active', async () => {
    const { m } = await setup()
    expect(badge(m)).toBe('已启用')
    expect(toggle(m).textContent?.trim()).toBe('关闭')
    expect(toggle(m).disabled).toBe(false)
    m.fake.assertClean(); m.cleanup()
  })

  it('状态读取失败：按钮禁用 + 文案「状态未知」+ badge 不谎报未启用', async () => {
    const { m } = await setup({ fail: true })
    expect(badge(m)).toBe('状态未知')
    expect(toggle(m).textContent?.trim()).toBe('状态未知')
    expect(toggle(m).disabled).toBe(true)
    expect(toggle(m).title).toContain('状态未知')
    m.fake.assertClean(); m.cleanup()
  })

  it('状态未知时点击按钮绝不发 PUT /enabled，也不弹关闭确认框', async () => {
    const { m } = await setup({ fail: true })
    toggle(m).click()
    await m.flush()
    expect(m.fake.count(API.firewall.setEnabled(), 'PUT')).toBe(0)
    expect(document.querySelector('.mask')).toBeNull()
    m.fake.assertClean(); m.cleanup()
  })

  it('绕过 disabled 强制派发 click 也不下发（toggleActive 的程序化兜底）', async () => {
    const { m } = await setup({ fail: true })
    // disabled 只挡真实点击；dispatchEvent 仍会进 @click 处理器，用来钉住函数内的 guard
    toggle(m).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await m.flush()
    expect(m.fake.count(API.firewall.setEnabled(), 'PUT')).toBe(0)
    m.fake.assertClean(); m.cleanup()
  })

  it('确认框等待期间状态转为未知，点确认也不下发（setActive 的程序化兜底）', async () => {
    const { m, setFail } = await setup()
    toggle(m).click() // active=true → 先弹「关闭防火墙」确认框
    await m.flush()
    const dlg = document.querySelector<HTMLElement>('.mask')
    expect(dlg, '关闭防火墙必须先确认').not.toBeNull()
    setFail(true)
    const refresh = [...m.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '').includes('刷新'))
    expect(refresh, '状态刷新入口必须存在').not.toBeUndefined()
    refresh!.click()
    await m.flush()
    expect(badge(m)).toBe('状态未知')
    const confirm = dlg!.querySelector<HTMLButtonElement>('.btn-danger')
    expect(confirm).not.toBeNull()
    confirm!.click()
    await m.flush()
    expect(m.fake.count(API.firewall.setEnabled(), 'PUT')).toBe(0)
    m.fake.assertClean(); m.cleanup()
  })

  it('缺 firewall.manage 权限时按钮也禁用（原门控不得被改坏）', async () => {
    const { m } = await setup({ perms: ['system.view'] })
    expect(toggle(m).disabled).toBe(true)
    expect(toggle(m).title).toContain('无 firewall.manage 权限')
    m.fake.assertClean(); m.cleanup()
  })

  it('点错误条里的「重试」恢复成功后，按钮重新可点', async () => {
    const { m, setFail } = await setup({ fail: true })
    expect(toggle(m).disabled).toBe(true)
    setFail(false)
    const retry = m.host.querySelector<HTMLButtonElement>('.err-retry')
    expect(retry, '失败态必须给出重试入口').not.toBeNull()
    retry!.click()
    await m.flush()
    expect(badge(m)).toBe('已启用')
    expect(toggle(m).disabled).toBe(false)
    expect(toggle(m).textContent?.trim()).toBe('关闭')
    m.fake.assertClean(); m.cleanup()
  })
})

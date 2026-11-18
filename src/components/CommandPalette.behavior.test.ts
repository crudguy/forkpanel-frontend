// @vitest-environment jsdom
/**
 * 命令面板真挂载行为测试：只测纯函数证明不了"用户按了键、面板真出现、能跳转"。
 *
 * ⚠ 夹具权限必须跟着目标路由的门控走：`/logs/audit` 要 audit.view，
 *   而 mountView 默认权限没有它——不补就会出现"组件正确拒绝跳转、测试误判成 bug"。
 *   同时钉死反向语义：置灰项连回车也不能跳，防止只给 click 加门控被键盘绕过。
 */
import { describe, it, expect } from 'vitest'
import CommandPalette from './CommandPalette.vue'
import { CAP } from '@/api/types'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { setInput } from '@/test/toastHarness'
import type { RouteLike } from '@/composables/commandPalette'

const ROUTES: RouteLike[] = [
  { name: 'dashboard', path: '/', meta: { title: '概览' } },
  { name: 'sites', path: '/sites', meta: { title: '网站' } },
  { name: 'logs-audit', path: '/logs/audit', meta: { title: '审计日志' } },
  { name: 'firewall-baseline', path: '/firewall/baseline', meta: { title: '安全基线' } },
]

function openByShortcut() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
}

function pathOf(m: Mounted): string {
  const gp = m.app.config.globalProperties as unknown as { $router: { currentRoute: { value: { path: string } } } }
  return gp.$router.currentRoute.value.path
}

function mountPalette(caps = capsAllOk(), perms?: string[]) {
  return mountView({ component: CommandPalette, props: { routes: ROUTES }, caps, perms })
}

describe('命令面板（真挂载）', () => {
  it('Ctrl+K 打开并聚焦输入框，Esc 关闭', async () => {
    const m = await mountPalette()
    expect(document.querySelector('.cp-panel')).toBeNull()

    openByShortcut()
    await m.flush()
    expect(document.querySelector('.cp-panel'), 'Ctrl+K 没打开面板').not.toBeNull()
    expect(document.activeElement?.classList.contains('cp-input'), '打开后未聚焦输入框').toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await m.flush()
    expect(document.querySelector('.cp-panel')).toBeNull()
    m.cleanup()
  })

  it('输入过滤后回车跳到目标路由', async () => {
    // /logs/audit 的门控是 LOGS_READ + audit.view，夹具必须补上权限点，
    // 否则组件会按诚实降级拒绝跳转，测试却误以为回车失灵。
    const m = await mountPalette(capsAllOk(), ['audit.view'])
    openByShortcut()
    await m.flush()

    const input = document.querySelector<HTMLInputElement>('.cp-input')!
    setInput(input, '审计')
    await m.flush()
    const items = document.querySelectorAll('.cp-item')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toContain('审计日志')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await m.flush()
    expect(pathOf(m), '回车没有跳转').toBe('/logs/audit')
    expect(document.querySelector('.cp-panel')).toBeNull()
    m.cleanup()
  })

  it('置灰项连回车也不能跳转（键盘不得绕过 click 门控）', async () => {
    // 默认权限缺 audit.view：这里刻意不补，验证键盘路径同样受 whyDisabledForPath 约束。
    const m = await mountPalette()
    openByShortcut()
    await m.flush()

    const input = document.querySelector<HTMLInputElement>('.cp-input')!
    setInput(input, '审计')
    await m.flush()
    const items = document.querySelectorAll('.cp-item')
    expect(items.length).toBe(1)
    expect(items[0].classList.contains('is-disabled'), '缺 audit.view 时审计项应置灰').toBe(true)

    const before = pathOf(m)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await m.flush()
    expect(pathOf(m), '回车绕过了置灰门控').toBe(before)
    expect(document.querySelector('.cp-panel'), '禁用项回车后不该关面板').not.toBeNull()
    m.cleanup()
  })

  it('能力不支持的页面置灰，点击不跳转（诚实降级）', async () => {
    const m = await mountPalette(capsAllOk({
      [CAP.FIREWALL_MANAGE]: { supported: false, backend: null, reason: 'need_root' },
    }))
    openByShortcut()
    await m.flush()

    const disabled = [...document.querySelectorAll<HTMLElement>('.cp-item.is-disabled')]
    expect(disabled.length).toBeGreaterThan(0)
    // 默认权限下「网站」也会因 site.view 缺失而置灰，故按标题精确定位能力位那条
    const baseline = disabled.find((el) => el.textContent?.includes('安全基线'))
    expect(baseline, '能力不支持的安全基线没有置灰').toBeTruthy()
    expect(baseline!.textContent).toContain('当前环境不支持')
    const before = pathOf(m)
    baseline!.click()
    await m.flush()
    expect(pathOf(m), '置灰项仍然可跳转').toBe(before)
    m.cleanup()
  })
})

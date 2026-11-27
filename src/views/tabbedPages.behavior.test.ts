// @vitest-environment jsdom
/**
 * 页签组织（设置 / 备份 / 数据库 / WAF）的真挂载行为测试。
 *
 * 钉住三件事，缺一条就等于"页签只是画上去了"：
 * 1. 默认签只显示重点内容，其余面板确实隐藏（不是全部堆在一起）；
 * 2. 点页签真的换面板（激活态跟着走），不是点了没反应；
 * 3. 切换用 v-show 保状态：在 A 签输入的内容，切到 B 再切回来必须还在
 *    ——换成 v-if 会重建子树，输入与下钻层级全部丢失，而 tsc/构建都不会报错。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import type { SettingsReport } from '@/api/types'
import SettingsView from '@/views/SettingsView.vue'
import BackupsView from '@/views/BackupsView.vue'
import DatabasesView from '@/views/DatabasesView.vue'
import WafView from '@/views/WafView.vue'
import { mountView, type Mounted } from '@/test/mount'

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/** 页签按钮（TabBar 受控模式的 <button class="tab">）。 */
function tabs(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.tabs .tab')]
}
function tabByLabel(host: HTMLElement, label: string): HTMLButtonElement {
  const hit = tabs(host).find((t) => (t.textContent ?? '').includes(label))
  if (!hit) throw new Error(`找不到页签「${label}」`)
  return hit
}
/** v-show 的可见性判据：隐藏时内联 display:none；显示时内联 style 被清空。 */
function visible(el: Element | null): boolean {
  if (!el) return false
  return (el as HTMLElement).style.display !== 'none'
}
/** 所有 Tab 面板（.tab-pane）。数量 = 页签对应的内容块数。 */
function panes(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.tab-pane')]
}

/** 只有恰好一个面板可见，且返回它。 */
function soleVisiblePane(host: HTMLElement): HTMLElement {
  const shown = panes(host).filter(visible)
  expect(shown).toHaveLength(1)
  return shown[0]
}

/** 设置页的四个页签各自就是一张 section.card（没有额外面板包裹），单独取可见卡。 */
function soleVisibleCard(host: HTMLElement): HTMLElement {
  const shown = [...host.querySelectorAll<HTMLElement>('section.card')].filter(visible)
  expect(shown).toHaveLength(1)
  return shown[0]
}

// ── 设置 ────────────────────────────────────────────────────────────────
function settingsReport(): SettingsReport {
  return {
    runtime: {
      endpoint: 'https://api.example.com/v1', model: 'demo-model', api_key_set: true,
      narrative: false, narrative_note: '', chat_context: false, chat_context_note: '',
    },
    deployment: {
      read_only: false, tier: 'standard', max_login_attempts: 5,
      session_idle: '30m', session_absolute: '12h', audit_retention_days: 30, audit_max_rows: 1000,
      localhost_only: true, db_daily_backup: true, db_synchronous: 'NORMAL', db_backup_keep: 7,
      installation: {
        app_version: '0.1.0', build: 'dev', platform: 'linux', bin_path: '/usr/local/bin/panel',
        config_dir: '/etc/forkpanel', data_dir: '/var/lib/forkpanel', log_dir: '/var/log/forkpanel',
        service_manager: 'systemd', service_active: true, service_enabled: true,
        can_restart: true, can_upgrade: true, upgrade_blocked_reason: null,
      },
      hint: '部署级参数需编辑 config.toml 后重启生效',
    },
    reserved: { wired: false, note: '', values: {} },
  } as SettingsReport
}

describe('设置页：按功能分组，默认 AI 接入，切签保状态', () => {
  const routes = {
    [API.settings.get()]: settingsReport(),
    [API.roles.list()]: { roles: [], known_permissions: ['system.view'] },
    [API.system.publicIp()]: { public_ip: '203.0.113.7' },
  }
  const perms = ['settings.manage', 'user.manage', 'system.manage', 'system.view']

  it('默认显示「AI 接入」，其余三个面板隐藏', async () => {
    m = await mountView({ component: SettingsView, routes, perms })
    const labels = tabs(m.host).map((t) => (t.textContent ?? '').trim())
    expect(labels).toEqual(['AI 接入', '面板维护', '角色权限', '能力矩阵'])
    expect(tabByLabel(m.host, 'AI 接入').classList.contains('on')).toBe(true)
    const pane = soleVisibleCard(m.host)
    expect(pane.textContent).toContain('AI 助手 · LLM 接入')
  })

  it('点「面板维护」后只剩维护面板可见，激活态跟随', async () => {
    m = await mountView({ component: SettingsView, routes, perms })
    tabByLabel(m.host, '面板维护').click()
    await m.flush()
    expect(tabByLabel(m.host, '面板维护').classList.contains('on')).toBe(true)
    expect(tabByLabel(m.host, 'AI 接入').classList.contains('on')).toBe(false)
    expect(soleVisibleCard(m.host).textContent).toContain('面板维护')
    // 四个面板必须都还在 DOM 里（v-show）。若改成 v-if，隐藏签被卸载，
    // 输入/下钻层级随之丢失——这条断言就是"保状态"的结构判据。
    expect(m.host.querySelectorAll('section.card')).toHaveLength(4)
  })

  it('无设置/用户管理权限时落到「能力矩阵」，不是一片空白', async () => {
    // 只有能力矩阵恒在；activeTab 若停在 'llm'，四个 section 全被 v-show 隐藏 ⇒ 空页。
    m = await mountView({ component: SettingsView, routes, perms: ['system.view'] })
    // 只剩一个可见签时页签条本身不渲染（没有可切换的对象），直接呈现唯一面板。
    expect(tabs(m.host)).toHaveLength(0)
    expect(soleVisibleCard(m.host).textContent).toContain('能力矩阵')
  })

  it('Endpoint 输入在切签往返后保持（v-show 而非 v-if）', async () => {
    m = await mountView({ component: SettingsView, routes, perms })
    const input = m.host.querySelector<HTMLInputElement>('input[type=url]')!
    input.value = 'https://changed.example/v1'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await m.flush()
    tabByLabel(m.host, '能力矩阵').click()
    await m.flush()
    tabByLabel(m.host, 'AI 接入').click()
    await m.flush()
    expect(m.host.querySelector<HTMLInputElement>('input[type=url]')!.value)
      .toBe('https://changed.example/v1')
  })
})

// ── 备份 ────────────────────────────────────────────────────────────────
describe('备份页：计划与系统备份分签', () => {
  const routes = {
    [API.backups.system()]: { dir: '/var/lib/forkpanel/backups', items: [], keep: 7, daily_backup: true },
    [API.backups.list()]: [],
    [API.db.connections()]: [],
  }

  it('默认「备份计划」，系统备份面板隐藏', async () => {
    m = await mountView({ component: BackupsView, routes })
    expect(tabs(m.host).map((t) => (t.textContent ?? '').trim())).toEqual(['备份计划', '系统备份'])
    expect(soleVisiblePane(m.host).textContent).toContain('新建备份计划')
  })

  it('切到「系统备份」后显示实际保留份数，切回表单值不丢', async () => {
    m = await mountView({ component: BackupsView, routes })
    const keep = m.host.querySelector<HTMLInputElement>('input[type=number]')!
    keep.value = '9'
    keep.dispatchEvent(new Event('input', { bubbles: true }))
    await m.flush()

    tabByLabel(m.host, '系统备份').click()
    await m.flush()
    const sysPane = soleVisiblePane(m.host)
    expect(sysPane.textContent).toContain('实际保留 7 份')
    expect(panes(m.host)).toHaveLength(2)   // 计划面板仍挂载（v-show）

    tabByLabel(m.host, '备份计划').click()
    await m.flush()
    expect(soleVisiblePane(m.host).textContent).toContain('新建备份计划')
    expect(m.host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('9')
  })
})

// ── 数据库 ──────────────────────────────────────────────────────────────
describe('数据库页：连接管理与数据浏览分签', () => {
  const routes = { [API.db.connections()]: [], [API.db.engines()]: { engines: [] } }

  it('默认「连接管理」；数据浏览签给出可操作的空态', async () => {
    m = await mountView({ component: DatabasesView, routes })
    expect(tabs(m.host).map((t) => (t.textContent ?? '').trim())).toEqual(['连接管理', '数据浏览'])
    expect(soleVisiblePane(m.host).textContent).toContain('新增连接')

    tabByLabel(m.host, '数据浏览').click()
    await m.flush()
    const pane = soleVisiblePane(m.host)
    expect(panes(m.host)).toHaveLength(2)
    expect(pane.textContent).toContain('尚未打开数据浏览')
    expect(pane.textContent).toContain('连接管理')
    // 零连接：引导去新增；不能出现一个没有任何选项的连接选择器
    expect(pane.textContent).toContain('去新增连接')
    expect(pane.querySelector('select[aria-label="选择要浏览的连接"]')).toBeNull()
  })
})

// ── WAF ─────────────────────────────────────────────────────────────────
describe('WAF 页：站点 / 模板 / 日志三签', () => {
  const routes = {
    [API.sites.list()]: [],
    [API.waf.templates.list()]: [],
    [API.waf.events.list()]: [],
    [API.waf.alert.get()]: { enabled: true, threshold: 50, window_min: 5 },
  }

  it('默认「站点防护」，另外两签隐藏', async () => {
    m = await mountView({ component: WafView, routes })
    expect(tabs(m.host).map((t) => (t.textContent ?? '').trim()))
      .toEqual(['站点防护', '策略模板', '日志与告警'])
    expect(soleVisiblePane(m.host).textContent).toContain('站点')
  })

  it('切到「日志与告警」显示告警配置，切回站点签状态仍在', async () => {
    m = await mountView({ component: WafView, routes })
    tabByLabel(m.host, '日志与告警').click()
    await m.flush()
    expect(soleVisiblePane(m.host).textContent).toContain('拦截告警')
    expect(panes(m.host)).toHaveLength(3)

    tabByLabel(m.host, '站点防护').click()
    await m.flush()
    expect(soleVisiblePane(m.host).textContent).toContain('站点')
  })
})

// @vitest-environment jsdom
// F-05 / F-09：侧栏、Tab、顶栏、命令面板、路由守卫必须共用同一套 cap+perm 判据。
// 判据本身用真 Pinia store 测；命令面板用真挂载验「搜得到/搜不到」。
import { describe, it, expect } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { CAP, type CapabilityMap } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { NAV_ITEMS } from './navItems'
import { gateForPath, whyDisabledForPath, navGuardDecision } from './navPolicy'
import CommandPalette from '@/components/CommandPalette.vue'

const ALL_PERMS = [
  'system.view', 'system.manage', 'site.view', 'service.view', 'db.view',
  'container.view', 'backup.view', 'file.read', 'firewall.manage',
  'security.manage', 'cron.view', 'task.view', 'log.view', 'audit.view',
  'terminal.manage', 'user.manage', 'settings.manage', 'expose.manage',
]

function store(caps: CapabilityMap = capsAllOk(), perms: string[] = ALL_PERMS) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.capabilities = caps
  auth.me = { user: 'tester', role: 'admin', permissions: perms,
    allowed_roots: ['/'], tier: 'standard' }
  return auth
}

describe('F-05 gateForPath：门控表的结构与回退', () => {
  it('审计 Tab 的门控与 AuditView 页面判据完全同值（不再拿 METRICS_READ 兜底）', () => {
    expect(gateForPath('/logs/audit')).toEqual({ cap: CAP.LOGS_READ, perm: 'audit.view' })
    const auth = store()
    expect(whyDisabledForPath(auth, '/logs/audit')).toBeNull()
    expect(auth.enabled(CAP.LOGS_READ, 'audit.view')).toBe(true)
  })

  it('任务中心 / 通知是面板内建页，cap=null 只判权限点', () => {
    expect(gateForPath('/cron/tasks')).toEqual({ cap: null, perm: 'task.view' })
    expect(gateForPath('/notifications')).toEqual({ cap: null, perm: 'system.view' })
  })

  it('动态子路径逐级回退继承父项，未登记路径放行（null）', () => {
    expect(gateForPath('/services/nginx.service')).toEqual({
      cap: CAP.SERVICE_MANAGE, perm: 'service.view',
    })
    expect(gateForPath('/never/heard/of')).toBeNull()
  })

  it('ALWAYS_CAP 不再隐含依赖「指标能力恒 yes」', () => {
    // 指标能力位因故为 no 时，设置/帮助/AI 助手这类无关页面不该一起变灰。
    const caps = capsAllOk({ [CAP.METRICS_READ]: { supported: false, reason: 'binary_missing' } })
    const auth = store(caps)
    expect(whyDisabledForPath(auth, '/settings')).toBeNull()
    expect(whyDisabledForPath(auth, '/help')).toBeNull()
    expect(whyDisabledForPath(auth, '/assistant')).toBeNull()
    // 但真正绑定指标能力的数据展示仍由调用方自己判（healthOk）
    expect(auth.supported(CAP.METRICS_READ)).toBe(false)
  })

  it('NAV_ITEMS 每一条都能被 gateForPath 解释，且恒显项恰好 8 条', () => {
    for (const n of NAV_ITEMS) expect(gateForPath(n.to), n.to).not.toBeNull()
    expect(NAV_ITEMS.filter((n) => gateForPath(n.to)?.cap === null).length).toBe(8)
  })
})

describe('F-05 Tab 与页面判据不再打架', () => {
  it('LOGS_READ 关闭时：审计 Tab 与 AuditView 同时不可用', () => {
    const auth = store(capsAllOk({ [CAP.LOGS_READ]: { supported: false, reason: 'no_log_source' } }))
    expect(whyDisabledForPath(auth, '/logs/audit')).not.toBeNull()
    expect(auth.enabled(CAP.LOGS_READ, 'audit.view')).toBe(false)
    // 系统日志 Tab 也应一起灰（同一能力位）
    expect(whyDisabledForPath(auth, '/logs')).not.toBeNull()
  })

  it('缺 audit.view 时：审计 Tab 灰，系统日志 Tab 仍可见', () => {
    const auth = store(capsAllOk(), ALL_PERMS.filter((p) => p !== 'audit.view'))
    expect(whyDisabledForPath(auth, '/logs/audit')).toBe('权限不足')
    expect(whyDisabledForPath(auth, '/logs')).toBeNull()
  })

  it('缺 task.view 时任务中心 Tab 灰，计划任务 Tab 不受牵连', () => {
    const auth = store(capsAllOk(), ALL_PERMS.filter((p) => p !== 'task.view'))
    expect(whyDisabledForPath(auth, '/cron/tasks')).toBe('权限不足')
    expect(whyDisabledForPath(auth, '/cron')).toBeNull()
  })
})

describe('F-09 路由守卫的纯决策', () => {
  it('有禁用原因 → 重定向到概览', () => {
    expect(navGuardDecision({ capsLoaded: true, toName: 'notifications', why: '权限不足' }))
      .toEqual({ name: 'dashboard' })
  })

  it('能力矩阵未加载 → 放行（否则首屏所有页面都会被误挡）', () => {
    expect(navGuardDecision({ capsLoaded: false, toName: 'settings', why: '当前环境不支持' }))
      .toBe(true)
  })

  it('目标已是概览 → 放行（防无权限时的重定向循环）', () => {
    expect(navGuardDecision({ capsLoaded: true, toName: 'dashboard', why: '权限不足' }))
      .toBe(true)
  })

  it('未登记门控 / 用户确实可达 → 放行', () => {
    expect(navGuardDecision({ capsLoaded: true, toName: 'help', why: null })).toBe(true)
  })

  it('真判据接到决策上：缺 system.view 深链通知页会被挡', () => {
    const auth = store(capsAllOk(), ALL_PERMS.filter((p) => p !== 'system.view'))
    const why = whyDisabledForPath(auth, '/notifications')
    expect(why).toBe('权限不足')
    expect(navGuardDecision({ capsLoaded: true, toName: 'notifications', why }))
      .toEqual({ name: 'dashboard' })
  })
})

describe('F-09 非导航路径不再一律放行', () => {
  it('whyDisabledForPath 对 /notifications 按 system.view 过滤', () => {
    expect(whyDisabledForPath(store(capsAllOk(), ALL_PERMS), '/notifications')).toBeNull()
    expect(whyDisabledForPath(
      store(capsAllOk(), ALL_PERMS.filter((p) => p !== 'system.view')), '/notifications',
    )).toBe('权限不足')
  })

  it('命令面板真挂载：无 system.view 时搜不到「打开通知」', async () => {
    const m: Mounted = await mountView({
      component: CommandPalette,
      props: { open: true },
      perms: ALL_PERMS.filter((p) => p !== 'system.view'),
      caps: capsAllOk(),
    })
    const items = [...document.querySelectorAll('.pal li')].map((li) => li.textContent ?? '')
    expect(items.some((t) => t.includes('打开通知'))).toBe(false)
    // 活性自检：面板本身确实渲染了内容，不是「一个 li 都没有」的假绿
    expect(items.length).toBeGreaterThan(0)
    m.fake.assertClean(); m.cleanup()
  })

  it('命令面板真挂载：有 system.view 时「打开通知」可见', async () => {
    const m: Mounted = await mountView({
      component: CommandPalette,
      props: { open: true },
      perms: ALL_PERMS,
      caps: capsAllOk(),
    })
    const items = [...document.querySelectorAll('.pal li')].map((li) => li.textContent ?? '')
    expect(items.some((t) => t.includes('打开通知'))).toBe(true)
    m.fake.assertClean(); m.cleanup()
  })
})

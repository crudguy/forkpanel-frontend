/**
 * 路由可达性判据的**唯一事实源**（F-05 / F-09）。
 *
 * 此前四套口径各写一份：侧栏用 `NAV_ITEMS` 的 cap+perm、Tab 容器把
 * `METRICS_READ` 当恒真兜底、页面自己只看 perm、命令面板对非导航路径一律
 * `return true`。结果是「Tab 可见但点进去无权限」（审计 Tab 用 METRICS_READ，
 * 页面却要 LOGS_READ）与「没 system.view 的人能从命令面板进通知页」。
 *
 * 现在：
 * - 顶层导航页的门控仍由 `NAV_ITEMS` 定义（侧栏/命令面板共用）；
 * - 非导航页与 Tab 子路由在 `EXTRA_GATES` 里显式声明，**取值对齐对应视图
 *   与后端 `perm::*`**（见 routes/audit.rs / notifications.rs / tasks.rs）；
 * - 侧栏、Tab、顶栏、命令面板、路由守卫全部走 `whyDisabledForPath()`。
 *
 * ⚠ 路径用逐级回退匹配：`/services/nginx` 继承 `/services` 的门控。
 * ⚠ 未登记路径返回 null = 「该路由没有声明门控」，保持放行；不要把它当成
 *   「不允许」——那会让新增页面在没登记时被静默挡死。
 */
import { CAP } from '@/api/types'
import { NAV_ITEMS, ALWAYS_CAP } from './navItems'
import type { useAuthStore } from '@/stores/auth'

export interface NavGate {
  /** 宿主能力位；null = 面板内建页面，不依赖任何 OS 能力（只判权限点） */
  cap: string | null
  /** RBAC 权限点 */
  perm: string
}

type AuthStore = ReturnType<typeof useAuthStore>

/** 非导航页 / Tab 子路由的门控。键是完整路径，值对齐页面与后端 require()。 */
const EXTRA_GATES: Record<string, NavGate> = {
  // 命令面板的「打开通知」是唯一非导航快捷操作；页面本身要求 system.view
  '/notifications': { cap: null, perm: 'system.view' },
  // 审计 Tab：页面用 enabled(LOGS_READ, 'audit.view')，不能再用 METRICS_READ 兜底
  '/logs/audit': { cap: CAP.LOGS_READ, perm: 'audit.view' },
  // 安全基线 Tab：与 SecurityCenterView 原判据同值，收归单一来源
  '/firewall/baseline': { cap: CAP.FIREWALL_MANAGE, perm: 'security.manage' },
  // 任务中心 Tab：页面只判 task.view，不绑宿主能力
  '/cron/tasks': { cap: null, perm: 'task.view' },
}

function normalize(path: string): string {
  const p = (path || '').split(/[?#]/)[0].replace(/\/+$/, '')
  return p || '/'
}

/** 查一条路径的门控；先精确，再逐级回退到父路径。 */
export function gateForPath(path: string): NavGate | null {
  let p = normalize(path)
  while (p) {
    const nav = NAV_ITEMS.find((n) => n.to === p)
    // ALWAYS_CAP 是「此页无宿主能力门槛」的显式标记，不是真的在判指标能力：
    // 之前直接把 CAP.METRICS_READ 交给 whyDisabled，等于把「指标能力恒 yes」
    // 当隐含前提；一旦该能力位因故为 no，设置/帮助/通知之类无关页面会集体变灰。
    if (nav) return { cap: nav.cap === ALWAYS_CAP ? null : nav.cap, perm: nav.perm }
    const extra = EXTRA_GATES[p]
    if (extra) return { ...extra }
    const i = p.lastIndexOf('/')
    p = i <= 0 ? '' : p.slice(0, i)
  }
  return null
}

/**
 * 置灰原因。返回 null = 可达。
 *
 * `cap: null` 时只判权限点，不再借 `METRICS_READ` 当「恒真」占位——
 * 否则指标能力一关，连「任务中心」「通知」这些无关页面都会一起被置灰。
 */
export function whyDisabledForPath(auth: AuthStore, path: string): string | null {
  const gate = gateForPath(path)
  if (!gate) return null
  if (gate.cap === null) return auth.can(gate.perm) ? null : '权限不足'
  return auth.whyDisabled(gate.cap, gate.perm)
}

export type GuardDecision = true | { name: 'dashboard' }

/**
 * 路由守卫的**纯决策**（F-09）。抽出来是为了能真测：直接跑 router 会拉起
 * `theme.ts` 的 matchMedia 与几十个懒加载视图，环境噪音远大于被测逻辑。
 *
 * 三条放行条件：
 * - 能力矩阵还没加载：此时判「不支持」会把首屏所有页面误挡；
 * - 目标已是概览：它是最终兜底页，再重定向会形成循环；
 * - 没有禁用原因：该路径压根没声明门控，或当前用户确实可达。
 */
export function navGuardDecision(o: {
  capsLoaded: boolean
  toName: string | null | undefined
  why: string | null
}): GuardDecision {
  if (!o.capsLoaded || o.toName === 'dashboard' || !o.why) return true
  return { name: 'dashboard' }
}

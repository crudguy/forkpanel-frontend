/**
 * 站点列表的**状态展示语义**（徽章文案 / 着色类 / 悬停说明）。
 *
 * 为什么从 SitesView 里搬出来：这三个函数是纯函数，却住在 `.vue` 里——vitest 只收
 * `src/**\/*.test.ts` 且未配 vue 插件，住在 SFC 里就**永远没法单测**。而它们恰好是
 * 本项目最容易写错的一类：判据是「实际状态」还是「期望状态」，一字之差就是撒谎
 * （见下面各自的注释）。搬出来只为可测，行为逐字不动。
 *
 * 摆放位置沿用 [`metricTone.ts`] 的先例——`composables/` 下放**非 composable 的纯
 * 展示语义模块**是本项目既有做法（`cpuTone` 亦如此），不必硬套 `useXxx` 命名。
 */
import type { Site } from '@/api/types'

/** 徽章三要素：文案 / 着色类 / 悬停说明。 */
export interface StateBadge {
  label: string
  cls: string
  title: string
}

/**
 * 站点状态三态。判据是 `deployed`（配置是否真下发）而不是 `enabled`（期望状态）：
 * 后者在新建后即为 true，但此刻 Web 服务器里根本没有这个站点——显示「运行中」就是撒谎。
 */
export function siteState(s: Site): StateBadge {
  if (!s.enabled) {
    return { label: '已停用', cls: '', title: '已从 Web 服务器摘除配置（或从未启用）' }
  }
  if (!s.deployed) {
    return { label: '未下发', cls: 'badge-warn', title: '已登记，但配置尚未下发到 Web 服务器；点「应用」后才会对外服务' }
  }
  return { label: '运行中', cls: 'badge-ok', title: '配置已下发到 Web 服务器并已 reload' }
}

/**
 * TLS 徽章三态。判据是"证书存在 **且** 配置已下发"——只看 `ssl_certs` 有无记录，
 * 会把"签了但没生效"显示成"已配置"，与同行的站点状态自相矛盾。
 */
export function tlsState(s: Site): StateBadge {
  if (!s.tls) {
    return { label: '无', cls: '', title: '尚未为该站点签发证书（在「编辑站点」里点「申请证书」）' }
  }
  if (!s.deployed) {
    return { label: '已签发·未生效', cls: 'badge-warn', title: '证书已生成并落盘，但站点配置尚未下发到 Web 服务器，HTTPS 还没生效' }
  }
  return { label: '已启用', cls: 'badge-ok', title: '证书已随站点配置在 Web 服务器生效' }
}

/**
 * 上次下发时间（023）列用紧凑格式：`MM-DD HH:mm`（无年份——同面板内「去年的
 * 下发」极少，完整时间走 title）。null/非法一律 `—`：0 是合法时间戳（1970），
 * 与「从未下发」语义相反，**绝不能把 NULL 显示成 1970**。
 */
export function fmtApplied(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

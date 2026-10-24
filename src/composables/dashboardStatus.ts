/**
 * 概览页「运行状态」四块磁贴的状态推导（审计 P1-20）。
 *
 * ## 为什么抽它
 * 这块逻辑原本住在 `DashboardView.vue` 的 computed 里：`svcTone`/`svcText`
 * 等八个 computed，靠 `ok` 一个布尔分辨「加载中 / 不可用 / 抓取失败」三种
 * 截然不同的状态——而 `loadStatus()` 的四路抓取失败全是裸 catch 静默吞掉，
 * 失败后 `ok` 停留在 false，磁贴渲染出「—」+ 灰点，与「健康但真的是空」
 * （成功抓到空列表）在用户侧完全无法区分：接口挂了却显示成"没有数据"，
 * 没有任何错误态与重试入口。
 *
 * 现在：抓取失败写入错误文案（`errorText`），磁贴显示「加载失败」+ 琥珀点，
 * 区块级错误条给出原因与重试（与指标卡的 `ovError` 同范式）。本模块只放
 * **纯推导**——`.vue` 里的纯逻辑没法单测（vitest 无 vue 插件，见仓库纪律），
 * 抽出来后四块磁贴的每种状态组合都能真跑断言。
 *
 * ## 状态机（每块磁贴）
 * - `err` 非空 ⇒ 「加载失败」+ `warn`（**优先于一切**：陈旧的成功数据也要让位，
 *   否则重试失败时磁贴还显示上次的旧计数，用户以为数据是新的）。
 * - `!ok && !err` ⇒ 尚未抓完（首屏加载中）⇒「—」+ `muted`。
 * - `ok` ⇒ 按各自计数给文案与 tone（与修复前逐字一致，避免顺手改语义）。
 */

/** 磁贴呈现：文案 + 状态点颜色类名（scoped CSS：.st-dot.ok/.warn/.danger/.muted） */
export interface TileView {
  text: string
  tone: 'ok' | 'warn' | 'danger' | 'muted'
}

export interface SvcState { total: number; active: number; failed: number; ok: boolean }
export interface CtState { total: number; running: number; ok: boolean }
export interface SiteState { total: number; enabled: number; ok: boolean }
export interface BkState { total: number; fail: number; ok: boolean }

/** 服务磁贴：失败 > 加载中 > 有异常服务(danger) > 正常运行(ok) */
export function svcTile(s: SvcState, err: string): TileView {
  if (err) return { text: '加载失败', tone: 'warn' }
  if (!s.ok) return { text: '—', tone: 'muted' }
  if (s.failed > 0) return { text: `${s.failed} 个服务异常`, tone: 'danger' }
  return { text: `${s.active} 个运行中`, tone: 'ok' }
}

/**
 * 容器磁贴：失败 > 加载中 > 能力性不可用（守护进程不可达 / 未安装 Docker，
 * 取自能力矩阵的 reason，与抓取失败是两回事——前者重试也没用）。
 */
export function ctTile(s: CtState, err: string, unavailable: string): TileView {
  if (err) return { text: '加载失败', tone: 'warn' }
  if (!s.ok) {
    if (unavailable === 'daemon_unreachable') return { text: '守护进程不可达', tone: 'muted' }
    if (unavailable === 'binary_missing') return { text: '未安装 Docker', tone: 'muted' }
    return { text: '不可用', tone: 'muted' }
  }
  const text = `运行中 ${s.running} / 共 ${s.total}`
  return { text, tone: s.total > 0 && s.running === 0 ? 'warn' : 'ok' }
}

/** 网站磁贴：失败 > 加载中 > 正常 */
export function siteTile(s: SiteState, err: string): TileView {
  if (err) return { text: '加载失败', tone: 'warn' }
  if (!s.ok) return { text: '—', tone: 'muted' }
  return { text: `共 ${s.total} 个 · 启用 ${s.enabled}`, tone: 'ok' }
}

/** 备份磁贴：失败 > 加载中 > 有计划失败(danger) > 未配置计划(warn) > 全部正常(ok) */
export function bkTile(s: BkState, err: string): TileView {
  if (err) return { text: '加载失败', tone: 'warn' }
  if (!s.ok) return { text: '—', tone: 'muted' }
  if (s.total === 0) return { text: '未配置计划', tone: 'warn' }
  if (s.fail > 0) return { text: `${s.fail} 个计划失败`, tone: 'danger' }
  return { text: '全部正常', tone: 'ok' }
}

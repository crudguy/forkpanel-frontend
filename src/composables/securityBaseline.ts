/**
 * 安全中心的可测纯逻辑：基线状态归一 / 操作区文案 / SSH 登录记录标签。
 *
 * 为什么从这里出：vitest.config.ts 只收 `src/**\/*.test.ts`，函数写在 `.vue`
 * 里就没法测（本仓已因此漏过一版静默失败）。视图只负责渲染，判据放这里。
 */

export type BaselineStatus = 'ok' | 'danger' | 'na'

export interface BaselineLike {
  key: string
  ok: boolean
  applicable: boolean
  current: string
  expected: string
  advice: string
}

/** 状态唯一判定：不适用优先于 ok —— `applicable=false` 时 ok 字段无意义。 */
export function baselineStatus(c: BaselineLike): BaselineStatus {
  if (!c.applicable) return 'na'
  return c.ok ? 'ok' : 'danger'
}

export const BASELINE_STATUS_LABEL: Record<BaselineStatus, string> = {
  ok: '通过',
  danger: '风险',
  na: '不适用',
}

/** 与后端 provider 白名单一致；白名单外的风险项不能假装可修。 */
export const FIXABLE_BASELINE_KEYS: readonly string[] = [
  'ssh.permit_root_login',
  'ssh.password_auth',
  'ssh.pubkey_auth',
]

export function canFixBaseline(c: BaselineLike): boolean {
  return baselineStatus(c) === 'danger' && FIXABLE_BASELINE_KEYS.includes(c.key)
}

/**
 * 操作区统一文案：每个状态都有明确的一句话，不出现空白操作区。
 * 可自动修的项返回空串——那里由「修复」按钮占位。
 */
export function baselineOpNote(c: BaselineLike): string {
  const st = baselineStatus(c)
  if (st === 'na') return '当前环境不适用，无需操作'
  if (st === 'ok') return '已符合，无需操作'
  if (canFixBaseline(c)) return ''
  return '需按说明手工处理（暂不支持自动修复）'
}

/** 说明区主文案：有建议时优先展示建议，否则回落到当前/期望值。 */
export function baselineAdvice(c: BaselineLike): string {
  return c.advice?.trim() || `当前 ${c.current || '—'}，期望 ${c.expected || '—'}`
}

// ───────────── SSH 登录记录 ─────────────

export interface SshLoginEvent {
  ts_unix: number
  ip: string
  user: string
  result: string
  risk: string
  detail: string
}

export const SSH_RESULT_LABEL: Record<string, string> = {
  success: '成功',
  failed: '失败',
}

export const SSH_RISK_LABEL: Record<string, string> = {
  none: '无',
  failed_password: '密码错误',
  invalid_user: '无效用户',
  root_attempt: '尝试 root 登录',
  root_login: 'root 登录成功',
  brute_force: '疑似爆破',
}

/** 风险徽章一律用全站 badge-* 药丸，禁止自造圆点色块。 */
export const SSH_RISK_BADGE: Record<string, string> = {
  none: 'badge-info',
  failed_password: 'badge-warn',
  invalid_user: 'badge-warn',
  root_attempt: 'badge-danger',
  root_login: 'badge-danger',
  brute_force: 'badge-danger',
}

export function sshResultLabel(v: string): string {
  return SSH_RESULT_LABEL[v] ?? v ?? '—'
}

export function sshRiskLabel(v: string): string {
  return SSH_RISK_LABEL[v] ?? v ?? '—'
}

export function sshRiskBadge(v: string): string {
  return SSH_RISK_BADGE[v] ?? 'badge-info'
}

/** 无结构化时间时如实显示破折号，不伪造 1970 或当前时间。 */
export function sshLogTime(ts: number, fmt: (t: number) => string): string {
  return ts > 0 ? fmt(ts) : '—'
}

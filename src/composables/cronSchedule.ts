/**
 * 计划任务的「执行频率」可视化模型。
 *
 * 后端只收标准 5 段 cron，但让普通用户把「每 5 分钟」翻译成五段写法是不合理的。
 * 这里把常用周期收敛成看得懂的选项，再编成后端可解析的规范格式；
 * 用户手写的复杂表达式一律归到「自定义」原样保留，绝不擅自改写。
 *
 * 与 backupSchedule 同源思路，但独立一份：备份模块有「仅手动」语义和专属文案，
 * 计划任务必须填表达式才能提交，两者生命周期不同，合在一起会互相污染。
 *
 * ⚠️ 后端在 dom / dow 同时非 `*` 时按标准 cron 的 OR 语义匹配。本文件生成的
 * 表达式永远只让其中一个非 `*`，避免「每月 1 日又每周一」这种意外触发。
 */

export type CronMode = 'every' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface CronScheduleView {
  mode: CronMode
  /** 间隔分钟数，1-59 */
  every: number
  /** 本地时间 'HH:MM' */
  time: string
  /** 周几：'0' = 周日，与后端 dow 编号一致 */
  weekday: string
  /** 每月几号：'1'-'31' */
  monthday: string
  /** 自定义表达式原值 */
  custom: string
}

export const DEFAULT_CRON_SCHEDULE: CronScheduleView = {
  mode: 'daily', every: 5, time: '03:00', weekday: '1', monthday: '1', custom: '',
}

const WEEKDAY_LABELS: Record<string, string> = {
  '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六',
}

/**
 * 严格识别本模块生成的规范格式；其它一律归 custom 原样保留。
 * 解析只用于「反推快捷设置」，不参与提交，所以保守比聪明更重要。
 */
export function parseCronSchedule(expr: string): CronScheduleView {
  const v = (expr ?? '').trim()
  if (!v) return { ...DEFAULT_CRON_SCHEDULE, custom: '' }

  const every = v.match(/^\*\/(\d{1,2}) \* \* \* \*$/)
  if (every) {
    const n = Number(every[1])
    if (n >= 1 && n <= 59) return { ...DEFAULT_CRON_SCHEDULE, mode: 'every', every: n }
  }
  if (v === '0 * * * *') return { ...DEFAULT_CRON_SCHEDULE, mode: 'hourly' }

  const m = v.match(/^(\d{1,2})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(\S+)$/)
  if (!m) return { ...DEFAULT_CRON_SCHEDULE, mode: 'custom', custom: v }

  const minute = Number(m[1])
  const hour = Number(m[2])
  if (minute > 59 || hour > 23) return { ...DEFAULT_CRON_SCHEDULE, mode: 'custom', custom: v }
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  // m[0] 是完整匹配，字段从 m[1] 起：分、时、日、月、星期。
  const dom = m[3]
  const mon = m[4]
  const dow = m[5]

  if (dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_CRON_SCHEDULE, mode: 'daily', time }
  }
  if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return { ...DEFAULT_CRON_SCHEDULE, mode: 'weekly', time, weekday: dow }
  }
  if (/^([1-9]|[12]\d|3[01])$/.test(dom) && mon === '*' && dow === '*') {
    return { ...DEFAULT_CRON_SCHEDULE, mode: 'monthly', time, monthday: dom }
  }
  return { ...DEFAULT_CRON_SCHEDULE, mode: 'custom', custom: v }
}

/** 可视化状态 → 后端接收的 cron 字符串。非法中间态返回空串，宁可不提交也不生成非法表达式。 */
export function cronScheduleToCron(s: CronScheduleView): string {
  const [h, m] = s.time.split(':')
  const hour = Number(h)
  const minute = Number(m)
  const validTime = Number.isInteger(hour) && Number.isInteger(minute)
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59

  switch (s.mode) {
    case 'every':
      return Number.isInteger(s.every) && s.every >= 1 && s.every <= 59 ? `*/${s.every} * * * *` : ''
    case 'hourly':
      return '0 * * * *'
    case 'daily':
      return validTime ? `${minute} ${hour} * * *` : ''
    case 'weekly':
      return validTime && /^[0-6]$/.test(s.weekday) ? `${minute} ${hour} * * ${s.weekday}` : ''
    case 'monthly':
      return validTime && /^([1-9]|[12]\d|3[01])$/.test(s.monthday)
        ? `${minute} ${hour} ${Number(s.monthday)} * *` : ''
    case 'custom':
      return (s.custom ?? '').trim()
  }
}

/** 人话摘要，刻意不出现 "cron" 字样。 */
export function describeCron(expr: string): string {
  if (!(expr ?? '').trim()) return '尚未设置执行时间'
  const s = parseCronSchedule(expr)
  switch (s.mode) {
    case 'every':
      return `每 ${s.every} 分钟执行一次（本地时间）`
    case 'hourly':
      return '每小时整点执行一次（本地时间）'
    case 'daily':
      return `每天 ${s.time} 执行一次（本地时间）`
    case 'weekly':
      return `每周${WEEKDAY_LABELS[s.weekday] ?? ''} ${s.time} 执行一次（本地时间）`
    case 'monthly':
      return `每月 ${Number(s.monthday)} 日 ${s.time} 执行一次（本地时间）`
    case 'custom':
      return s.custom ? `按自定义规则执行：${s.custom}（本地时间）` : '尚未设置执行时间'
  }
}

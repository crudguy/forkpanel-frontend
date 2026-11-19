/**
 * 备份计划的「自动备份时间」可视化模型。
 *
 * 后端只认标准 5 段 cron 字符串，但直接把输入框摊给小白运维等于没做——
 * 他得先把「每天凌晨三点」翻译成 `0 3 * * *` 才填得出来。这里把常用周期
 * 收敛成 仅手动 / 每天 / 每周 / 每月 四种可视化选项，只把它们编成后端
 * `next_fire_times` 能解析的规范格式；看不懂或更灵活的表达式归到「自定义」
 * 原样保留，绝不擅自改写用户已有的表达式。
 *
 * ⚠️ 后端在 dom / dow 同时非 `*`（的两个字段都不是星）时按**标准 cron 的 OR**
 * 语义匹配（见 panel-os scheduler.rs day_match）。所以本文件生成的表达式
 * 只会让 dom 或 dow **其中一个**非 `*`，不踩这个坑。
 *
 * 纯逻辑住 .ts（不进 .vue），这样 vitest 能直接测转换与解析的边界。
 */

export type ScheduleMode = 'manual' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface ScheduleView {
  /** 周期模式 */
  mode: ScheduleMode
  /** 本地时间 'HH:MM' */
  time: string
  /** 周几：'0' = 周日，'1'-'6' = 周一至周六（与后端 dow 编号一致） */
  weekday: string
  /** 每月几号：'1'-'31' */
  monthday: string
  /** 自定义表达式原值（原样保留，不改写） */
  custom: string
}

export const DEFAULT_SCHEDULE: ScheduleView = {
  mode: 'manual', time: '03:00', weekday: '1', monthday: '1', custom: '',
}

const WEEKDAY_LABELS: Record<string, string> = {
  '0': '周日', '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六',
}

/** 严格识别本模块生成的规范格式；其它一律归 custom 原样保留。 */
export function parseSchedule(expr: string): ScheduleView {
  const v = (expr ?? '').trim()
  if (!v) return { ...DEFAULT_SCHEDULE }

  const m = v.match(/^(\d{1,2})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(\S+)$/)
  if (!m) return { ...DEFAULT_SCHEDULE, mode: 'custom', custom: v }

  const minute = Number(m[1])
  const hour = Number(m[2])
  if (minute > 59 || hour > 23) return { ...DEFAULT_SCHEDULE, mode: 'custom', custom: v }

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  // m[0] 是完整匹配，字段从 m[1] 起：分、时、日、月、星期。
  // 别用连续逗号数下标——数错一位会把 `0 3 * * *` 误判成「每月 3 日」。
  const dom = m[3]
  const mon = m[4]
  const dow = m[5]

  if (dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_SCHEDULE, mode: 'daily', time }
  }
  if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return { ...DEFAULT_SCHEDULE, mode: 'weekly', time, weekday: dow }
  }
  if (/^([1-9]|[12]\d|3[01])$/.test(dom) && mon === '*' && dow === '*') {
    return { ...DEFAULT_SCHEDULE, mode: 'monthly', time, monthday: dom }
  }
  return { ...DEFAULT_SCHEDULE, mode: 'custom', custom: v }
}

/** 可视化状态 → 后端接收的 cron_expr 字符串。 */
export function scheduleToCron(s: ScheduleView): string {
  // 时间输入异常时退回自定义原值，绝不生成非法表达式（宁可保守）。
  const [h, m] = s.time.split(':')
  const hour = Number(h)
  const minute = Number(m)
  const validTime = Number.isInteger(hour) && Number.isInteger(minute)
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59

  switch (s.mode) {
    case 'manual':
      return ''
    case 'custom':
      return (s.custom ?? '').trim()
    case 'daily':
      return validTime ? `${minute} ${hour} * * *` : ''
    case 'weekly':
      return validTime ? `${minute} ${hour} * * ${s.weekday}` : ''
    case 'monthly':
      return validTime && /^([1-9]|[12]\d|3[01])$/.test(s.monthday)
        ? `${minute} ${hour} ${Number(s.monthday)} * *` : ''
  }
}

/** 人话摘要，给表单下方的说明区用；刻意不出现 "cron" 字样。 */
export function scheduleDescription(expr: string): string {
  const s = parseSchedule(expr)
  switch (s.mode) {
    case 'manual':
      return '仅手动执行（不自动备份）'
    case 'daily':
      return `每天 ${s.time} 自动备份（本地时间）`
    case 'weekly':
      return `每周${WEEKDAY_LABELS[s.weekday] ?? ''} ${s.time} 自动备份（本地时间）`
    case 'monthly':
      return `每月 ${Number(s.monthday)} 日 ${s.time} 自动备份（本地时间）`
    case 'custom':
      return s.custom ? `按自定义规则执行：${s.custom}（本地时间）` : '仅手动执行（不自动备份）'
  }
}

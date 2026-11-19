import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SCHEDULE, parseSchedule, scheduleToCron, scheduleDescription,
  type ScheduleView,
} from './backupSchedule'

describe('parseSchedule：把 cron_expr 解析成可视化状态', () => {
  it('空表达式 = 仅手动', () => {
    expect(parseSchedule('')).toEqual(DEFAULT_SCHEDULE)
    expect(parseSchedule('   ')).toEqual(DEFAULT_SCHEDULE)
  })

  it('每天：分钟/小时补零', () => {
    expect(parseSchedule('0 3 * * *')).toEqual({ ...DEFAULT_SCHEDULE, mode: 'daily', time: '03:00' })
    expect(parseSchedule('5 13 * * *')).toEqual({ ...DEFAULT_SCHEDULE, mode: 'daily', time: '13:05' })
  })

  it('每周：星期编号与后端一致（0=周日）', () => {
    expect(parseSchedule('30 22 * * 1')).toEqual({
      ...DEFAULT_SCHEDULE, mode: 'weekly', time: '22:30', weekday: '1',
    })
    expect(parseSchedule('30 22 * * 0').weekday).toBe('0')
  })

  it('每月：日字段', () => {
    expect(parseSchedule('0 9 15 * *')).toEqual({
      ...DEFAULT_SCHEDULE, mode: 'monthly', time: '09:00', monthday: '15',
    })
  })

  it('看不懂的表达式原样归自定义，绝不改写', () => {
    for (const expr of ['*/15 * * * *', '0 3 * * 1,5', '0 0 13 * 5', '0 5 31 2 *', 'bad expr']) {
      const s = parseSchedule(expr)
      expect(s.mode).toBe('custom')
      expect(s.custom).toBe(expr)
    }
  })

  it('越界的分钟/小时不误判为可视化模式', () => {
    expect(parseSchedule('99 3 * * *').mode).toBe('custom')
    expect(parseSchedule('0 25 * * *').mode).toBe('custom')
  })

  it('周日写成 7 时也归自定义（我们只生成 0，不擅自改写别人的 7）', () => {
    expect(parseSchedule('0 3 * * 7').mode).toBe('custom')
  })
})

describe('scheduleToCron：生成后端能解析的规范表达式', () => {
  const s = (patch: Partial<ScheduleView>): ScheduleView => ({ ...DEFAULT_SCHEDULE, ...patch })

  it('四种常用模式', () => {
    expect(scheduleToCron(s({ mode: 'manual' }))).toBe('')
    expect(scheduleToCron(s({ mode: 'daily', time: '03:00' }))).toBe('0 3 * * *')
    expect(scheduleToCron(s({ mode: 'weekly', time: '22:30', weekday: '0' }))).toBe('30 22 * * 0')
    expect(scheduleToCron(s({ mode: 'monthly', time: '09:05', monthday: '15' }))).toBe('5 9 15 * *')
  })

  it('自定义模式原样输出（去首尾空格）', () => {
    expect(scheduleToCron(s({ mode: 'custom', custom: '  */15 * * * *  ' }))).toBe('*/15 * * * *')
  })

  it('dom / dow 不得同时非 *（后端是 OR 语义，会变成「15号或周五」）', () => {
    for (const mode of ['daily', 'weekly', 'monthly'] as const) {
      const fields = scheduleToCron(s({ mode, time: '03:00', weekday: '5', monthday: '15' })).split(' ')
      expect(fields).toHaveLength(5)
      expect(fields[2] === '*' || fields[4] === '*').toBe(true)
    }
  })

  it('时间输入异常时保守返回空，不生成非法表达式', () => {
    expect(scheduleToCron(s({ mode: 'daily', time: '' }))).toBe('')
    expect(scheduleToCron(s({ mode: 'daily', time: '25:99' }))).toBe('')
  })

  it('解析→生成可往返，已有规范表达式不会被编辑动作改写', () => {
    for (const expr of ['0 3 * * *', '30 22 * * 1', '0 9 15 * *']) {
      expect(scheduleToCron(parseSchedule(expr))).toBe(expr)
    }
  })
})

describe('scheduleDescription：给小白看的人话摘要', () => {
  it('不出现 cron 字样', () => {
    for (const expr of ['', '0 3 * * *', '0 3 * * 1', '0 3 15 * *', '*/15 * * * *']) {
      expect(scheduleDescription(expr).toLowerCase()).not.toContain('cron')
    }
  })

  it('各模式文案', () => {
    expect(scheduleDescription('')).toBe('仅手动执行（不自动备份）')
    expect(scheduleDescription('0 3 * * *')).toBe('每天 03:00 自动备份（本地时间）')
    expect(scheduleDescription('0 3 * * 0')).toBe('每周周日 03:00 自动备份（本地时间）')
    expect(scheduleDescription('30 9 1 * *')).toBe('每月 1 日 09:30 自动备份（本地时间）')
    expect(scheduleDescription('*/15 * * * *')).toBe('按自定义规则执行：*/15 * * * *（本地时间）')
  })
})

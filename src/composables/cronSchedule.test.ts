import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CRON_SCHEDULE, parseCronSchedule, cronScheduleToCron, describeCron,
  type CronScheduleView,
} from './cronSchedule'

describe('parseCronSchedule：把表达式反推成快捷设置', () => {
  it('空表达式回到默认的可视化状态', () => {
    expect(parseCronSchedule('')).toEqual(DEFAULT_CRON_SCHEDULE)
    expect(parseCronSchedule('   ')).toEqual(DEFAULT_CRON_SCHEDULE)
  })

  it('每 N 分钟', () => {
    expect(parseCronSchedule('*/5 * * * *')).toEqual({
      ...DEFAULT_CRON_SCHEDULE, mode: 'every', every: 5,
    })
    expect(parseCronSchedule('*/30 * * * *').every).toBe(30)
  })

  it('每小时与每天', () => {
    expect(parseCronSchedule('0 * * * *').mode).toBe('hourly')
    expect(parseCronSchedule('0 3 * * *')).toEqual({
      ...DEFAULT_CRON_SCHEDULE, mode: 'daily', time: '03:00',
    })
    expect(parseCronSchedule('5 13 * * *').time).toBe('13:05')
  })

  it('每周与每月，星期编号与后端一致', () => {
    expect(parseCronSchedule('20 4 * * 1')).toEqual({
      ...DEFAULT_CRON_SCHEDULE, mode: 'weekly', time: '04:20', weekday: '1',
    })
    expect(parseCronSchedule('0 3 * * 0').weekday).toBe('0')
    expect(parseCronSchedule('0 9 15 * *')).toEqual({
      ...DEFAULT_CRON_SCHEDULE, mode: 'monthly', time: '09:00', monthday: '15',
    })
  })

  it('看不懂的表达式原样归自定义，绝不改写', () => {
    for (const expr of ['0 3 * * 1,5', '0 0 13 * 5', '0 5 31 2 *', 'bad expr']) {
      const s = parseCronSchedule(expr)
      expect(s.mode).toBe('custom')
      expect(s.custom).toBe(expr)
    }
  })

  it('越界的分钟/小时与非法间隔不误判为可视化模式', () => {
    expect(parseCronSchedule('99 3 * * *').mode).toBe('custom')
    expect(parseCronSchedule('0 25 * * *').mode).toBe('custom')
    expect(parseCronSchedule('*/0 * * * *').mode).toBe('custom')
    expect(parseCronSchedule('*/60 * * * *').mode).toBe('custom')
  })
})

describe('cronScheduleToCron：生成后端能解析的规范表达式', () => {
  const s = (patch: Partial<CronScheduleView>): CronScheduleView => ({ ...DEFAULT_CRON_SCHEDULE, ...patch })

  it('六种模式', () => {
    expect(cronScheduleToCron(s({ mode: 'every', every: 10 }))).toBe('*/10 * * * *')
    expect(cronScheduleToCron(s({ mode: 'hourly' }))).toBe('0 * * * *')
    expect(cronScheduleToCron(s({ mode: 'daily', time: '03:10' }))).toBe('10 3 * * *')
    expect(cronScheduleToCron(s({ mode: 'weekly', time: '04:20', weekday: '1' }))).toBe('20 4 * * 1')
    expect(cronScheduleToCron(s({ mode: 'monthly', time: '03:00', monthday: '1' }))).toBe('0 3 1 * *')
    expect(cronScheduleToCron(s({ mode: 'custom', custom: '  */15 * * * *  ' }))).toBe('*/15 * * * *')
  })

  it('非法中间态宁可返回空串，也不生成非法表达式', () => {
    expect(cronScheduleToCron(s({ mode: 'every', every: 0 }))).toBe('')
    expect(cronScheduleToCron(s({ mode: 'every', every: 60 }))).toBe('')
    expect(cronScheduleToCron(s({ mode: 'daily', time: '' }))).toBe('')
    expect(cronScheduleToCron(s({ mode: 'weekly', weekday: '7' }))).toBe('')
    expect(cronScheduleToCron(s({ mode: 'monthly', monthday: '32' }))).toBe('')
  })

  it('生成的表达式不会让 dom 与 dow 同时非星（后端按 OR 语义匹配）', () => {
    for (const v of [
      s({ mode: 'daily', time: '03:00' }),
      s({ mode: 'weekly', time: '03:00', weekday: '1' }),
      s({ mode: 'monthly', time: '03:00', monthday: '15' }),
    ]) {
      const fields = cronScheduleToCron(v).split(/\s+/)
      expect(fields[2] === '*' || fields[4] === '*').toBe(true)
    }
  })
})

describe('describeCron：给用户看的人话', () => {
  it('六种模式各自可读，且不出现 cron 字样', () => {
    const cases: [string, RegExp][] = [
      ['*/5 * * * *', /每 5 分钟执行一次/],
      ['0 * * * *', /每小时整点执行/],
      ['10 3 * * *', /每天 03:10 执行/],
      ['20 4 * * 1', /每周一 04:20 执行/],
      ['0 3 1 * *', /每月 1 日 03:00 执行/],
      ['0 3 * * 1,5', /按自定义规则执行：0 3 \* \* 1,5/],
    ]
    for (const [expr, re] of cases) {
      const text = describeCron(expr)
      expect(text).toMatch(re)
      expect(text).not.toMatch(/cron/i)
    }
  })

  it('空表达式不误报成自定义规则', () => {
    expect(describeCron('')).toBe('尚未设置执行时间')
  })
})

describe('往返一致性：快捷设置能接住自己生成的所有表达式', () => {
  it('六种模式生成后再解析，表达式不变', () => {
    const views: CronScheduleView[] = [
      DEFAULT_CRON_SCHEDULE,
      { ...DEFAULT_CRON_SCHEDULE, mode: 'hourly' },
      { ...DEFAULT_CRON_SCHEDULE, mode: 'every', every: 15 },
      { ...DEFAULT_CRON_SCHEDULE, mode: 'daily', time: '22:30' },
      { ...DEFAULT_CRON_SCHEDULE, mode: 'weekly', time: '22:30', weekday: '0' },
      { ...DEFAULT_CRON_SCHEDULE, mode: 'monthly', time: '09:05', monthday: '31' },
    ]
    for (const v of views) {
      const expr = cronScheduleToCron(v)
      expect(cronScheduleToCron(parseCronSchedule(expr))).toBe(expr)
    }
  })
})

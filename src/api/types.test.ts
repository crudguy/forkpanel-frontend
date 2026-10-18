import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fmtSize, fmtDateTime, fmtDate, fmtTime, fmtAgo, certLevel,
} from './types'

afterEach(() => { vi.useRealTimers() })

/**
 * 这些格式化函数被 20+ 个视图共用，且历史上出过「各写一份、档位不一致」的问题
 * （BackupsView 那份只到 MB，100GB 显示成 "102400.0 MB"）。收口到 types.ts 后，
 * 用边界值把档位与空值行为钉死。
 */
describe('fmtSize', () => {
  it('空值与非法值一律 —（不抛异常、不显示 NaN）', () => {
    expect(fmtSize(null)).toBe('—')
    expect(fmtSize(undefined)).toBe('—')
    expect(fmtSize(NaN)).toBe('—')
    expect(fmtSize(-1)).toBe('—')
    expect(fmtSize(Infinity)).toBe('—')
  })

  it('按 1024 分档；字节级不补小数，KB 起保留一位', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(1023)).toBe('1023 B')
    expect(fmtSize(1024)).toBe('1.0 KB')
    expect(fmtSize(1536)).toBe('1.5 KB')
    expect(fmtSize(1024 ** 3)).toBe('1.0 GB')
    expect(fmtSize(1024 ** 4)).toBe('1.0 TB')
    expect(fmtSize(1024 ** 5)).toBe('1.0 PB')
  })

  it('超过最高档不再进位（PB 封顶，而不是溢出成 PBPB）', () => {
    expect(fmtSize(1024 ** 6)).toBe('1024.0 PB')
  })
})

describe('fmtDateTime / fmtDate / fmtTime', () => {
  it('空值一律 —', () => {
    expect(fmtDateTime(null)).toBe('—')
    expect(fmtDateTime(undefined)).toBe('—')
    expect(fmtDateTime(0)).toBe('—')
    expect(fmtDateTime(NaN)).toBe('—')
    expect(fmtDate(null)).toBe('—')
    expect(fmtTime(null)).toBe('—')
  })

  it('三种粒度各自成形（不断言具体时刻，避免依赖时区）', () => {
    const ts = 1760700000 // 固定 Unix 秒
    expect(fmtDateTime(ts)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(fmtDate(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(fmtTime(ts)).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('fmtAgo', () => {
  it('假时钟钉住相对时间，避免依赖运行时刻造成偶发', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    const now = Math.floor(Date.now() / 1000)
    expect(fmtAgo(null)).toBe('—')
    expect(fmtAgo(now - 30)).toBe('刚刚')
    expect(fmtAgo(now - 90)).toBe('1 分钟前')
    expect(fmtAgo(now - 3600 * 3)).toBe('3 小时前')
    expect(fmtAgo(now - 86400 * 2)).toBe('2 天前')
    // 未来时间（定时任务）给绝对值，而不是难懂的「-1 小时前」
    expect(fmtAgo(now + 3600)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

/**
 * `certLevel`：证书剩余天数 → 文本着色类。CertsView 与站点编辑弹窗共用同一份，
 * 这里把档位边界钉死——否则「改了一处阈值」会表现成两个页面颜色不一致。
 */
describe('certLevel', () => {
  it('未知剩余天数（null）走中性 dim，不染绿也不染红', () => {
    expect(certLevel(null)).toBe('dim')
  })

  it('档位边界：>30 为 ok，30 起转 warn，7 起仍是 warn，<7 为 bad', () => {
    expect(certLevel(31)).toBe('ok')
    expect(certLevel(90)).toBe('ok')
    // ⚠️ 边界本身：刚好 30 天不算 ok（留一天余量给续期窗口）
    expect(certLevel(30)).toBe('warn')
    expect(certLevel(7)).toBe('warn')
    expect(certLevel(6)).toBe('bad')
    expect(certLevel(0)).toBe('bad')
    // 已过期（后端可能给负值）同样按最紧急处理，而不是落进某个中间档
    expect(certLevel(-1)).toBe('bad')
  })
})

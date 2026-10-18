import { describe, it, expect } from 'vitest'
import { siteState, tlsState, fmtApplied } from './siteState'
import type { Site } from '@/api/types'

/** 只填本模块会读的字段，其余用断言式占位避免误依赖。 */
function site(p: Partial<Site> & { enabled?: boolean; deployed?: boolean; tls?: boolean }): Site {
  return { enabled: false, deployed: false, tls: false, ...p } as unknown as Site
}

/**
 * 这两个函数决定列表里每一行的状态徽章——**判据选错就是当着用户的面撒谎**：
 * 用 `enabled`（期望状态）会把"登记了但 Web 服务器里根本没有"显示成「运行中」。
 * 这里把三态与判据钉死。
 */
describe('siteState', () => {
  it('停用优先于一切（enabled=false 时 deployed 不再参与判定）', () => {
    // ⚠ 即使 deployed 仍为 true（历史残留），停用就是停用
    expect(siteState(site({ enabled: false, deployed: true }))).toEqual({
      label: '已停用', cls: '', title: expect.stringContaining('摘除'),
    })
  })

  it('enabled 但 deployed=false 是「未下发」，不是「运行中」', () => {
    // 这条是本模块存在的核心理由：新建后 enabled 即为 true，此刻服务器里没这站点
    const b = siteState(site({ enabled: true, deployed: false }))
    expect(b.label).toBe('未下发')
    expect(b.cls).toBe('badge-warn')
    expect(b.title).toContain('尚未下发')
  })

  it('enabled + deployed 才是「运行中」', () => {
    const b = siteState(site({ enabled: true, deployed: true }))
    expect(b.label).toBe('运行中')
    expect(b.cls).toBe('badge-ok')
  })
})

describe('tlsState', () => {
  it('无证书 → 中性「无」，不染色', () => {
    expect(tlsState(site({ tls: false, deployed: true })).label).toBe('无')
    expect(tlsState(site({ tls: false, deployed: true })).cls).toBe('')
  })

  it('已签发但未下发 → 「已签发·未生效」，绝不能显示成「已启用」', () => {
    // 与站点状态同口径：只看 ssl_certs 有无记录会把"签了但没生效"说成"已配置"，
    // 与同一行「未下发」的站点状态自相矛盾。
    const b = tlsState(site({ tls: true, deployed: false }))
    expect(b.label).toBe('已签发·未生效')
    expect(b.cls).toBe('badge-warn')
    expect(b.title).toContain('尚未下发')
  })

  it('已签发且已下发 → 「已启用」', () => {
    expect(tlsState(site({ tls: true, deployed: true })).label).toBe('已启用')
    expect(tlsState(site({ tls: true, deployed: true })).cls).toBe('badge-ok')
  })
})

describe('fmtApplied', () => {
  it('null / 0 / 非法一律 —：0 是合法时间戳，绝不能显示成 1970', () => {
    // ⚠ 用 `!ts` 判空正是为了把 0 也归到「从未下发」——若改成 `ts === null` 判断，
    // 0 会被格式化成 1970-01-01，与「从未下发过」语义完全相反。
    expect(fmtApplied(null)).toBe('—')
    expect(fmtApplied(0)).toBe('—')
    expect(fmtApplied(NaN)).toBe('—')
  })

  it('紧凑格式 MM-DD HH:mm，单位数补零、不带年份', () => {
    // 固定 UTC 时刻后用本地时区反推期望值，避免测试机时区影响
    const ts = 1760750400 // 2025-10-18 04:00:00 UTC
    expect(fmtApplied(ts)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    const d = new Date(ts * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    expect(fmtApplied(ts)).toBe(`${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`)
  })
})

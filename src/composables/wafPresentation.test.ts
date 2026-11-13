import { describe, expect, it } from 'vitest'
import { wafBadge, wafCoverage, wafDetail } from './wafPresentation'
import type { Site } from '@/api/types'

type WafSite = Pick<Site, 'waf_enabled' | 'waf_profile'>
type WafDetailSite = Parameters<typeof wafDetail>[0]

const off = (profile: string | null = null): WafSite => ({ waf_enabled: false, waf_profile: profile })
const on = (profile: string | null): WafSite => ({ waf_enabled: true, waf_profile: profile })

const detail = (over: Partial<WafDetailSite> = {}): WafDetailSite => ({
  waf_enabled: false,
  waf_profile: null,
  waf_rate_per_sec: null,
  waf_burst: null,
  ip_allow: [],
  ip_deny: [],
  ...over,
})

describe('wafBadge', () => {
  it('未开启必须是警示色「未防护」，不能退化成灰色破折号或绿色已开启态', () => {
    const b = wafBadge(off())
    expect(b).toEqual({ cls: 'badge-warn', label: '未防护' })
    expect(b.cls).not.toBe('badge-ok')
    expect(b.label).not.toBe('—')
  })

  it('基础档与严格档必须分色，且文案取落库值对应的中文', () => {
    const basic = wafBadge(on('basic'))
    const strict = wafBadge(on('strict'))
    expect(basic).toEqual({ cls: 'badge-ok', label: '基础' })
    expect(strict).toEqual({ cls: '', label: '严格' })
    expect(basic.cls).not.toBe(strict.cls)
  })

  it('库中 waf_profile 为 null 时按 basic 兜底（后端关闭时清空四元组）', () => {
    expect(wafBadge(on(null))).toEqual({ cls: 'badge-ok', label: '基础' })
  })

  it('未知档位沿用 enumLabel 口径原样返回，不显示空白', () => {
    expect(wafBadge(on('custom'))).toEqual({ cls: 'badge-ok', label: 'custom' })
  })

  it('未开启时即便残留档位值也仍判为未防护', () => {
    expect(wafBadge(off('strict')).label).toBe('未防护')
    expect(wafBadge(off('strict')).cls).toBe('badge-warn')
  })
})

describe('wafDetail', () => {
  it('未开启且无名单时只给「未防护」，不虚报档位与数值', () => {
    expect(wafDetail(detail())).toBe('未防护')
  })

  it('开启时按「档位 · 限速 · 突发桶」顺序给出完整摘要', () => {
    expect(wafDetail(detail({
      waf_enabled: true, waf_profile: 'basic', waf_rate_per_sec: 20, waf_burst: 40,
    }))).toBe('基础 · 20/s · 突发 40')
  })

  it('严格档取落库值文案，null 档位按 basic 兜底', () => {
    expect(wafDetail(detail({ waf_enabled: true, waf_profile: 'strict' }))).toBe('严格')
    expect(wafDetail(detail({ waf_enabled: true, waf_profile: null }))).toBe('基础')
  })

  it('未开启时残留的限速/突发不得拼进摘要（后端关闭时清空四元组）', () => {
    expect(wafDetail(detail({ waf_rate_per_sec: 99, waf_burst: 200 }))).toBe('未防护')
  })

  it('IP 名单独立于 WAF 开关：未防护站点配了白名单仍要显示', () => {
    expect(wafDetail(detail({ ip_allow: ['1.2.3.4', '10.0.0.0/24'] })))
      .toBe('未防护 · IP 白 2')
  })

  it('白名单优先：两份名单同时存在时只列白名单（与渲染器口径一致）', () => {
    expect(wafDetail(detail({
      waf_enabled: true, waf_profile: 'basic',
      ip_allow: ['1.2.3.4'], ip_deny: ['5.6.7.8', '9.9.9.9'],
    }))).toBe('基础 · IP 白 1')
  })

  it('只有黑名单时列黑名单条数；null 名单按空数组处理', () => {
    expect(wafDetail(detail({ ip_deny: ['5.6.7.8'] }))).toBe('未防护 · IP 黑 1')
    expect(wafDetail(detail({ ip_allow: null, ip_deny: null }))).toBe('未防护')
  })

  it('限速为 0（不限速）与突发为 0（自动）不产生空片段', () => {
    expect(wafDetail(detail({
      waf_enabled: true, waf_profile: 'strict', waf_rate_per_sec: 0, waf_burst: 0,
    }))).toBe('严格')
  })
})

describe('wafCoverage', () => {
  it('混合站点的 total / on / off 自洽（与 WAF 页同一口径）', () => {
    const sites = [
      { waf_enabled: true }, { waf_enabled: false }, { waf_enabled: true },
    ]
    expect(wafCoverage(sites)).toEqual({ total: 3, on: 2, off: 1 })
  })

  it('空数组与全覆盖时 off 为 0（工具条不该出现提示）', () => {
    expect(wafCoverage([])).toEqual({ total: 0, on: 0, off: 0 })
    expect(wafCoverage([{ waf_enabled: true }, { waf_enabled: true }]))
      .toEqual({ total: 2, on: 2, off: 0 })
  })

  it('全部未开启时 off 等于 total', () => {
    expect(wafCoverage([{ waf_enabled: false }, { waf_enabled: false }]))
      .toEqual({ total: 2, on: 0, off: 2 })
  })
})

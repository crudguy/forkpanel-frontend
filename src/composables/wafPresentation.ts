import { wafProfileLabel, type Site } from '@/api/types'

/** 列表里 WAF 一列的呈现：未开启单独给警示语义，两档不再共用同一个绿徽章。 */
export interface WafBadge {
  cls: string
  label: string
}

type WafBadgeSite = Pick<Site, 'waf_enabled' | 'waf_profile'>

/**
 * 未开启 = 「未防护」+ 警示色；已开启时 basic / strict 分色，档位文案仍走
 * wafProfileLabel（键是落库值，未知值原样返回）。
 */
export function wafBadge(s: WafBadgeSite): WafBadge {
  if (!s.waf_enabled) return { cls: 'badge-warn', label: '未防护' }
  const profile = s.waf_profile ?? 'basic'
  return {
    cls: profile === 'strict' ? 'badge-primary' : 'badge-ok',
    label: wafProfileLabel(profile),
  }
}

type WafDetailSite = Pick<Site,
  'waf_enabled' | 'waf_profile' | 'waf_rate_per_sec' | 'waf_burst' | 'ip_allow' | 'ip_deny'>

/**
 * 列表单元格 title 与行展开共用的完整摘要：档位 / 限速 / 突发桶 / IP 名单数量。
 * IP 名单独立于 WAF 开关（后端 ip_allow / ip_deny 单独渲染），故未防护时同样列出。
 */
export function wafDetail(s: WafDetailSite): string {
  const parts: string[] = [s.waf_enabled ? wafProfileLabel(s.waf_profile ?? 'basic') : '未防护']
  if (s.waf_enabled && s.waf_rate_per_sec) parts.push(`${s.waf_rate_per_sec}/s`)
  if (s.waf_enabled && s.waf_burst) parts.push(`突发 ${s.waf_burst}`)
  const allow = (s.ip_allow ?? []).length
  const deny = (s.ip_deny ?? []).length
  if (allow) parts.push(`IP 白 ${allow}`)
  else if (deny) parts.push(`IP 黑 ${deny}`)
  return parts.join(' · ')
}

/** 跨站覆盖口径：WAF 页顶部卡片与站点页工具条共用同一出处，避免两处算法漂移。 */
export function wafCoverage(sites: Pick<Site, 'waf_enabled'>[]): {
  total: number
  on: number
  off: number
} {
  const on = sites.filter(s => s.waf_enabled).length
  return { total: sites.length, on, off: sites.length - on }
}

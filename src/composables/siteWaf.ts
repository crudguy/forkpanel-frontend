/**
 * 站点 WAF / IP 访问控制的纯装配逻辑（WafView.vue 用）。
 *
 * 为什么单独一个模块：这段逻辑原本写在 `WafView.vue` 的 `<script setup>` 里，而 SFC 内的
 * 函数 vitest 收不到（本项目无 vue 插件）。抽出来后，下面每条与后端约定的语义都有测试钉住，
 * 而不是只活在注释里。
 *
 * 与后端严格对齐的三条语义（改之前先看后端注释，别凭直觉）：
 *   · `waf` 缺省 = **保留库中现值**（不是关闭）→ 本页总是显式下发 `waf` 段
 *   · `rate_per_sec: 0` = 不限速；`burst` **仅在限速时才有意义** —— 不限速却带 burst
 *     会被后端 400（那属于"配了但没生效"的静默失败，后端刻意拒绝）
 *   · IP 名单提交口径：逗号分隔字符串；展示口径：逗号空格分隔
 */

import type { Site, WafTemplate } from '@/api/types'

/** 每站点一份草稿：就地编辑，点「应用」才下发。 */
export interface Draft {
  on: boolean
  profile: string
  rate: number
  burst: number
  ipAllow: string
  ipDeny: string
}

/**
 * IP 名单归一（提交口径）：逗号/空格分隔 → 逗号拼接。
 *
 * ⚠ 这是**跨页共用**的口径，别在各页另写一份：本页 `WafView.vue` 与站点表单
 * `useSiteForm.ts`（构造 ip_allow/ip_deny）必须用同一条，否则改了口径会一处改一处漏
 * ——两页提交的都是同一个后端字段，漂移的结果是有人的 IP 名单静默失效。
 */
export function normIp(v: string): string {
  return v.split(/[,\s]+/).filter(Boolean).join(',')
}

/** IP 名单展示（展示口径）：数组 → 逗号空格拼接，给用户看与编辑用的。 */
export function showIps(list: readonly string[]): string {
  return list.join(', ')
}

/** 站点现值 → 草稿。每次加载都重置，避免留下上次未应用的脏值。 */
export function toDraft(s: Site): Draft {
  return {
    on: s.waf_enabled,
    profile: s.waf_profile ?? 'basic',
    rate: s.waf_rate_per_sec ?? 0,
    burst: s.waf_burst ?? 0,
    ipAllow: showIps(s.ip_allow ?? []),
    ipDeny: showIps(s.ip_deny ?? []),
  }
}

/**
 * 草稿是否有未应用的改动。
 *
 * 两条易漏的语义，都靠测试钉住：
 *  1. IP 名单比较前先**归一**：用户把 "1.2.3.4, 5.6.7.8" 改成 "1.2.3.4 5.6.7.8"
 *     不算改动（提交口径相同），否则「应用」按钮会为一个无意义的差异而亮起。
 *  2. **关闭时不比较 profile/rate/burst**：WAF 关着的话这些值不会下发，拿它们判脏
 *     会让按钮永远亮着、点了却什么也没改（"改了但没生效"）。
 */
export function draftDirty(s: Site, d: Draft | undefined): boolean {
  if (!d) return false
  if (d.on !== s.waf_enabled) return true
  if (normIp(d.ipAllow) !== (s.ip_allow ?? []).join(',')) return true
  if (normIp(d.ipDeny) !== (s.ip_deny ?? []).join(',')) return true
  return d.on && (d.profile !== (s.waf_profile ?? 'basic')
    || d.rate !== (s.waf_rate_per_sec ?? 0)
    || d.burst !== (s.waf_burst ?? 0))
}

/**
 * apply 体的公共字段——**逐站应用与模板套用共用**。
 *
 * ⚠️ 抽成函数而不是各写一份的实打实理由：apply 是「期望状态」**覆盖**，
 * 漏传 upstreams / fpm 会把反代 / PHP 站的后端地址**清空**（站点直接 502）。
 * 两条路径共用同一出处才不会漏配。
 * `root` 是后端必填 String（非 Option），恒有值；不兜底成站点名（那会静默改根目录）。
 */
export function siteBase(s: Site) {
  return {
    name: s.name,
    domains: s.domains,
    root: s.root,
    force_https: true,
    kind: s.kind,
    upstreams: s.kind === 'proxy' ? (s.upstreams ?? []) : undefined,
    fpm: s.kind === 'php' ? (s.fpm ?? '') : undefined,
  }
}

/**
 * 草稿 → `waf` 段。
 * 关闭时只发 `{ enabled: false }`（其余字段对关闭态无意义，且省得后端收到矛盾值）。
 * `burst` 仅在限速时下发：不限速却带 burst 会被后端 400。
 */
export function draftWafSeg(d: Draft) {
  if (!d.on) return { enabled: false }
  return {
    enabled: true,
    profile: d.profile,
    rate_per_sec: d.rate,
    ...(d.rate > 0 && d.burst > 0 ? { burst: d.burst } : {}),
  }
}

/** 模板 → `waf` 段。套用即**强制开启**并把该站设成模板值。`rate` 空值当 0。 */
export function templateWafSeg(t: WafTemplate) {
  const rate = t.rate_per_sec || 0
  return {
    enabled: true,
    profile: t.waf_profile,
    rate_per_sec: rate,
    ...(rate > 0 && t.burst > 0 ? { burst: t.burst } : {}),
  }
}

/** 逐站「应用」体：站点自身草稿的 waf + ip。 */
export function applyBody(s: Site, d: Draft) {
  return {
    ...siteBase(s),
    waf: draftWafSeg(d),
    ip_allow: normIp(d.ipAllow),
    ip_deny: normIp(d.ipDeny),
  }
}

/** 模板「套用」体：模板的 waf + ip（模板已存为数组，直接逗号拼接，不再归一）。 */
export function applyTemplateBody(s: Site, t: WafTemplate) {
  return {
    ...siteBase(s),
    waf: templateWafSeg(t),
    ip_allow: (t.ip_allow ?? []).join(','),
    ip_deny: (t.ip_deny ?? []).join(','),
  }
}

/** 站点类型标签（未知一律按静态，不回退成空串让人以为取不到值）。 */
export function kindLabel(k: string): string {
  if (k === 'proxy') return '反代'
  if (k === 'php') return 'PHP'
  return '静态'
}

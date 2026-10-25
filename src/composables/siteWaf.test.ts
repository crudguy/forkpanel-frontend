import { describe, it, expect } from 'vitest'
import {
  normIp,
  showIps,
  toDraft,
  draftDirty,
  siteBase,
  draftWafSeg,
  templateWafSeg,
  applyBody,
  applyTemplateBody,
  kindLabel,
  type Draft,
} from './siteWaf'
import type { Site, WafTemplate } from '@/api/types'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 前端 src 根（本文件在 src/composables/ 下）。 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url))

/**
 * 剔掉注释后再扫——否则注释里举的反例（`split(/[,\s]+/)...`）会被守卫自己扫到，
 * 于是这条守卫变成恒红的噪音（门禁被自己的注释绊倒，同类坑见后端源码守卫）。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l })
    .join('\n')
}

function scanSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (extname(e.name) === '.ts' || extname(e.name) === '.vue') out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * 内联的 IP 归一表达式：`.split(/[,\s]+/).filter(Boolean).join(',')`
 *
 * ⚠ 源码里 `[,\s]` 是**字面的反斜杠 + s 两个字符**，正则里必须写成 `\\s`；
 * 写成 `\s` 就成了「空白字符类」，一条也匹配不上 —— 这个错误正是被下面
 * "定义处恰好一处"那条断言当场抓住的（否则守卫会静默空转，还显得很绿）。
 */
const INLINE_IP = /\.split\(\/\[,\\s\]\+\/\)\.filter\(Boolean\)\.join\(','\)/

function collectInlineIps(root: string): string[] {
  const hits: string[] = []
  for (const f of scanSourceFiles(root)) {
    stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      if (INLINE_IP.test(line)) hits.push(`${relative(root, f)}:${i + 1}`)
    })
  }
  return hits
}

/**
 * 夹具只填被测字段（Site 有三十多个字段，全填只会淹没意图）。
 * 字段**值**保持生产形态：`ip_allow` 真可为 null、`waf_rate_per_sec` 真可为 null。
 */
const site = (p: Partial<Site> = {}): Site =>
  ({
    id: 1,
    name: 'a.com',
    domains: ['a.com'],
    root: '/var/www/a',
    kind: 'static',
    enabled: true,
    waf_enabled: false,
    waf_profile: 'basic',
    waf_rate_per_sec: 0,
    waf_burst: 0,
    upstreams: null,
    fpm: null,
    ip_allow: null,
    ip_deny: null,
    ...p,
  }) as Site

const draft = (p: Partial<Draft> = {}): Draft => ({
  on: true,
  profile: 'basic',
  rate: 0,
  burst: 0,
  ipAllow: '',
  ipDeny: '',
  ...p,
})

const tpl = (p: Partial<WafTemplate> = {}): WafTemplate => ({
  id: 1,
  name: '标准防护',
  waf_profile: 'basic',
  rate_per_sec: 0,
  burst: 0,
  ip_allow: [],
  ip_deny: [],
  created_at: 0,
  updated_at: 0,
  ...p,
})

describe('normIp：IP 名单提交口径（逗号拼接）', () => {
  it('逗号分隔原样归一', () => {
    expect(normIp('1.2.3.4,5.6.7.8')).toBe('1.2.3.4,5.6.7.8')
  })

  it('空格分隔转成逗号', () => {
    expect(normIp('1.2.3.4 5.6.7.8')).toBe('1.2.3.4,5.6.7.8')
  })

  it('逗号空格混排也归一（用户在编辑器里随手换行/加空格）', () => {
    expect(normIp('1.2.3.4, 5.6.7.8  9.9.9.9')).toBe('1.2.3.4,5.6.7.8,9.9.9.9')
  })

  it('★ 首尾与连续空白不产生空项', () => {
    // 反例：不 filter(Boolean) 的话前端会提交 ",1.2.3.4,"，后端解析出一个空 IP。
    expect(normIp('  1.2.3.4  ')).toBe('1.2.3.4')
    expect(normIp('')).toBe('')
  })
})

describe('showIps：展示口径（逗号空格）', () => {
  it('数组 → 逗号空格拼接', () => {
    expect(showIps(['1.2.3.4', '5.6.7.8'])).toBe('1.2.3.4, 5.6.7.8')
  })

  it('空数组 → 空串（不渲染 n/a 之类的占位）', () => {
    expect(showIps([])).toBe('')
  })
})

describe('toDraft：站点现值 → 草稿', () => {
  it('null 字段落到类型默认值（不是 undefined）', () => {
    expect(toDraft(site({ waf_profile: null, waf_rate_per_sec: null, waf_burst: null }))).toEqual({
      on: false,
      profile: 'basic',
      rate: 0,
      burst: 0,
      ipAllow: '',
      ipDeny: '',
    })
  })

  it('IP 名单按展示口径展开', () => {
    const d = toDraft(site({ ip_allow: ['1.2.3.4', '5.6.7.8'], ip_deny: null }))
    expect(d.ipAllow).toBe('1.2.3.4, 5.6.7.8')
    expect(d.ipDeny).toBe('')
  })

  it('★ 现值与草稿回环一致（toDraft 出来的草稿不该被判脏）', () => {
    const s = site({ waf_enabled: true, waf_rate_per_sec: 50, waf_burst: 100,
      ip_allow: ['1.2.3.4'], ip_deny: ['8.8.8.8'] })
    expect(draftDirty(s, toDraft(s))).toBe(false)
  })
})

describe('draftDirty：是否有未应用的改动', () => {
  it('逐项改动都能判脏', () => {
    const base = site({ waf_enabled: true, waf_profile: 'basic', waf_rate_per_sec: 10, waf_burst: 20 })
    expect(draftDirty(base, draft({ profile: 'strict' }))).toBe(true)
    expect(draftDirty(base, draft({ rate: 30 }))).toBe(true)
    expect(draftDirty(base, draft({ burst: 40 }))).toBe(true)
    expect(draftDirty(base, draft({ on: false }))).toBe(true)
  })

  it('★ IP 只换了分隔符不算改动（先归一再比）', () => {
    // 反例：直接比字符串，"1.2.3.4, 5.6.7.8" 与 "1.2.3.4 5.6.7.8" 会被当成改动，
    // 「应用」按钮为一个提交时完全等价的差异而亮起。
    // 夹具必须让**开关一致**（site 默认 waf_enabled:false、draft 默认 on:true，
    // 否则开关本身就判脏，IP 那条断言会被它盖住 —— 包括本该为 true 的那条也假绿）
    const s = site({ waf_enabled: true, ip_allow: ['1.2.3.4', '5.6.7.8'] })
    expect(draftDirty(s, draft({ ipAllow: '1.2.3.4 5.6.7.8' }))).toBe(false)
    expect(draftDirty(s, draft({ ipAllow: '1.2.3.4,5.6.7.8' }))).toBe(false)
    expect(draftDirty(s, draft({ ipAllow: '1.2.3.4' }))).toBe(true)
    const s2 = site({ waf_enabled: true })
    expect(draftDirty(s2, draft({ ipDeny: '8.8.8.8,  9.9.9.9' }))).toBe(true)
  })

  it('★ 关闭时不比较 profile/rate/burst（关着的话这些值不会下发）', () => {
    // 反例：漏掉 `d.on &&` 的话，WAF 开着改成关着之后，用户怎么拨 profile 按钮都亮着，
    // 点了却什么也没改 —— 典型的"能点但没生效"。
    const off = site({ waf_enabled: false, waf_profile: 'basic', waf_rate_per_sec: 0 })
    const d = draft({ on: false, profile: 'strict', rate: 999, burst: 999 })
    expect(draftDirty(off, d)).toBe(false)
  })

  it('★ 关闭时 IP 改动仍然要算（IP 名单与 WAF 开关是两件事）', () => {
    const off = site({ waf_enabled: false })
    expect(draftDirty(off, draft({ on: false, ipAllow: '1.2.3.4' }))).toBe(true)
  })

  it('waf_profile 库值为 null 时草稿 basic 不算改动', () => {
    expect(draftDirty(site({ waf_profile: null, waf_enabled: true }), draft({ profile: 'basic' })))
      .toBe(false)
  })

  it('★ 草稿缺失（未加载/站点刚被删）判为不脏，不拿 undefined 去取属性', () => {
    expect(draftDirty(site(), undefined)).toBe(false)
  })
})

describe('siteBase：apply 体公共字段（漏传会清空反代/PHP 后端）', () => {
  it('★ static 不带上反代与 PHP 字段', () => {
    const b = siteBase(site({ kind: 'static' }))
    expect(b.upstreams).toBeUndefined()
    expect(b.fpm).toBeUndefined()
  })

  it('★ proxy 必须带上 upstreams（漏了会把反代后端清空 → 站点 502）', () => {
    const b = siteBase(site({ kind: 'proxy', upstreams: ['127.0.0.1:3000'] }))
    expect(b.upstreams).toEqual(['127.0.0.1:3000'])
    expect(b.fpm).toBeUndefined()
  })

  it('★ php 必须带上 fpm（漏了会把 PHP 后端清空）', () => {
    const b = siteBase(site({ kind: 'php', fpm: 'unix:/run/php/php8.4-fpm.sock' }))
    expect(b.fpm).toBe('unix:/run/php/php8.4-fpm.sock')
    expect(b.upstreams).toBeUndefined()
  })

  it('proxy 的 upstreams 库值为 null 时落空数组（不传 null 给后端）', () => {
    expect(siteBase(site({ kind: 'proxy', upstreams: null })).upstreams).toEqual([])
  })

  it('★ force_https 恒为 true（本页不做 HTTPS 开关，只下发 WAF）', () => {
    expect(siteBase(site()).force_https).toBe(true)
  })

  it('name/domains/root/kind 原样透传', () => {
    const b = siteBase(site({ name: 'x.com', domains: ['x.com', 'www.x.com'], root: '/srv/x', kind: 'proxy' }))
    expect(b).toMatchObject({ name: 'x.com', domains: ['x.com', 'www.x.com'], root: '/srv/x', kind: 'proxy' })
  })
})

describe('draftWafSeg：草稿 → waf 段', () => {
  it('关闭时只发 enabled:false，不带其余字段', () => {
    expect(draftWafSeg(draft({ on: false, profile: 'strict', rate: 10, burst: 20 })))
      .toEqual({ enabled: false })
  })

  it('★ 不限速（rate=0）时不下发 burst，即使 burst 有值', () => {
    // 反例：不限速却带 burst 会被后端 400（那属于"配了但没生效"，后端刻意拒绝）。
    expect(draftWafSeg(draft({ rate: 0, burst: 20 }))).toEqual({
      enabled: true, profile: 'basic', rate_per_sec: 0,
    })
  })

  it('★ 限速且 burst>0 时下发 burst', () => {
    expect(draftWafSeg(draft({ rate: 50, burst: 100 }))).toEqual({
      enabled: true, profile: 'basic', rate_per_sec: 50, burst: 100,
    })
  })

  it('限速但 burst=0 时不发 burst（交后端按 rate×2 算）', () => {
    expect(draftWafSeg(draft({ rate: 50, burst: 0 }))).toEqual({
      enabled: true, profile: 'basic', rate_per_sec: 50,
    })
  })
})

describe('templateWafSeg：模板 → waf 段（套用即强制开启）', () => {
  it('恒为 enabled:true（套用就是"把该站设成模板值"）', () => {
    expect(templateWafSeg(tpl({ waf_profile: 'strict', rate_per_sec: 10, burst: 20 }))).toEqual({
      enabled: true, profile: 'strict', rate_per_sec: 10, burst: 20,
    })
  })

  it('★ 不限速时不发 burst', () => {
    expect(templateWafSeg(tpl({ rate_per_sec: 0, burst: 30 }))).toEqual({
      enabled: true, profile: 'basic', rate_per_sec: 0,
    })
  })
})

describe('applyBody / applyTemplateBody：两条路径共用 siteBase', () => {
  it('★ 逐站应用：IP 走提交口径（逗号拼接）', () => {
    const body = applyBody(site({ kind: 'proxy', upstreams: ['127.0.0.1:3000'] }),
      draft({ ipAllow: '1.2.3.4 5.6.7.8', ipDeny: '8.8.8.8, 9.9.9.9' }))
    expect(body.ip_allow).toBe('1.2.3.4,5.6.7.8')
    expect(body.ip_deny).toBe('8.8.8.8,9.9.9.9')
    // 模板路径会漏的正是这个字段：两条路径都出自 siteBase 才不会漏配
    expect(body.upstreams).toEqual(['127.0.0.1:3000'])
  })

  it('★ 模板套用同样带上 upstreams / fpm（不被漏配清空）', () => {
    const body = applyTemplateBody(site({ kind: 'php', fpm: 'unix:/run/php/php8.4-fpm.sock' }),
      tpl({ ip_allow: ['1.2.3.4'], ip_deny: [] }))
    expect(body.fpm).toBe('unix:/run/php/php8.4-fpm.sock')
    expect(body.ip_allow).toBe('1.2.3.4')
    expect(body.ip_deny).toBe('')
  })

  it('两条路径对同一站点给出的 base 完全一致', () => {
    const s = site({ kind: 'proxy', upstreams: ['127.0.0.1:3000'] })
    const a = applyBody(s, draft())
    const b = applyTemplateBody(s, tpl())
    expect(a.name).toBe(b.name)
    expect(a.root).toBe(b.root)
    expect(a.upstreams).toEqual(b.upstreams)
  })
})

describe('kindLabel', () => {
  it('三种已知类型', () => {
    expect(kindLabel('proxy')).toBe('反代')
    expect(kindLabel('php')).toBe('PHP')
    expect(kindLabel('static')).toBe('静态')
  })

  it('★ 未知类型按静态（不回退成空串让人以为取不到值）', () => {
    expect(kindLabel('routed')).toBe('静态')
    expect(kindLabel('')).toBe('静态')
  })
})

describe('单一事实源守卫：IP 提交口径不得有第二份实现', () => {
  // 抽公共函数只完成一半——没人盯着的话，下一个需要 IP 归一的页面会顺手内联一段
  // `split(/[,\s]+/).filter(Boolean).join(',')`，于是又变成两份。到那时改口径
  // （比如要支持 IPv6 的冒号）必然只改一处，另一页的 IP 名单静默失效。
  // 这类「同一约束落在两处」的漂移，只能靠扫全源码来钉（单测测不到别的文件的写法）。
  it('★ 除定义处外，src/ 下不得再出现内联的 IP 归一表达式', () => {
    const hits = collectInlineIps(SRC)
    expect(hits.filter(h => !h.startsWith('composables/siteWaf.ts'))).toEqual([])
  })

  it('★ 定义处恰好一处（连它一起删了也要红，否则守卫会空转）', () => {
    const hits = collectInlineIps(SRC).filter(h => h.startsWith('composables/siteWaf.ts'))
    expect(hits.length).toBe(1)
  })

  it('活性自检：守卫扫过足够多的文件（扫不到东西＝没在守）', () => {
    expect(scanSourceFiles(SRC).length).toBeGreaterThan(50)
  })
})

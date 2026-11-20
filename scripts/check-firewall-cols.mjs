#!/usr/bin/env node
// 防火墙规则表列宽守卫（2026-11-20 反馈修复）。
//
// 为什么需要：原先 8 列用百分比，真机量测出现两个相反方向的错位——
//   1440 视口：来源列 360px、备注列 184px 全是空白（弹性列吸走全部余量）；
//   1024 视口：动作列被压到 59.5px，「拒绝并回复」徽章被截断（trunc=true）。
// 根因是百分比把「来源 auto」之外的列也按容器缩放，既浪费宽屏又挤爆窄屏。
// 正解＝分两档：中小屏固定列 px + 来源唯一弹性列；宽屏 8 列全定宽（余量等比
// 分给每列，避免来源独吞 1920 下 1004px 的空白）。tsc/build/单测/既有 UI
// 守卫都看不见列宽，只有源码契约 + 真机量测守得住，故配此守卫。
//
// 判据指向被检查的 FirewallView.vue scoped 样式，并用好/坏样本自检解析链路：
// 正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'src/views/FirewallView.vue')
/** 基础档 7 条固定列 + 来源 auto；宽屏档 8 列全定宽（总和 <=1150 不横滚） */
const BASE = {
  'w-fwport': 96, 'w-fwproto': 72, 'w-fwact': 76, 'w-fwdir': 68,
  'w-fwcmt': 120, 'w-fwown': 104, 'w-fwacts': 100,
}
const WIDE = {
  'w-fwport': 120, 'w-fwproto': 96, 'w-fwact': 96, 'w-fwdir': 88,
  'w-fwsrc': 320, 'w-fwcmt': 180, 'w-fwown': 120, 'w-fwacts': 100,
}
const EXPECT = ['w-fwport', 'w-fwproto', 'w-fwact', 'w-fwdir', 'w-fwsrc', 'w-fwcmt', 'w-fwown', 'w-fwacts']

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}
function styleText(s) {
  return [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }))
}
/**
 * 按 @media (min-width:1440px) 边界切两段，各自取 8 列宽度映射。
 * 媒体块内是宽屏档，块外是基础档；任一段缺列即返回 null。
 */
function splitWidths(rawCss) {
  const css = stripComments(rawCss)
  const at = css.indexOf('@media (min-width: 1440px)')
  if (at < 0) return null
  const head = css.slice(0, at)
  // 媒体块：从 @media 起到其配对 }（本样式表里它是文件末尾的块，取到末尾即可）
  const tail = css.slice(at + '@media (min-width: 1440px)'.length).replace(/^\s*\{/, '')
  function collect(seg) {
    const out = {}
    for (const r of rules(seg)) {
      const m = /\bcol\.(w-fw[a-z]+)\b/.exec(r.sel)
      if (!m) continue
      const w = /width\s*:\s*([^;]+)\s*;?/.exec(r.body)
      if (w) out[m[1]] = w[1].trim()
    }
    return EXPECT.every((k) => k in out) ? out : null
  }
  return { base: collect(head), wide: collect(tail), orderOk: at >= 0 }
}
/** 单段（无媒体块）取宽度——给自检样本用 */
function oneSegment(rawCss) {
  const css = stripComments(rawCss)
  const out = {}
  for (const r of rules(css)) {
    const m = /\bcol\.(w-fw[a-z]+)\b/.exec(r.sel)
    if (!m) continue
    const w = /width\s*:\s*([^;]+)\s*;?/.exec(r.body)
    if (w) out[m[1]] = w[1].trim()
  }
  return EXPECT.every((k) => k in out) ? out : null
}
function matchMap(got, expect, label) {
  const wrong = Object.entries(expect).filter(([k, v]) => got[k] !== `${v}px`)
  check(wrong.length === 0,
    `${label} 精确 px（不符：${wrong.map(([k]) => k).join(',') || '无'}）`)
}

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ ${label}`); failed = true }
}

console.log('== 防火墙规则表列宽守卫 ==')

// ── 解析链路自检（好样本两档，坏样本用旧百分比语义）──
const GOOD_BASE = EXPECT.map((k) => `col.${k} { width: ${k === 'w-fwsrc' ? 'auto' : BASE[k] + 'px'}; }`).join('\n')
const GOOD_WIDE = EXPECT.map((k) => `col.${k} { width: ${WIDE[k]}px; }`).join('\n')
const BAD_PERCENT = `col.w-fwport { width: 10%; }\ncol.w-fwproto { width: 8%; }\ncol.w-fwact { width: 8%; }\ncol.w-fwdir { width: 7%; }\ncol.w-fwsrc { width: auto; }\ncol.w-fwcmt { width: 16%; }\ncol.w-fwown { width: 11%; }\ncol.w-fwacts { width: 100px; }`

check(!!oneSegment(GOOD_BASE), '[1] 基础档 8 条列宽好样本能被解析检出')
check(oneSegment(GOOD_BASE)?.['w-fwsrc'] === 'auto', '[2] 基础档来源列 auto 能被检出')
check(Object.values(oneSegment(BAD_PERCENT) || {}).some((w) => w.includes('%')), '[3] 百分比列宽坏样本能被识别')
check(oneSegment('/* col.w-fwport { width: 96px; } */') === null, '[4] 注释里的列宽不参与判定')
check(oneSegment('col.w-fwport { width: 96px; }') === null, '[5] 列宽缺项（只 1/8）不能算通过')
check(!!splitWidths(GOOD_BASE + '\n@media (min-width: 1440px) {\n' + GOOD_WIDE + '\n}'),
  '[6] 基础档 + 宽屏档切片能被解析检出')

// ── 真实文件 ──
const raw = readFileSync(FILE, 'utf8')
const split = splitWidths(styleText(stripComments(raw)))
check(!!split?.base && !!split?.wide, '[7] FirewallView 两档各 8 条列宽定义齐全')
if (split?.base && split?.wide) {
  check(split.base['w-fwsrc'] === 'auto', '[8] 基础档来源列是唯一弹性列（width:auto）')
  matchMap(split.base, BASE, '[9] 基础档 7 条固定列')
  matchMap(split.wide, WIDE, '[10] 宽屏档 8 列')
  const pct = [...Object.entries(split.base), ...Object.entries(split.wide)].filter(([, w]) => w.includes('%'))
  check(pct.length === 0, `[11] 两档均无百分比列宽（残留：${pct.map(([k]) => k).join(',') || '无'}）`)
  const baseSum = Object.values(BASE).reduce((a, v) => a + v, 0)
  const wideSum = Object.values(WIDE).reduce((a, v) => a + v, 0)
  check(baseSum >= 600 && baseSum <= 700, `[12] 基础档固定列总和 ${baseSum}px 落在 [600,700]`)
  check(wideSum <= 1150, `[13] 宽屏档列总和 ${wideSum}px <= 1440 视口表宽 1150px（不横滚）`)
}

if (failed) process.exit(1)
console.log('PASS：防火墙规则表列宽契约通过')

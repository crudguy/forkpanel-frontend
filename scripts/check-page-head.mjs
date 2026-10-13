#!/usr/bin/env node
/**
 * 页面头部的结构性守卫：主操作唯一 + 页内不重渲染标题。
 * 用法：`pnpm check:ui`（与 check-sidenav.mjs 串联）；退出码非 0 即有违规。
 *
 * 为什么需要一道纯文本检查：`btn-primary` 是橙色渐变 + 外发光，一页的
 * `.page-head` 里出现两个就是两块发光并排——主次被拉平，用户看不出该点哪个
 * （站点页曾把「刷新」与「新建站点」都写成 btn-primary）。这纯粹是模板层的
 * 视觉层级问题：`vue-tsc` 看不见、`vite build` 照常成功、页面照常渲染，
 * 所以只能显式断言。
 *
 * 断言口径（刻意收窄，避免误报）：
 *   [1] 至少要扫描到 N 个视图、且 page-head 与 sec-head **两类块各自**都真的被
 *       **抠出来过**——某一类抠不到就必须失败。否则目录改名/模板改写法都会让
 *       下面那条对那一类恒绿。
 *   [2] 每个 page-head / sec-head 块内 btn-primary 出现次数 ≤ 1。
 *   [3] 页内**不得**再渲染页面标题（`h2.page-title`）：页面标题由顶栏 h1 按
 *       route.meta.title 单独渲染，页内再来一份就是「同值、同屏、手写副本」。
 *       禁止类断言天生有恒绿风险，所以先用探针串自校验正则本身（[3a] 会红）。
 *
 * 为什么 sec-head 也算「页面头部」：主操作不一定挂在页面最上面那行。站点页就把
 * 「新建站点」收进了「站点」列表的区块头（紧贴它操作的表格）。约束若只认
 * page-head，主操作一搬家就没人看着了。
 *
 * 为什么只数 btn-primary：`.btn-ghost`（工具动作）、`.btn-danger`（危险动作）、
 * `.btn-sm`（表格内小按钮）都按语义着色，不限个数——FilesView 的头部一列四个
 * ghost 就是正确写法。只有"橙色实心 CTA"才代表主操作。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 可传入目录覆盖（负向验证用：拿一份故意改坏的副本跑，确认守卫真的会红）
const DIR = process.argv[2] ? process.argv[2] : join(root, 'src/views')

const failures = []
function fail(id, msg) {
  console.log(`  ✗ [${id}] ${msg}`)
  failures.push(id)
}
function pass(id, msg) {
  console.log(`  ✓ [${id}] ${msg}`)
}

console.log(`（检查 ${DIR}）`)
console.log('== 页面头部主操作守卫 ==')

// 目录不存在必须立刻失败，不能静默扫 0 个文件后报 PASS
let files
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.vue'))
} catch (e) {
  fail('0a', `视图目录不可读：${DIR}（${e.code ?? e.message}）`)
  console.log(`\nFAIL：无法完成扫描（0a）`)
  process.exit(1)
}
if (!files.length) {
  fail('0b', `视图目录里没有 .vue：${DIR}——路径写错时这道守卫会恒绿`)
  console.log(`\nFAIL：未扫描到任何视图（0b）`)
  process.exit(1)
}

/** 把所有 HTML 注释整段替换成等长空格，保证索引不偏移（注释里可能含 <div）。 */
const blankComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))

/** 从 `<div` 的起始下标开始做深度配对，返回整个元素文本。 */
function elementAt(src, startIdx) {
  const re = /<div\b|<\/div\s*>/g
  re.lastIndex = startIdx
  let depth = 0
  let m
  while ((m = re.exec(src))) {
    if (m[0] === '</div>') {
      depth -= 1
      if (depth === 0) return src.slice(startIdx, m.index + m[0].length)
    } else {
      depth += 1
    }
  }
  return null
}

/** 施加「至多一个橙色主操作」约束的块。
 *  sec-head 必须一起扫：站点页已把主操作从 page-head 搬到列表区块头（「站点」右侧），
 *  只盯 page-head 会留下盲区——主操作换了位置，约束却还看着旧位置。
 *  用 `<div … class="… x …">` 的宽松匹配（属性顺序、`class="sec-head block"` 这类
 *  多 class 都要覆盖），否则改个写法这条就静默失效。 */
const HEAD_MARKERS = [
  { label: 'page-head', re: /<div\b[^>]*\bclass="[^"]*\bpage-head\b[^"]*"[^>]*>/g },
  { label: 'sec-head', re: /<div\b[^>]*\bclass="[^"]*\bsec-head\b[^"]*"[^>]*>/g },
]

const offenders = []
const scanned = []
for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8')
  const src = blankComments(raw)
  const counts = {}
  for (const mk of HEAD_MARKERS) {
    counts[mk.label] = 0
    mk.re.lastIndex = 0
    let mm
    while ((mm = mk.re.exec(src))) {
      const block = elementAt(src, mm.index)
      if (!block) break
      counts[mk.label] += 1
      const n = (block.match(/btn-primary/g) ?? []).length
      if (n > 1) {
        // 只取"开标签里带 btn-primary"的 <button>，再剥标签留文案，用于定位：
        const names = [...block.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)]
          .filter((b) => /btn-primary/.test(b[0].slice(0, b[0].indexOf('>'))))
          .map((b) => b[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
        offenders.push(`${f} [${mk.label}]: ${n} 个 btn-primary${names.length ? `（${names.join(' / ')}）` : ''}`)
      }
      mk.re.lastIndex = mm.index + block.length
    }
  }
  scanned.push([f, counts])
}

// 每类块都必须真的被抠出来过：某一类改了写法后 total=0，那道约束就会恒绿
for (const mk of HEAD_MARKERS) {
  const withIt = scanned.filter(([, c]) => c[mk.label] > 0)
  const total = withIt.reduce((a, [, c]) => a + c[mk.label], 0)
  if (!total) {
    fail('1', `扫过 ${files.length} 个视图，但一个 ${mk.label} 都没抠出来——模板写法变了，下面的检查会恒绿`)
  } else {
    pass('1', `扫过 ${files.length} 个视图，从 ${withIt.length} 个中抠出 ${total} 个 ${mk.label} 块`)
  }
}

if (offenders.length) {
  fail('2', `每个 page-head / sec-head 至多一个橙色主操作，违规 ${offenders.length} 处：\n      - ${offenders.join('\n      - ')}`)
} else {
  pass('2', '每个 page-head / sec-head 的 btn-primary 均 ≤ 1（工具动作请用 btn-ghost）')
}

// [3] 页内不得再渲染页面标题：顶栏 h1 已按 route.meta.title 渲染，页内再写一份
// 就是「同值、同屏、手写副本」（13 处 h2.page-title 已于 2026-10-13 全量移除）。
// 禁止类断言最怕恒绿，所以先用探针自校验正则本身还能命中，再谈扫描结果。
const TITLE_RE = /<h2\b[^>]*\bclass="[^"]*\bpage-title\b[^"]*"[^>]*>/
const titleDups = files.filter((f) => TITLE_RE.test(blankComments(readFileSync(join(DIR, f), 'utf8'))))
if (!TITLE_RE.test('<h2 class="page-title">探针</h2>')) {
  fail('3a', '「禁止页内标题」的正则自身已失效——这条会恒绿，必须修')
} else if (titleDups.length) {
  fail('3', `页内不得重渲染页面标题（顶栏 h1 已渲染），残留 ${titleDups.length} 处：${titleDups.join('、')}`)
} else {
  pass('3', `扫过 ${files.length} 个视图，页内无 page-title 标题残留（正则自校验通过）`)
}

if (failures.length) {
  console.log(`\nFAIL：页面头部不变量有 ${failures.length} 条违规（${failures.join(', ')}）`)
  process.exit(1)
}
console.log('\nPASS：页面头部不变量全部满足')

#!/usr/bin/env node
// 守卫：不许出现「没写理由的静默 catch」。
//
// 为什么：静默吞错只在两种情况下成立——① 失败对用户无副作用（写 localStorage
// 失败、忽略 SSE 坏帧）；② 原因已由别处呈现（逐条失败已汇总成 toast）。其余情况
// 吞掉根因的代价是「界面看起来正常但功能全关，而控制台一片安静」，排查只能读源码
// （案例：登录后 /system/capabilities 失败 ⇒ 能力位全空 ⇒ 全站菜单置灰，此前无痕）。
//
// 判据不是「禁止静默」——本项目 30+ 处静默是刻意的。判据是**静默必须自证理由**：
// catch 块剥掉注释后为空时，块内（或 catch 上一行）必须写着为什么可以静默。
//
// 只判形态，不判理由是否成立（机器判不了）。所以配套一条硬要求写在 CLAUDE/评审
// 清单里：新增静默 catch 时，注释要写「静默之后用户看到什么 + 为什么这没关系」。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if ((e.name.endsWith('.ts') || e.name.endsWith('.vue')) && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** 逐字符剥注释，同时保留字符串/模板串原文（避免把 URL 里的 // 当注释）。 */
function stripComments(s) {
  const out = []
  let i = 0
  let state = null // null | 'line' | 'block' | 引号字符
  while (i < s.length) {
    const c = s[i]
    if (state === null) {
      if (s.startsWith('//', i)) { state = 'line'; i += 2; out.push(' '); continue }
      if (s.startsWith('/*', i)) { state = 'block'; i += 2; out.push(' '); continue }
      if (c === "'" || c === '"' || c === '`') { state = c; out.push(c); i += 1; continue }
      out.push(c); i += 1
    } else if (state === 'line') {
      if (c === '\n') { state = null; out.push(c) } else out.push(' ')
      i += 1
    } else if (state === 'block') {
      if (s.startsWith('*/', i)) { state = null; i += 2 } else { out.push(c === '\n' ? '\n' : ' '); i += 1 }
    } else {
      out.push(c)
      if (c === '\\') { if (i + 1 < s.length) { out.push(s[i + 1]); i += 2; continue } }
      if (c === state) state = null
      i += 1
    }
  }
  return out.join('')
}

const files = walk(SRC).map((p) => relative(ROOT, p))

const violations = []
const silent = []

for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  for (const m of src.matchAll(/\bcatch\b/g)) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 200)
    const head = /^\s*(?:\([^)]*\))?\s*\{/.exec(rest)
    if (!head) continue // `catch` 出现在字符串/注释里，或不是语句块
    const open = m.index + m[0].length + head[0].length - 1
    let depth = 0
    let close = open
    for (; close < src.length; close += 1) {
      if (src[close] === '{') depth += 1
      else if (src[close] === '}') { depth -= 1; if (depth === 0) break }
    }
    const bodyRaw = src.slice(open + 1, close)
    if (stripComments(bodyRaw).trim().replace(/;$/, '') !== '') continue // 块内有语句：不是静默
    const line = src.slice(0, m.index).split('\n').length
    const loc = `${rel}:${line}`
    silent.push(loc)
    // ⚠ 判据不能只测「有没有注释标记」：`catch { /* */ }`、`catch { // }` 会被判成
    //   有理由，等于给恒绿开口子（负向对照 N3 实测过）。必须要求注释里有实质内容。
    const reasonText = [
      ...[...bodyRaw.matchAll(/\/\*([\s\S]*?)\*\//g)].map((x) => x[1]),
      // ⚠ 必须是 x[0].slice(2)——`x` 是匹配结果**数组**（类数组），直接 x.slice(2)
      //   走的是 Array.prototype.slice，恒返回 []，所有 `//` 理由都会被判成空。
      ...[...bodyRaw.matchAll(/\/\/[^\n]*/g)].map((x) => x[0].slice(2)),
    ].join('').trim()
    const hasReasonInBlock = reasonText.length > 0
    // 宽松一档：理由写在 catch 上一行也算（少数写法把说明放在 try 尾），同样要求有内容
    const prevLine = src.slice(0, m.index).replace(/\s+$/, '').split('\n').pop() ?? ''
    const hasReasonAbove = /^\s*(\/\/|\/\*)\s*\S/.test(prevLine)
    if (!hasReasonInBlock && !hasReasonAbove) violations.push(loc)
  }
}

// ── 活性自检：先证明扫描真的抓到了东西，否则「零违规」是空集恒真 ──
const SENTINELS = ['src/api/client.ts', 'src/views/TerminalView.vue']
let broken = 0
if (silent.length < 25) {
  console.error(`✗ 活性自检失败：只扫到 ${silent.length} 处静默 catch（预期 ≥25）。扫描器可能已失效。`)
  broken += 1
}
for (const s of SENTINELS) {
  if (!silent.some((x) => x.startsWith(`${s}:`))) {
    console.error(`✗ 活性自检失败：哨兵 ${s} 未出现在扫描结果里。扫描器可能已失效。`)
    broken += 1
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} 处静默 catch 没有写理由：`)
  for (const v of violations) console.error(`    ${v}`)
  console.error('  修法：在 catch 块内（或 catch 上一行）写清「为什么这里可以静默」——')
  console.error('  最常见的是「失败对用户无副作用」或「原因已在别处呈现」。')
}

if (broken + violations.length > 0) process.exit(1)
console.log(`✓ 静默 catch ${silent.length} 处，全部写明了理由（哨兵 ${SENTINELS.length}/${SENTINELS.length} 命中）`)

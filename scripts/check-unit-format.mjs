#!/usr/bin/env node
// F-21 接线守卫：单位标签与运行时长的**单一事实源**。
//
// 为什么：行为测试（src/api/types.test.ts）只能证明 fmtSize / fmtKib / fmtUptime
// 这三个共享函数本身输出正确，挡不住「某个视图又自己写了一份」——而 F-21 的
// 原始症状恰恰就是同一份 mem_used_kib 在体检报告标 8.0 GiB、在概览标 8.0 GB。
// 本项目已有教训：抽公共函数后不配防长回去的守卫，两个版本后会各写各的。
//
// 三条判据：① 共享函数只在 api/types.ts 定义，别处 0 处；② 两个视图确实从
// @/api/types 引入并调用；③ 视图代码里不再出现十进制容量标签字面量。
// ⚠ 扫描式断言先做活性自检（哨兵 + 扫描数量下限），否则集合为空时恒绿。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const TYPES = 'src/api/types.ts'

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.vue')) out.push(relative(ROOT, p))
  }
  return out
}

/** 剔行注释、块注释与 HTML 注释；保留字符串/模板串原文（标签检查要在串里做）。 */
function stripComments(s) {
  const out = []
  let i = 0
  let state = null
  while (i < s.length) {
    const c = s[i]
    if (state === null) {
      if (s.startsWith('//', i)) { state = 'line'; i += 2; out.push(' '); continue }
      if (s.startsWith('/*', i)) { state = 'block'; i += 2; out.push(' '); continue }
      if (s.startsWith('<!--', i)) { state = 'html'; i += 4; out.push(' '); continue }
      if (c === "'" || c === '"' || c === '`') { state = c; out.push(c); i += 1; continue }
      out.push(c); i += 1
    } else if (state === 'line') {
      if (c === '\n') { state = null; out.push(c) } else out.push(' ')
      i += 1
    } else if (state === 'block' || state === 'html') {
      const end = state === 'block' ? '*/' : '-->'
      if (s.startsWith(end, i)) { state = null; i += end.length; continue }
      out.push(c === '\n' ? '\n' : ' '); i += 1
    } else {
      out.push(c)
      if (c === '\\') { if (i + 1 < s.length) { out.push(s[i + 1]); i += 2; continue } }
      if (c === state) state = null
      i += 1
    }
  }
  return out.join('')
}

const files = walk(SRC)
const srcOf = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const codeOf = new Map(files.map((f) => [f, stripComments(srcOf.get(f))]))
const errors = []

// ── 活性自检 ──
if (files.length < 60) {
  errors.push(`扫描只覆盖 ${files.length} 个文件（预期 ≥60），扫描器可能已失效`)
}
const types = codeOf.get(TYPES)
if (!types || !types.includes('export function fmtSize')) {
  errors.push(`哨兵失效：${TYPES} 里找不到 fmtSize，扫描器可能已失效`)
}

// ① 单一事实源
const OWNED = ['fmtSize', 'fmtKib', 'fmtUptime', 'fmtUp']
for (const name of OWNED) {
  const defs = [...codeOf.entries()]
    .filter(([f, c]) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(c))
    .map(([f]) => f)
  const inTypes = defs.filter((f) => f === TYPES).length
  const expected = name === 'fmtUp' ? 0 : 1
  if (inTypes !== expected) {
    errors.push(`${TYPES} 里 function ${name} 定义 ${inTypes} 处（应为 ${expected}）`)
  }
  const elsewhere = defs.filter((f) => f !== TYPES)
  if (elsewhere.length) errors.push(`${name} 在别处被重复定义：${elsewhere.join(', ')}`)
}

// ② 两页接线：必须 import 且真的调用
const WIRING = [
  ['src/views/AssistantView.vue', ['fmtKib', 'fmtUptime']],
  ['src/views/DashboardView.vue', ['fmtUptime']],
]
for (const [f, names] of WIRING) {
  const code = codeOf.get(f)
  if (!code) { errors.push(`哨兵失效：找不到 ${f}`); continue }
  const importLine = (srcOf.get(f).match(/import\s*\{[^}]*\}\s*from\s*'@\/api\/types'/g) ?? []).join(' ')
  for (const name of names) {
    if (!importLine.includes(name)) errors.push(`${f} 没有从 @/api/types 引入 ${name}`)
    if (!new RegExp(`\\b${name}\\s*\\(`).test(code)) errors.push(`${f} 里没有调用 ${name}（import 了却没用）`)
  }
}

// ③ 十进制容量标签不许回到视图代码里（1024 递进必须配 IEC 标签）
//    Mbps / Kbps 是网络速率（十进制正确），它们是连写单词，\b 不会命中。
const DECIMAL = /\b(?:GB|MB|TB|KB|PB)\b/
for (const [f, code] of codeOf) {
  if (!f.startsWith('src/views/') && !f.startsWith('src/components/')) continue
  if (f.endsWith('.test.ts')) continue
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? ''
    if (DECIMAL.test(body)) errors.push(`${f} 仍有十进制容量标签：${body.trim().slice(0, 48)}`)
  }
}

// ③ 的活性自检：证明标签扫描确实抓到了 IEC 标签，不是空集恒真
const dash = codeOf.get('src/views/DashboardView.vue') ?? ''
if ((dash.match(/GiB/g) ?? []).length < 5) {
  errors.push('活性自检失败：DashboardView 里 GiB 少于 5 处，标签扫描可能已失效')
}

if (errors.length) {
  console.error(`✗ F-21 单位接线守卫失败（${errors.length} 条）：`)
  for (const e of errors) console.error(`    ${e}`)
  process.exit(1)
}
console.log(`✓ F-21：${files.length} 个文件，3 个共享函数单一事实源 + 两页接线 + 无十进制容量标签`)

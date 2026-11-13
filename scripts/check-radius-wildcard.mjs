#!/usr/bin/env node
/**
 * 圆角野值守卫（B1 收尾，2026-11-13）。
 *
 * 为什么需要：B1 第二轮把 4/5/6/7/9px 五种野值收敛到 --radius-chip / --radius-xs，
 * 但「扫描集合为空 = 通过」是这类守卫的头号恒绿来源——改的人只要换一个新数值
 * （3px / 10px / 14px）就能绕过，而 vue-tsc / vite build / 现有 UI 守卫全绿。
 * 现有 check-visual-system.mjs 只钉 main.css 里的 token 定义值，不扫 scoped 样式。
 *
 * 判据：src 下所有 .vue / .css 的 border-radius 声明必须走
 *   ① var(--radius-*) 系的单一事实源，或 ② 999px 药丸；
 * 多值（柱状条 2px 2px 0 0 等）、0 / 50% / 椭圆 / 按 B1 第二轮决议放行。
 * 其余**单值裸 px 一律判红**。唯一例外须在 EXCEPTIONS 显式登记，且守卫反向
 * 断言该例外仍然存在——值被改掉而登记没跟着改同样判红，避免登记变恒绿。
 *
 * 活性自检：文件数 / 声明总数 / token 化条数 / 999px 条数都设下限，
 * 正则或目录结构一旦失效，上面「errors 为空」就不会再冒充通过。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p)
  }
  return out
}

// 剔注释但保留换行，报出的行号才对得上源文件
function radiusDecls(src) {
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const out = []
  const re = /border-radius\s*:\s*([^;}]+)/g
  let m
  while ((m = re.exec(cleaned)) !== null) {
    out.push({
      value: m[1].replace(/\s+/g, ' ').trim(),
      line: cleaned.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

// 显式例外：新增必须在此登记，并写清为什么不能改成 token / 999px
const EXCEPTIONS = [
  { file: 'src/views/SystemView.vue', value: '3px', why: '.lg 是 10×10 图例色块，刻意保留圆角方块；改 999px 会变成正圆' },
]

const errors = []
const hitKeys = new Set()
let total = 0
let token = 0
let pill = 0
let multi = 0
const files = walk(SRC)

for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  for (const { value: v, line } of radiusDecls(readFileSync(f, 'utf8'))) {
    total += 1
    if (v.includes('var(')) { token += 1; continue }
    if (v === '999px') { pill += 1; continue }
    if (/^0$/.test(v) || v.includes('%') || v.includes('/')) continue
    if (v.split(' ').length > 1) { multi += 1; continue }
    if (/^\d+(?:\.\d+)?px$/.test(v)) {
      const ex = EXCEPTIONS.find((e) => e.file === rel && e.value === v)
      if (ex) { hitKeys.add(`${rel}|${v}`); continue }
      errors.push(`${rel}:${line}  border-radius: ${v} → 改用 var(--radius-*) 或 999px（裸 px 野值）`)
    } else {
      errors.push(`${rel}:${line}  border-radius: ${v}（无法识别的圆角值）`)
    }
  }
}

// ── 活性自检 ──
if (files.length < 60) errors.push(`哨兵失效：只扫到 ${files.length} 个样式文件（期望 ≥60）`)
if (total < 180) errors.push(`哨兵失效：只解析到 ${total} 条 border-radius 声明（期望 ≥180）`)
if (token < 100) errors.push(`哨兵失效：token 化声明只有 ${token} 条（期望 ≥100）`)
if (pill < 30) errors.push(`哨兵失效：999px 药丸只有 ${pill} 条（期望 ≥30）`)
for (const e of EXCEPTIONS) {
  if (!hitKeys.has(`${e.file}|${e.value}`)) {
    errors.push(`例外登记未命中或值已被改动：${e.file} 的 ${e.value}（${e.why}）`)
  }
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：圆角野值守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('== 圆角野值守卫（B1）==')
console.log(`  ✓ 扫描 ${files.length} 个样式文件 / ${total} 条 border-radius 声明`)
console.log(`  ✓ token 化 ${token} 条、999px 药丸 ${pill} 条、多值 ${multi} 条、登记例外 ${hitKeys.size} 条`)
console.log('  ✓ 无单值裸 px 野值（4/5/6/7/9/10/12/14… 一律判红）')
console.log('  ✓ 例外登记全部命中，活性自检通过')
console.log('PASS：圆角档位单一事实源未被绕过')

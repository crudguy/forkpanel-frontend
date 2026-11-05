#!/usr/bin/env node
// z-index 白名单守卫。
//
// 为什么需要：层级冲突是**静态可判定、真机才暴露**的典型问题。本项目
// `DashboardView` 的 hover 浮层用 z-index:1000，而 main.css 的层级总表写着
// 「100 toast 最高」——数值冲突肉眼很难发现，构建与现有守卫全绿。
//
// 判据：所有 z-index 必须是白名单里的已知层级。新增层级前先回答：
//   它要压过谁、会被谁压过？然后把它写进 main.css 的层级总表，再加到这里。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// main.css 层级总表：30 topbar / 40·41 菜单 / 50 一级弹窗 / 59 抽屉遮罩 /
// 60 二级浮层 / 70 全屏帮助层 / 80 命令面板 / 100 toast。
// 1000 已于 2026-11-05 收编（DashboardView 的指标卡悬浮详情原本用它，会把 toast 压住）。
// <30 是容器内局部层叠（表头 sticky、编辑器行号），不参与全局弹层竞争；
// 30 以上才是跨组件层级，必须语义明确。
const ALLOWED = new Set([0, 1, 2, 3, 20, 30, 40, 41, 50, 59, 60, 70, 80, 100])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p)
  }
  return out
}

// 注释里的 z-index **不算**：层级总表本身就要写「曾经写 z-index:1000」这类说明，
// 把说明当违规会让守卫在「刚把问题写清楚」的那一刻变红。注释里的声明也是死代码。
function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

let hits = 0
let styleBlocks = 0
const bad = []
const seen = new Map()

for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8')
  const blocks = f.endsWith('.css')
    ? [[stripCssComments(src), 0]]
    : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => [stripCssComments(m[1]), m.index])
  styleBlocks += blocks.length
  for (const [body] of blocks) {
    for (const m of body.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
      hits += 1
      const v = Number(m[1])
      seen.set(v, (seen.get(v) || 0) + 1)
      if (!ALLOWED.has(v)) bad.push(`${relative(ROOT, f)}  z-index:${v}`)
    }
  }
}

let failed = false
console.log('== z-index 白名单守卫 ==')
if (styleBlocks < 80 || hits < 10) {
  console.error(`  ✗ 扫描自检失败：${styleBlocks} 个 style 块 / ${hits} 处 z-index（期望 ≥80 / ≥10）`)
  failed = true
} else {
  console.log(`  ✓ [1] 扫过 ${styleBlocks} 个 style 块、${hits} 处 z-index`)
  console.log(`  · 分布：${[...seen.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${v}×${n}`).join('、')}`)
}
if (bad.length) {
  console.error(`  ✗ ${bad.length} 处使用了未登记的层级：`)
  for (const b of bad) console.error(`      ${b}`)
  failed = true
} else {
  console.log('  ✓ [2] 全部落在白名单内')
}

if (failed) process.exit(1)
console.log('PASS：z-index 全部在白名单内')

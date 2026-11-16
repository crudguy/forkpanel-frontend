#!/usr/bin/env node
/**
 * 页签面板守卫（设置/备份/数据库/WAF 四页的 Tab 组织）。
 *
 * 为什么需要：页签内容用 `v-show` 包了一层容器，容器一旦生成盒子，面板里的卡片
 * 就从「父级 flex 的直接子项」降级为「块内子元素」——`.view` 的 14px gap 对它们
 * 失效，实测顶层卡片间距 14px → 0px，卡片直接贴在一起。而 vue-tsc、构建、
 * 单测（jsdom 不算布局）全绿，只有真机看得出来。这里把两条契约钉死：
 *
 * 1. 全局 `.tab-pane` 必须是 `display: contents`（只承载可见性，不参与布局）；
 * 2. 面板必须用 `v-show`：`v-if` 会卸载子树，输入内容、下钻层级、分页/排序
 *    等「切签保状态」的前提全部丢失（行为测试 tabbedPages.behavior.test.ts
 *    从 DOM 侧也钉了一遍，两道互补）。
 *
 * 反恒绿：先做哨兵自检（main.css 能找到 .tab-pane 规则、扫描集合非空），
 * 再断言具体值；扫描不到文件时判红而不是通过。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const errors = []

// ── 1. 全局类契约 ──
const css = read('src/styles/main.css').replace(/\/\*[\s\S]*?\*\//g, ' ')
const body = /(?:^|\n)\s*\.tab-pane\s*\{([^}]*)\}/.exec(css)?.[1] ?? null
if (body === null) {
  errors.push('main.css 里找不到 .tab-pane 规则（页签面板的布局契约不存在）')
} else if (!/display\s*:\s*contents/.test(body)) {
  errors.push('.tab-pane 必须是 display: contents——普通盒子会让父级 flex 的 gap 失效（卡片间距变 0）')
}

// ── 2. 面板必须用 v-show ──
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}
const views = walk(join(ROOT, 'src/views')).concat(walk(join(ROOT, 'src/components')))
const tagRe = /<div\b[^>]*\bclass="[^"]*\btab-pane\b[^"]*"[^>]*>/g
let panes = 0
const files = []
for (const file of views) {
  const src = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of src.match(tagRe) ?? []) {
    panes++
    const rel = file.slice(ROOT.length)
    if (!files.includes(rel)) files.push(rel)
    if (/\bv-if\s*=/.test(tag)) {
      errors.push(`${rel}: 页签面板用了 v-if（卸载子树会丢状态），必须改 v-show`)
    }
    if (!/\bv-show\s*=/.test(tag)) {
      errors.push(`${rel}: 页签面板没有 v-show——切签不会隐藏内容`)
    }
  }
}
if (panes === 0) {
  errors.push('扫描集合为空：src/ 下没有任何 class="tab-pane" 面板（判据失效，不是通过）')
}
// 活性自检：守卫必须挂在唯一清单里，否则等于没跑。
const runner = read('scripts/run-ui-guards.mjs')
if (!runner.includes('check-tab-pane.mjs')) {
  errors.push('check-tab-pane.mjs 未登记进 scripts/run-ui-guards.mjs（守卫存在≠在跑）')
}

if (errors.length) {
  console.error('check-tab-pane: FAIL')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`check-tab-pane: PASS（.tab-pane = display:contents；${panes} 个面板均为 v-show）`)
for (const f of files) console.log(`  · ${f}`)

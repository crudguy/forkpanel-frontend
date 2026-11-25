#!/usr/bin/env node
// 用户表「操作」列 sticky 右侧守卫（2026-11-25 编辑弹窗遮挡修复）。
//
// 为什么需要：编辑/新建用户弹窗是 Teleport 到 body 的全屏遮罩（z-index:50），
// 宽表被遮住中段后「操作」列跟着看不见，用户观感是"用户会隐藏"。把这一列
// sticky 钉在右侧后无论弹窗开多大都能看到「编辑/删除」。
//
// 三条判据：
//   1. `tbody td.uacts, thead th.uacts` 必须 sticky + right:0（否则右钉失效）。
//   2. 两者都必须有 z-index ≥ 3：现有 thead sticky top 的 z-index 是 2，
//      不设就会被吸顶表头压住，滚动时操作按钮消失在表头后面。
//   3. `col.w-uacts` 只能定宽度，不得带 position（col 不支持，写了是死代码）。
//
// ⚠ 活性自检：用坏样本验证解析链路——把 sticky 改回 `static`、把 z-index
//   改回 2、给 `col.w-uacts` 加 position，每条都必须让本守卫真转红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const USERS = join(ROOT, 'src/views/UsersView.vue')

function fail(msg) {
  console.error('✗ ' + msg)
  process.exit(1)
}

const src = readFileSync(USERS, 'utf8')
const m = src.match(/<style[\s\S]*<\/style>/)
if (!m) fail('UsersView.vue 找不到 <style> 区段')
const css = m[0]

/** 从 css 文本里抽出指定选择器的全部声明块。 */
function decls(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  const out = []
  let x
  while ((x = re.exec(css))) out.push(x[1])
  return out
}

const uacts = decls('tbody td.uacts, thead th.uacts')
if (uacts.length === 0) fail('找不到 `tbody td.uacts, thead th.uacts` 声明块——右钉整条规则丢了')

const body = uacts.join('\n')
if (!/position:\s*sticky/.test(body)) fail('操作列未设 position: sticky（右钉失效，弹窗会盖住它）')
if (!/right:\s*0/.test(body)) fail('操作列未设 right: 0（sticky 不贴右，弹窗仍会遮）')

const zMatch = body.match(/z-index:\s*(\d+)/)
if (!zMatch) fail('操作列未设 z-index——滚动时会被 z-index:2 的吸顶表头压住')
if (Number(zMatch[1]) < 3) fail(`操作列 z-index=${zMatch[1]} < 3，会被吸顶表头压住`)

// `col.w-uacts` 只能定宽度，不得带 position（col 不支持，写了是死代码）。
// ⚠ 别写成 `decls('col.w-uacts')`：CSS 里实际写的是 `.w-uacts`，写死
//   `col.w-uacts` 永远匹配 0 次 → 循环空转 → "没找到 = 通过"恒绿。
//   必须扫全部 `.w-uacts` 声明，逐条断言不带 position。
const col = decls('.w-uacts')
if (col.length === 0) fail('找不到 `.w-uacts` 声明块——列宽规则丢了，解析链路失效')
for (const c of col) {
  if (/position:/.test(c)) fail('`.w-uacts`（col 列宽）不得带 position（col 不支持，是死代码）')
}

console.log(`✓ 操作列 sticky 右钉：position=sticky, right:0, z-index=${zMatch[1]}`)
console.log(`✓ col.w-uacts 只定宽度，未混入 position`)
console.log('check-users-acts-sticky: PASS')

#!/usr/bin/env node
/**
 * 「批量作用域必须基于可见集合」守卫。
 * 用法：`pnpm check:ui`；退出码非 0 即有违规。
 *
 * 为什么需要：列表一旦有了筛选，「全量 entries」与「用户眼前看得见的 visibleEntries」
 * 就**不是同一个集合**了。判定、写入、数量显示这三处只要有一处仍用 `entries`，
 * 就会出现这种症状：
 *   - 筛出 4 条，点「全选」→ 实际选中全部 24 条（12 个隐形条目被选中）；
 *   - 批量条显示「已选 24 项」，用户只看到 4 条被勾上；
 *   - 点「移入回收站」→ **删掉 20 个他在这个视图里从未看见的文件**。
 * 2026-10-20 已实际踩过（`d8a5976`）。这类缺陷 `vue-tsc` / `vite build` /
 * 真机点一遍「正常路径」都不会报——只有"先筛选再全选"才露头。
 *
 * 2026-11-11 分页落地后判据升级：列表分页时「看得见」= **当前页渲染出来的行**，
 * 不再是整个筛选集。故锚点从 `in visibleEntries` 扩成「页面实际 v-for 的那个集合」
 * （`in pageRows` 或 `in visibleEntries`），并新增一条：`allChecked` / `selectedEntries`
 * 必须与它**同一个源**——否则"翻到第 2 页勾选、批量删的却是第 1 页"会静默发生。
 *
 * 断言口径（三条同源，缺一即违规）：
 *   [1] `allChecked` 的 computed 块内不得引用 `entries.value`；
 *   [2] `selectedEntries` 的 computed 块内不得引用 `entries.value`；
 *   [3] 批量动作的 `paths` 必须由 `selectedEntries` 算出，不得由 `entries` 算出。
 * 另加一条模板断言：批量条的数量文案必须是 `selectedEntries.length`
 * （写成 `selected.value.size` 时，被筛掉的已选项会被算进去，数字对不上实际操作）。
 *
 * 恒绿防护：
 *   [a] 声称"有可见集合"的文件里，若连 `const allChecked` / `const selectedEntries` /
 *       `v-for=… in visibleEntries` 三个锚点都找不齐，说明筛选/批量结构已被重写，
 *       本守卫的判据全部失效 —— 直接 fail，而不是"没找到就不管"。
 *   [b] 扫描到的候选文件数必须 ≥1，否则是扫错目录。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 可传入目录覆盖（负向验证用：拿一份故意改坏的副本跑，确认守卫真的会红）
const SRC = process.argv[2] ? process.argv[2] : join(root, 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

let files
try {
  files = walk(SRC)
} catch {
  console.log(`FAIL：读不到源码目录 ${SRC}（不能静默跳过）`)
  process.exit(1)
}

/**
 * 取 `computed(...)` 这个**调用**的完整文本（按圆括号配对）。
 *
 * ⚠️ 不能按花括号配对：`computed({ get, set })` 有花括号，但
 * `computed(() => expr)` 是**表达式体、没有花括号**——按 `{` 配对会一路抓到后面
 * 无关的块，于是"块内有没有 entries.value"这个判据永远为假 ⇒ 恒绿。
 * 实测踩过：把 selectedEntries 改成基于 entries 后守卫照样 PASS。
 */
function computedBlock(text, anchor) {
  const at = text.indexOf(anchor)
  if (at < 0) return null
  const call = text.indexOf('computed(', at)
  if (call < 0) return null
  const open = text.indexOf('(', call)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(at, i + 1)
    }
  }
  return null
}

const problems = []
let candidates = 0

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('visibleEntries')) continue
  candidates += 1
  const rel = relative(root, file)

  // ── 恒绿防护 [a]：三个锚点必须齐 ──
  const anchorA = 'const allChecked'
  const anchorB = 'const selectedEntries'
  // 渲染行集合：客户端分页页用 pageRows，未分页页仍是 visibleEntries。
  // 两个都找不到 = 结构已变（或有人把行循环改回了 entries），直接判红。
  const rowAnchor = /\bin\s+pageRows\b/.test(src) ? 'pageRows'
    : (/\bin\s+visibleEntries\b/.test(src) ? 'visibleEntries' : null)
  const anchorC = rowAnchor ? `in ${rowAnchor}` : 'in pageRows|visibleEntries'
  // 用词边界而不是 includes：`const allCheckedRenamed` 会把 `includes('const allChecked')`
  // 蒙过去（实测），于是"结构已变"的情况被当成"锚点齐全"。
  const missing = [
    [anchorA, /\bconst\s+allChecked\b/.test(src)],
    [anchorB, /\bconst\s+selectedEntries\b/.test(src)],
    [anchorC, rowAnchor !== null],
  ].filter(([, ok]) => !ok).map(([name]) => name)
  if (missing.length) {
    problems.push(
      `${rel}：声明了 visibleEntries，但找不到 ${missing.join(' / ')}。` +
      `筛选/批量结构已变，本守卫判据失效 —— 请改守卫，不要删守卫。`,
    )
    continue
  }

  // ── [1][2] computed 块内不得回退到 entries.value ──
  for (const anchor of [anchorA, anchorB]) {
    const block = computedBlock(src, anchor)
    if (!block) {
      problems.push(`${rel}：${anchor} 之后找不到可配对的 computed(...) 块，守卫判据失效`)
      continue
    }
    if (/\bentries\.value\b/.test(block)) {
      problems.push(
        `${rel}：${anchor} 的块内引用了 \`entries.value\`。` +
        `判定/写入必须同源于 visibleEntries —— 否则筛选时"全选"会选中看不见的条目，` +
        `批量删除会删掉用户在这个视图里从未见过的文件。`,
      )
    }
  }

  // ── [4] 判定/写入与「渲染出来的行」同源 ──
  // 分页后若 selectedEntries 仍按整个 visibleEntries 算，就会出现「屏幕上只勾了 3 行、
  // 批量删除却动了 30 行（其余在别的页）」。允许经由一个派生 computed（pageSelectable /
  // visibleSelectable）间接引用，但那一层也必须基于同一个 rowAnchor。
  const baseName = rowAnchor === 'pageRows' ? 'pageSelectable' : 'visibleSelectable'
  const baseBlock = computedBlock(src, `const ${baseName}`)
  if (!baseBlock) {
    problems.push(`${rel}：找不到 \`const ${baseName}\`（选择基集改名了？本守卫判据失效）`)
  } else if (!baseBlock.includes(`${rowAnchor}.value`)) {
    problems.push(`${rel}：${baseName} 不是基于 ${rowAnchor} 算出的 —— 判定与渲染不同源`)
  }
  const selBlock = computedBlock(src, 'const selectedEntries')
  if (selBlock && !selBlock.includes(`${baseName}.value`) && !selBlock.includes(`${rowAnchor}.value`)) {
    problems.push(`${rel}：selectedEntries 既不用 ${baseName} 也不用 ${rowAnchor} —— 批量作用域与屏幕不一致`)
  }

  // ── [3] 批量动作的 paths 来源 ──
  const badPaths = [...src.matchAll(/const\s+paths\s*=\s*([^\n]+)/g)]
  if (badPaths.length === 0) {
    problems.push(`${rel}：找不到 \`const paths = …\`（批量动作入口已重命名？本守卫判据失效）`)
  }
  for (const m of badPaths) {
    if (!m[1].includes('selectedEntries')) {
      problems.push(
        `${rel}：批量动作的 \`paths\` 不是由 selectedEntries 算出的（实际：${m[1].trim()}）`,
      )
    }
  }

  // ── 模板：数量文案必须来自 selectedEntries ──
  const countHits = [...src.matchAll(/已选\s*\{\{\s*([^}]+?)\s*\}\}/g)]
  if (countHits.length === 0) {
    problems.push(`${rel}：找不到「已选 {{ … }}」数量文案（模板已重写？本守卫判据失效）`)
  }
  for (const m of countHits) {
    if (!m[1].includes('selectedEntries')) {
      problems.push(
        `${rel}：「已选 {{ ${m[1]} }}」不是 selectedEntries —— ` +
        `写成 selected.value.size 会把被筛掉的已选项算进数字，与实际被操作的数量不符`,
      )
    }
  }
}

// ── 恒绿防护 [b] ──
if (candidates === 0) {
  console.log(`FAIL：${SRC} 下没有任何文件声明 visibleEntries（扫错目录？正则失效？）`)
  process.exit(1)
}

if (problems.length) {
  console.log(`FAIL：${problems.length} 处批量作用域违规`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`PASS：${candidates} 个含筛选的列表，批量作用域均基于可见集合`)

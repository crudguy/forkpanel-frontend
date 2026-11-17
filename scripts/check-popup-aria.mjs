#!/usr/bin/env node
/**
 * 弹层 ARIA 契约守卫：触发器声明的弹出类型 ↔ 面板实际角色必须一致。
 *
 * 为什么需要：用户菜单与重启菜单的触发器都写着 `aria-haspopup="menu"`，但面板
 * 既没有 `role="menu"`、也没有 `menuitem`/`menuitemradio` —— 屏幕阅读器会切进
 * 「菜单」的键盘模型（方向键在项间移动、Home/End、Tab 关闭），而实现只是一条普通
 * 的 Tab 序列。这类「承诺了做不到的交互模型」在 vue-tsc / 单测 / 构建里全绿，
 * 只有读屏用户撞上才知道。
 *
 * 现行实现是 disclosure（不是 menu）：用户菜单里既有三档偏好分段控件、又有操作项，
 * 不是纯动作列表，套 menu 模型反而会让读屏把普通 button 当菜单项跳过。所以：
 *   触发器 = `aria-expanded` + `aria-controls`（不声明 haspopup）
 *   面板   = `role="group"` + `aria-label`（有角色、有名字）
 * 若将来真要做成 menu，必须先实现方向键导航，再同步改本守卫与那两处模板。
 *
 * 判据：
 *   [1] `aria-haspopup="menu"` 必须伴随本文件的 `role="menu"`；其余取值同理
 *       （现存唯一一处 haspopup 是版本面板的 dialog，须有 role="dialog"）
 *   [2] 带 `aria-controls="ID"` 的触发器，同一标签内必须有 `aria-expanded`，
 *       且 ID 指向的元素必须带 role 与 aria-label
 *   活性自检：.vue 数量、haspopup 命中数、aria-controls 命中数都要达标 ——
 *   正则写错或扫错目录时「扫空 = 通过」会恒绿，必须先自证扫到了东西。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const MIN_FILES = 40
const MIN_HASPOPUP = 1
const MIN_CONTROLS = 2

/** 剔 HTML 注释（注释里提到 aria-haspopup 很常见，不剔会误判） */
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 取 idx 所在的整个标签（从最近的 `<` 到其后的 `>`）；属性里含 `>` 时会被截短，
 *  但那只会让断言变红（有人去看一眼），不会静默放过。 */
function tagAround(src, idx) {
  const start = src.lastIndexOf('<', idx)
  if (start < 0) return null
  const end = src.indexOf('>', idx)
  if (end < 0) return null
  return src.slice(start, end + 1)
}

const files = walk(SRC)
const errors = []
let nHaspopup = 0
let nControls = 0

if (files.length < MIN_FILES) {
  console.log(`FAIL：只扫到 ${files.length} 个 .vue（阈值 ${MIN_FILES}），疑似扫错目录，守卫不可信`)
  process.exit(1)
}

for (const f of files) {
  const rel = relative(ROOT, f)
  const src = stripHtml(readFileSync(f, 'utf8'))
  const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

  // [1] 声明了 aria-haspopup=X，本文件就得有 role=X 的面板
  for (const m of src.matchAll(/aria-haspopup="([a-z]+)"/g)) {
    nHaspopup += 1
    const kind = m[1]
    if (!src.includes(`role="${kind}"`)) {
      errors.push(`${rel}: 声明 aria-haspopup="${kind}"，但本文件没有 role="${kind}" 的面板 —— 读屏会按该类型的键盘模型期待交互（菜单要方向键、对话框要焦点入内），实现却只是普通 Tab 序列`)
    }
  }

  // [2] aria-controls 的接线：触发器报展开态，面板有角色和名字
  for (const m of src.matchAll(/aria-controls="([^"]+)"/g)) {
    nControls += 1
    const id = m[1]
    const tag = tagAround(src, m.index) ?? ''
    if (!/aria-expanded=/.test(tag)) {
      errors.push(`${rel}: aria-controls="${id}" 的触发器没有 aria-expanded —— 读屏读不出展开/收起`)
    }
    const at = src.indexOf(`id="${id}"`)
    if (at < 0) {
      errors.push(`${rel}: aria-controls="${id}" 指向的 id 在文件里不存在`)
      continue
    }
    const panel = tagAround(src, at) ?? ''
    if (!/role="group"/.test(panel)) {
      errors.push(`${rel}: 面板 #${id} 缺 role="group" —— disclosure 面板必须有角色，否则只是一团无语义的 div`)
    }
    if (!/aria-label=/.test(panel)) {
      errors.push(`${rel}: 面板 #${id} 缺 aria-label —— 进入后读不出这是什么面板`)
    }
  }
}

// 活性自检：扫空≠通过
if (nHaspopup < MIN_HASPOPUP) errors.push(`aria-haspopup 只命中 ${nHaspopup} 处（期望 ≥${MIN_HASPOPUP}）：正则或扫描范围可能失效`)
if (nControls < MIN_CONTROLS) errors.push(`aria-controls 只命中 ${nControls} 处（期望 ≥${MIN_CONTROLS}）：说明 disclosure 接线被删或正则失效`)

console.log('== 弹层 ARIA 契约守卫（触发器声明 ↔ 面板角色）==')
if (errors.length) {
  for (const e of errors) console.log(`  ✗ ${e}`)
  console.log(`FAIL：${errors.length} 项未通过`)
  process.exit(1)
}
console.log(`  ✓ 扫过 ${files.length} 个 .vue；${nHaspopup} 处 haspopup 均有同角色面板`)
console.log(`  ✓ ${nControls} 处 aria-controls 均带 aria-expanded，面板均有 role + aria-label`)
console.log('PASS：弹层 ARIA 契约一致')

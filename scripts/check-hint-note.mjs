/**
 * 提示块文字节点守卫
 *
 * `.hint-note` 是 `display:flex` 的容器（图标 + 一段文字）。flex 的规则是：
 * **每个直接子节点都成为一个 item**，item 之间被 `gap` 拉开、又各自被压窄到
 * 剩余宽度。于是下面这种写法会炸：
 *
 *     <p class="hint-note">勾选控制列是否显示；不常看的列收起来后，可在<b>完整</b>的取值。</p>
 *
 * 裸文本 + `<b>` + 裸文本 = 三个 item ⇒ 屏幕上变成**三列并排**，每列只有两三个
 * 字宽、逐字折行，整段读不成句。实测过一例：中间那个 `<b>` 只剩 31px 宽、
 * 整段 84px 高还拼不回一句话。而编译、类型、单测、UI 截图（缩略图）全都发现不了
 * ——只有真把弹窗拉到眼前逐字读才看得见。
 *
 * 判据：class 含 `hint-note` 的元素的**第一个非空白子节点**必须是元素（通常是
 * `<Icon>` 的 `.ic` 或包裹整段话的 `<span>`），不能是裸文本。
 *
 * ⚠ 只查「首个节点」够不够：够。若首个节点是 `<span>`/`.ic`，后面即使再有裸
 * 文本，那也是作者显式排版的一部分（如 `.ic` + 裸文本）；而「裸文本打头」正是
 * 忘记包 span 的唯一入口——人会先敲文字再想起来加粗词，不会反过来。
 *
 * 恒绿防护（与 check-modal / check-overlay-teleport 同一口径）：
 *   [1] 扫到的 .vue 数低于阈值 → 认为扫错目录，直接 fail；
 *   [2] 扫到的 hint-note 元素数为 0 → 说明正则失效，直接 fail（不是"没有问题"）。
 * 跳过不是通过：真有豁免需求请在本文件的 ALLOW 表里显式登记并写明理由。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
const MIN_FILES = 40
const MIN_NOTES = 10

/** 显式豁免（当前为空）。键 = 相对 src 的路径，值 = 允许的原因。 */
const ALLOW = new Map()

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walk(SRC)
console.log('== 提示块文字节点守卫（.hint-note 的 flex item 陷阱）==')

if (files.length < MIN_FILES) {
  console.log(`  ✗ [1] .vue 文件数=${files.length}，少于阈值 ${MIN_FILES} —— 疑似扫错目录，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [1] 扫过 ${files.length} 个 .vue`)

// 匹配开标签：class 属性里含独立的 hint-note（前后不能粘别的类名字符）
const OPEN = /<(\w+)([^>]*\bclass="[^"]*\bhint-note\b[^"]*"[^>]*)>/g

const bad = []
let scanned = 0

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(OPEN)) {
    const tag = m[1]
    if (tag === 'template') continue
    const rest = src.slice(m.index + m[0].length)
    const end = rest.indexOf(`</${tag}>`)
    if (end < 0) continue
    scanned++
    const inner = rest.slice(0, end).replace(/^[\s]+/, '')
    if (inner && !inner.startsWith('<')) {
      const line = src.slice(0, m.index).split('\n').length
      const rel = file.slice(SRC.length + 1)
      if (ALLOW.has(rel)) continue
      bad.push({ rel, line, preview: inner.split('\n')[0].slice(0, 46) })
    }
  }
}

if (scanned < MIN_NOTES) {
  console.log(`  ✗ [2] 只扫到 ${scanned} 个 .hint-note，少于阈值 ${MIN_NOTES} —— 正则失效或类名改了，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [2] 扫过 ${scanned} 个 .hint-note，裸文本打头 ${bad.length} 处`)

if (bad.length) {
  console.log('  ✗ [3] 以下 .hint-note 的文字没有包进 <span>，会被 flex 拆成多列并逐字折行：')
  for (const b of bad) {
    console.log(`      ${b.rel}:${b.line}`)
    console.log(`        ${b.preview}…`)
  }
  console.log('      修法：把整段话包进一个 <span>（图标 .ic 保持独立）。')
  process.exit(1)
}

console.log('PASS：.hint-note 文字节点全部成组（不会被 flex 拆散）')

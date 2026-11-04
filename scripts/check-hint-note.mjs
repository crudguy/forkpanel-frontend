/**
 * 提示块文字节点守卫
 *
 * `.hint-note` 是 `display:flex` 的容器（图标 + 一段文字）。flex 的规则是：
 * **每个直接子节点都成为一个 item**，item 之间被 `gap` 拉开、又各自被压窄到
 * 剩余宽度。于是下面这些写法都会炸：
 *
 *     <p class="hint-note">勾选控制列是否显示；不常看的列收起来后，可在<b>完整</b>的取值。</p>
 *     <p class="hint-note"><b>清单内置</b>：只给镜像名……默认 <code>latest</code>。</p>
 *
 * 裸文本 + `<b>` + 裸文本 = 三个 item ⇒ 屏幕上变成**三列并排**，每列只有两三个
 * 字宽、逐字折行，整段读不成句。实测过一例：中间那个 `<b>` 只剩 31px 宽、
 * 整段 84px 高还拼不回一句话。而编译、类型、单测、UI 截图（缩略图）全都发现不了
 * ——只有真把弹窗拉到眼前逐字读才看得见。
 *
 * 判据（**顶层全部子节点**，不是只看第一个）：
 *   把 .hint-note 内部按 depth 拆成顶层 item，必须满足——
 *     ① 不允许顶层**裸文本**（非空白）；
 *     ② 顶层元素只允许 `<span>`（文字容器，v-if/v-else 多分支可多个）、
 *        `<Icon>`、带 `class="ic"` 的图标元素、`<template>`（分支包裹）；
 *     ③ 至少有一个 `<span>` / `<template>` 承载文字。
 *   `<b>` / `<code>` / `<i>` / `<a>` 等**只有包在 `<span>` 里才算合法**（在顶层出现即违规）。
 *
 * ⚠ 旧版「只看首个非空白子节点是不是元素」不够：`<b>` 打头同样是元素，于是
 *   `<b>…</b>：…<code>…</code>` 这种会**静默放行**（真实踩过：ImagesTab / StackEditorDialog）。
 *
 * 恒绿防护（与 check-modal / check-overlay-teleport 同一口径）：
 *   [1] 扫到的 .vue 数低于阈值 → 认为扫错目录，直接 fail；
 *   [2] 扫到的 hint-note 元素数为 0 → 说明正则失效，直接 fail（不是"没有问题"）；
 *   [3] 哨兵：必须扫到一个已知存在的 hint-note（证明扫描真的抓到了东西）。
 * 跳过不是通过：真有豁免需求请在本文件的 ALLOW 表里显式登记并写明理由。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
const MIN_FILES = 40
const MIN_NOTES = 10
/** 已知存在的 hint-note（相对 src），用于证明扫描不是空转。 */
const SENTINEL = 'components/CreateContainerDialog.vue'

/** 显式豁免（当前为空）。键 = 相对 src 的路径，值 = 允许的原因。 */
const ALLOW = new Map()

/** 顶层允许出现的元素；其余（b/code/i/a/div…）在顶层即违规。 */
const TOP_TAGS = new Set(['span', 'Icon', 'template'])

/** HTML 空元素：没有闭合标签，不能用来增加 depth（否则 <br> 会把后面的 <div> 漏到顶层）。 */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 自闭合：`.../>` 或 HTML void 元素。 */
function isSelfClosing(raw) {
  if (/\/>$/.test(raw)) return true
  const tag = (raw.match(/^<([\w-]+)/) || [])[1]
  return !!tag && VOID.has(tag.toLowerCase())
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 从 `s`（开标签之后）找到配对闭标签，返回内部 HTML。注释与引号内的 `>` 都跳过。 */
function extractInner(s) {
  let i = 0
  let depth = 1
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i)
      i = e < 0 ? s.length : e + 3
      continue
    }
    if (s[i] === '<') {
      let j = i + 1
      let quote = null
      while (j < s.length) {
        const c = s[j]
        if (quote) { if (c === quote) quote = null }
        else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
        j++
      }
      const raw = s.slice(i, j + 1)
      if (/^<\//.test(raw)) {
        depth--
        if (depth === 0) return s.slice(0, i)
      } else if (!isSelfClosing(raw)) {
        depth++
      }
      i = j + 1
    } else {
      i++
    }
  }
  return null
}

/** 把内部 HTML 拆成顶层 item：{ kind:'text', text } 或 { kind:'el', tag, raw }。 */
function topLevel(inner) {
  const s = inner.replace(/<!--[\s\S]*?-->/g, '')
  const items = []
  let i = 0
  let depth = 0
  let textBuf = ''
  const flushText = () => {
    if (depth === 0 && textBuf.trim()) items.push({ kind: 'text', text: textBuf.trim() })
    textBuf = ''
  }
  while (i < s.length) {
    if (s[i] === '<') {
      let j = i + 1
      let quote = null
      while (j < s.length) {
        const c = s[j]
        if (quote) { if (c === quote) quote = null }
        else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
        j++
      }
      const raw = s.slice(i, j + 1)
      if (depth === 0) {
        flushText()
        if (!/^<\//.test(raw)) {
          const tag = (raw.match(/^<([\w-]+)/) || [])[1] || '?'
          items.push({ kind: 'el', tag, raw })
        }
      }
      if (/^<\//.test(raw)) depth--
      else if (!isSelfClosing(raw)) depth++
      i = j + 1
    } else {
      if (depth === 0) textBuf += s[i]
      i++
    }
  }
  flushText()
  return items
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
let sawSentinel = false

for (const file of files) {
  const rel = file.slice(SRC.length + 1)
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(OPEN)) {
    const tag = m[1]
    if (tag === 'template') continue
    const inner = extractInner(src.slice(m.index + m[0].length))
    if (inner == null) continue
    scanned++
    if (rel === SENTINEL) sawSentinel = true

    const items = topLevel(inner)
    const violations = []
    let hasTextContainer = false
    for (const it of items) {
      if (it.kind === 'text') {
        violations.push(`顶层裸文本「${it.text.slice(0, 20)}…」`)
        continue
      }
      if (it.tag === 'span' || it.tag === 'template') hasTextContainer = true
      const isIcon = it.tag === 'Icon' || /\bclass="[^"]*\bic\b[^"]*"/.test(it.raw)
      if (!TOP_TAGS.has(it.tag) && !isIcon) {
        violations.push(`顶层 <${it.tag}> 未包进 <span>`)
      }
    }
    if (!hasTextContainer) violations.push('缺少承载文字的 <span>')

    if (violations.length && !ALLOW.has(rel)) {
      const line = src.slice(0, m.index).split('\n').length
      bad.push({ rel, line, violations })
    }
  }
}

if (scanned < MIN_NOTES) {
  console.log(`  ✗ [2] 只扫到 ${scanned} 个 .hint-note，少于阈值 ${MIN_NOTES} —— 正则失效或类名改了，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [2] 扫过 ${scanned} 个 .hint-note`)

if (!sawSentinel) {
  console.log(`  ✗ [3] 未扫到哨兵 ${SENTINEL} 的 .hint-note —— 扫描可能空转，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [3] 哨兵命中（${SENTINEL}）`)

if (bad.length) {
  console.log(`  ✗ [4] 以下 .hint-note 有 ${bad.length} 处会被 flex 拆成多列并逐字折行：`)
  for (const b of bad) {
    console.log(`      ${b.rel}:${b.line}`)
    for (const v of b.violations) console.log(`        · ${v}`)
  }
  console.log('      修法：把整段话包进一个 <span>（图标 .ic 保持独立、放 span 之前）。')
  process.exit(1)
}

console.log('PASS：.hint-note 顶层子节点全部成组（不会被 flex 拆散）')

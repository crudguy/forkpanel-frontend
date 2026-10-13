#!/usr/bin/env node
/**
 * 「全视口浮层不得被 backdrop-filter 祖先困住」守卫。
 * 用法：`pnpm check:ui`；退出码非 0 即有违规。
 *
 * 为什么需要：`backdrop-filter` 会让该元素成为 `position: fixed` 的**包含块**——
 * `{position:fixed; inset:0}` 的遮罩于是按那个元素的盒子解算，而不是视口。已实测
 * 两个受害者（都是"看起来正常、用起来失灵"）：
 *   - 顶栏 `.topbar`（`backdrop-filter: blur(14px)`）：用户菜单的 `.backdrop` 被算成
 *     **1036×57**（顶栏那一条）→ 点内容区根本碰不到遮罩，菜单关不掉；
 *   - 页面头部 `.page-head`（同款玻璃）：列选择器的 `.mask` 被居中进 64px 高的盒子，
 *     弹窗整个跑到视口外（ColumnPicker 已用 Teleport 修掉，注释里记了这事）。
 * 这类问题 `vue-tsc` / `vite build` / 页面渲染**全都正常**，只能显式断言。
 *
 * 断言口径（刻意收窄，避免误报）：
 *   [1] 必须扫描到足够多的 .vue 文件——扫错目录/路径改名时不能静默 PASS。
 *   [2] 每个文件：先把 `<Teleport>…</Teleport>` 整段抠掉（Teleport 出去的浮层与
 *       页面结构无关，安全），再在**带 backdrop-filter 的元素的元素文本内**找
 *       「全视口浮层类」（CSS 里声明了 `position:fixed` + `inset:0` 的类）。
 *       找到即违规：那个浮层会被困在滤镜元素里。
 *   恒绿防护（[3]）：必须至少真的抽到过「filter 元素」和「浮层类」各一次，
 *   否则说明选择器/写法变了、下面的检查形同虚设，直接 fail。
 *
 * 安全写法（两种都认可，由本守卫放行）：
 *   a) `<Teleport to="body">` 把浮层移出该子树（推荐，与页面结构无关）；
 *   b) 浮层是滤镜元素的**兄弟/祖先**而非后代（如 `.nav-backdrop` 在 `.shell` 下、
 *      与 `.topbar` 平级）——此时它没有被困住。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 可传入目录覆盖（负向验证用：拿一份故意改坏的副本跑，确认守卫真的会红）
const SRC = process.argv[2] ? process.argv[2] : join(root, 'src')
const MIN_FILES = 30

const failures = []
const fail = (id, msg) => { console.log(`  ✗ [${id}] ${msg}`); failures.push(id) }
const pass = (id, msg) => console.log(`  ✓ [${id}] ${msg}`)

console.log(`（检查 ${SRC}）`)
console.log('== 浮层 Teleport 守卫（backdrop-filter 包含块）==')

// ── 1. 收集 .vue 文件 ────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}
let files
try {
  files = walk(SRC)
} catch (e) {
  fail('1', `源码目录不可读：${SRC}（${e.code ?? e.message}）`)
  console.log('\nFAIL：无法完成扫描（1）')
  process.exit(1)
}
if (files.length < MIN_FILES) {
  fail('1', `只扫到 ${files.length} 个 .vue（少于 ${MIN_FILES}）——疑似扫错目录，守卫不可信`)
  console.log('\nFAIL：无法完成扫描（1）')
  process.exit(1)
}
pass('1', `扫过 ${files.length} 个 .vue`)

// ── 2. 从 CSS 里抽「浮层类」与「滤镜类」 ─────────────────────────────
const FIXED = /position\s*:\s*fixed/
const INSET0 = /inset\s*:\s*0(?:\D|$)/
const FILTER = /(?:^|[;{\s])-?backdrop-filter\s*:\s*(?!none)/

/** 抽「规则体满足 bodyOk」的选择器里出现过的类名（含 @media 内的规则）。 */
function classesWith(css, bodyOk) {
  const out = new Set()
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '') // 去注释：注释里常提类名，不能算
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(s))) {
    if (!bodyOk(m[2])) continue
    for (const c of m[1].matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(c[1])
  }
  return out
}

const mainCss = readFileSync(join(root, 'src/styles/main.css'), 'utf8')
const overlayClasses = classesWith(mainCss, (b) => FIXED.test(b) && INSET0.test(b))
const filterClasses = classesWith(mainCss, (b) => FILTER.test(b))
console.log(`  · main.css：浮层类 [${[...overlayClasses].join(', ') || '无'}]｜滤镜类 [${[...filterClasses].join(', ') || '无'}]`)

// ── 3. 逐文件：抠掉 Teleport，再找「滤镜元素内的浮层元素」 ─────────────
const blankComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))

/** 标签属性串：引号内的 `>` 不算标签结束（`:style="{ width: a > b }"` 这种写法
 *  用 `[^>]*` 会在中间截断，配平随之全错）。 */
const ATTR = String.raw`(?:"[^"]*"|'[^']*'|[^>"'])*`

/** 从 start 起按标签名做深度配对，返回整个元素文本（找不到闭合返回 null）。
 *  ⚠ 自闭合标签（仓内大量 `<div class="fill" :style="…" />`）**不改变深度**：
 *  把它们算成开标签会让外层元素永远配不平（实测 ProfessionalView 47 开 / 39 闭，
 *  8 个差额全是自闭合）。 */
function elementSpan(src, start, tag) {
  const re = new RegExp(`<${tag}\\b${ATTR}>|</${tag}\\s*>`, 'g')
  re.lastIndex = start
  let depth = 0
  let m
  while ((m = re.exec(src))) {
    const t = m[0]
    if (t[1] === '/') { // </tag>
      depth -= 1
      if (depth === 0) return src.slice(start, m.index + t.length)
    } else if (t.endsWith('/>')) { // 自闭合：没有后代
      if (depth === 0 && m.index === start) return t
    } else {
      depth += 1
    }
  }
  return null
}

/** 模板里所有「开标签的 class 字面量**整词**含 cls」的元素（返回 {tag, start}）。
 *  整词比较而非 `\bcls\b`：后者会把 `card-title` 当成 `.card`（实测误报）。 */
function elementsWithClass(tpl, cls, limit = 40) {
  const out = []
  const re = new RegExp(`<([A-Za-z][\\w-]*)${ATTR}>`, 'g')
  let m
  while ((m = re.exec(tpl)) && out.length < limit) {
    const cm = /(?:^|\s)class="([^"]*)"/.exec(m[0])
    if (!cm) continue
    if (!cm[1].split(/\s+/).includes(cls)) continue
    out.push({ tag: m[1], start: m.index })
  }
  return out
}

const offenders = []
let filterHits = 0 // 真的在模板里找到过滤镜元素
let overlaySeen = 0 // 真的在模板里找到过浮层元素（含已被 Teleport 的）
const unpaired = [] // 配对不上的滤镜元素：静默跳过＝可能漏掉真违规，必须显式报出来
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  const styleAt = raw.indexOf('<style')
  // 只取 <template> 段：<script> 里的 JSDoc 注释常含 HTML 示例（如
  // ``<div class="card">`` 这种"等价写法"说明），混进来会被当成真元素。
  const tplStart = raw.indexOf('<template>')
  const tplEnd = styleAt >= 0 ? raw.lastIndexOf('</template>', styleAt) : raw.lastIndexOf('</template>')
  const tplAll = tplStart >= 0 && tplEnd > tplStart ? blankComments(raw.slice(tplStart, tplEnd)) : ''
  const style = styleAt >= 0 ? raw.slice(styleAt) : ''
  const rel = relative(root, f)

  // 本文件自己的定义也并入（如 MainLayout 的 .topbar / .backdrop）
  const localOverlay = classesWith(style, (b) => FIXED.test(b) && INSET0.test(b))
  const localFilter = classesWith(style, (b) => FILTER.test(b))
  const overlays = new Set([...overlayClasses, ...localOverlay])
  const filters = new Set([...filterClasses, ...localFilter])
  if (!overlays.size || !filters.size) continue

  // Teleport 里的浮层与页面结构无关 → 整段抠掉后再看残留
  const tpl = tplAll.replace(/<Teleport\b[\s\S]*?<\/Teleport\s*>/g, (m) => m.replace(/[^\n]/g, ' '))

  for (const cls of overlays) if (elementsWithClass(tpl, cls, 999).length) overlaySeen += 1

  for (const fcls of filters) {
    for (const el of elementsWithClass(tpl, fcls)) {
      const span = elementSpan(tpl, el.start, el.tag)
      // 配对不上就跳过的话，一旦模板写法变化这里会静默漏检——显式报出来
      if (!span) { unpaired.push(`${rel}：<${el.tag} class="${fcls}"> 找不到配对闭合标签`); continue }
      filterHits += 1
      // 只在**开标签之后**查找：滤镜元素自己也可能带浮层类（如 .mask 自带
      // backdrop-filter 做毛玻璃），把自己算进去就是误报。
      const openEnd = new RegExp(`^<[A-Za-z][\\w-]*${ATTR}>`).exec(span)
      const inner = openEnd ? span.slice(openEnd[0].length) : span
      for (const ocls of overlays) {
        if (elementsWithClass(inner, ocls, 1).length) {
          offenders.push(`${rel}：.<${el.tag} class="${fcls}">（有 backdrop-filter）内部还有 ".${ocls}" 浮层——会被算成该元素的盒子，必须 Teleport 到 body`)
        }
      }
    }
  }
}

// [3] 恒绿防护：抽不到东西就说明口径失效
if (!overlaySeen) fail('3a', '整仓没在任何模板里找到「浮层类」元素——浮层类抽取口径失效，检查形同虚设')
else pass('3a', `模板里发现浮层类元素 ${overlaySeen} 处（含已 Teleport 的）`)
if (!filterHits) fail('3b', '整仓没在任何模板里找到「带 backdrop-filter 的元素」——滤镜类抽取口径失效，检查形同虚设')
else pass('3b', `模板里发现滤镜元素 ${filterHits} 处`)

if (unpaired.length) {
  fail('3c', `${unpaired.length} 个滤镜元素配对不上闭合标签（守卫口径可能失效、会漏检）：\n      - ${unpaired.slice(0, 5).join('\n      - ')}`)
} else {
  pass('3c', '所有滤镜元素都能配对到闭合标签（没有因配对失败被跳过的）')
}

if (offenders.length) {
  fail('2', `有 ${offenders.length} 个浮层被 backdrop-filter 祖先困住：\n      - ${offenders.join('\n      - ')}`)
} else {
  pass('2', '无浮层被困在 backdrop-filter 祖先里（Teleport 或本就平级）')
}

if (failures.length) {
  console.log(`\nFAIL：浮层 Teleport 有 ${failures.length} 条违规（${failures.join(', ')}）`)
  process.exit(1)
}
console.log('\nPASS：浮层与 backdrop-filter 祖先关系全部正确')

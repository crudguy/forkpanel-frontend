/**
 * 弹窗式样统一守卫
 *
 * `.mask` / `.modal` 的基础式样必须由 `src/styles/main.css` **统一提供**，
 * 各视图不得再各抄一份——此前 Sites / Certs / Databases / Files / Security
 * 五个视图参数互不相同：宽度 400/440/460、圆角 12/14、背景 --c-surface 与
 * --c-surface-2 混用、遮罩透明度 .45/.5、z-index 50/60（一级弹窗被设成和
 * 二级浮层同级）。同一个弹窗在不同页面长得不一样，用户一眼能看出。
 *
 * 派生式样（`.modal.wide` / `.modal h3` / `.modal.wide .modal-actions` 等）
 * 属于各视图的正当扩展，不在打击范围内。
 *
 * 恒绿防护（与既有守卫同一口径）：
 *   [1] 视图文件数低于阈值 → 认为扫错了目录，直接 fail；
 *   [2] main.css 里提取不到公共定义 → 守卫本身不可信，直接 fail。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const viewsDir = join(process.cwd(), 'src/views')
const mainCss = join(process.cwd(), 'src/styles/main.css')
const MIN_VIEWS = 20

let files
try {
  files = readdirSync(viewsDir).filter((f) => f.endsWith('.vue'))
} catch {
  console.log(`FAIL：读不到视图目录 ${viewsDir}（不能静默跳过）`)
  process.exit(1)
}

console.log('== 弹窗式样统一守卫 ==')

if (files.length < MIN_VIEWS) {
  console.log(`  ✗ [1] 视图数=${files.length}，少于阈值 ${MIN_VIEWS} —— 疑似扫错目录，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [1] 扫过 ${files.length} 个视图`)

let css
try {
  css = readFileSync(mainCss, 'utf8')
} catch {
  console.log(`  ✗ [2] 读不到 ${mainCss}`)
  process.exit(1)
}
const hasMask = /^\.mask\s*\{/m.test(css)
const hasModal = /^\.modal\s*\{/m.test(css)
if (!hasMask || !hasModal) {
  console.log(`  ✗ [2] main.css 缺少公共定义：.mask=${hasMask} .modal=${hasModal} —— 抽取为空，守卫不可信`)
  process.exit(1)
}
console.log('  ✓ [2] main.css 已提供公共 .mask / .modal 定义')

const offenders = []
for (const f of files) {
  const src = readFileSync(join(viewsDir, f), 'utf8')
  const start = src.indexOf('<style')
  const end = src.indexOf('</style>')
  const style = start >= 0 && end > start ? src.slice(start, end) : ''
  if (/^\.mask\s*\{/m.test(style)) offenders.push(`${f}：重新定义了 .mask`)
  if (/^\.modal\s*\{/m.test(style)) offenders.push(`${f}：重新定义了 .modal`)
}

if (offenders.length) {
  console.log('  ✗ [3] 视图仍在重复定义基础弹窗式样（应统一取 main.css）：')
  for (const o of offenders) console.log(`       - ${o}`)
  process.exit(1)
}
console.log('  ✓ [3] 无视图重复定义 .mask / .modal（派生式样如 .modal.wide 不受限制）')

/* ── [4][5] 操作条真吸底 ──────────────────────────────────────────────
   教训（2026-11-09）：`.modal-foot` 曾只写 `margin-top: auto`，注释却写着「操作条
   吸底」——auto 只在内容不足一屏时把按钮推到底部，内容一溢出按钮照样滚走（实测
   「创建容器」内容 1262px / 视口 790px，按钮在 y=1258）。注释与行为不符，任何门禁
   都没发现，因为谁也没断言过它。故把这两条判据钉在这里：
   [4] 公共 .modal-foot 必须是 sticky，且 bottom 取 --modal-py 的负值（否则会浮在
       内边距上方 20px、下面漏一条正文穿出来）；
   [5] 不许再有组件用本地规则复刻操作条吸底（SiteFormDialog 曾有一条 scoped
       `.modal.wide .modal-actions { position: sticky }`，被同组件的 static 覆写压掉，
       从未生效——两套实现并存只会让人以为「某处还有一份」）。 */
function ruleBody(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm').exec(src)?.[1] ?? null
}

const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
const footBody = ruleBody(cssNoComments, '.modal-foot')
if (!footBody) {
  console.log('  ✗ [4] main.css 里找不到 .modal-foot 规则 —— 判据失效，守卫不可信')
  process.exit(1)
}
if (!/position\s*:\s*sticky/.test(footBody)) {
  console.log('  ✗ [4] .modal-foot 不是 sticky —— 长表单的操作条会跟着内容滚走（吸底失效）')
  process.exit(1)
}
if (!/bottom\s*:\s*calc\(\s*-1\s*\*\s*var\(--modal-py\)\s*\)/.test(footBody)) {
  console.log('  ✗ [4] .modal-foot 的 bottom 不是 --modal-py 的负值 —— 会浮在内边距上方、下方漏内容')
  process.exit(1)
}
const headBody = ruleBody(cssNoComments, '.modal-head')
if (!headBody || !/position\s*:\s*sticky/.test(headBody)) {
  console.log('  ✗ [4] .modal-head 不再是 sticky —— 长表单滚动时标题与关闭按钮会滚走')
  process.exit(1)
}
console.log('  ✓ [4] .modal-head / .modal-foot 均为 sticky（上下都吸）')

const stickyActions = []
for (const f of files) {
  const src = readFileSync(join(viewsDir, f), 'utf8')
  const start = src.indexOf('<style')
  const end = src.indexOf('</style>')
  const style = start >= 0 && end > start ? src.slice(start, end) : ''
  // 逐个 `.xxx .modal-actions {` 规则看有没有自己 sticky
  for (const m of style.matchAll(/([^{}]*\.modal-actions[^{}]*)\{([^}]*)\}/g)) {
    if (/position\s*:\s*sticky/.test(m[2])) stickyActions.push(`${f}：${m[1].trim().slice(0, 60)}`)
  }
}
const compDir = join(process.cwd(), 'src/components')
for (const f of readdirSync(compDir).filter((x) => x.endsWith('.vue'))) {
  const src = readFileSync(join(compDir, f), 'utf8')
  const start = src.indexOf('<style')
  const end = src.indexOf('</style>')
  const style = start >= 0 && end > start ? src.slice(start, end) : ''
  for (const m of style.matchAll(/([^{}]*\.modal-actions[^{}]*)\{([^}]*)\}/g)) {
    if (/position\s*:\s*sticky/.test(m[2])) stickyActions.push(`components/${f}：${m[1].trim().slice(0, 60)}`)
  }
}
if (stickyActions.length) {
  console.log('  ✗ [5] 有组件自行复刻「操作条吸底」（应统一用公共 .modal-foot）：')
  for (const s of stickyActions) console.log(`       - ${s}`)
  process.exit(1)
}
console.log('  ✓ [5] 无组件自行复刻操作条吸底（吸底只有 .modal-foot 一处实现）')

console.log('')
console.log('PASS：弹窗式样保持统一')

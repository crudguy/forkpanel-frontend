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
console.log('')
console.log('PASS：弹窗式样保持统一')

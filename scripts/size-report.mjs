/**
 * 体积报告：把"资源占用"变成可回归的约束。
 *
 * 三项判据，两硬一软：
 *   首屏（硬）   = `dist/index.html` 里被引用的全部 .js/.css（= 浏览器首屏必须下载的字节）
 *   单 chunk（硬）= 任一产物的 raw 体积（超过说明懒加载没切开）
 *   全量（两段）  = dist 所有产物 gzip 之和：超过 alert 只是警告，超过 hard 才失败
 *
 * ⚠ 首屏口径为什么改成"读 index.html"：
 *   旧口径是 `/^index|main/.test(f) || f.endsWith('.css')`——两头都错。
 *   ① **漏算**：`<link rel="modulepreload">` 的 vendor / vendor-vue 共 43.3KB 是首屏必须
 *      等待的字节，却因为文件名不含 index/main 被排除在外；
 *   ② **多算**：40 个按路由懒加载的视图 CSS（合计 39.4KB）只要拿到 `.css` 后缀就全算首屏，
 *      而它们随路由 chunk 才加载，根本不阻塞首屏。
 *   两处误差方向相反，净差 −11KB，于是报出来的 69.3KB 看上去"挺合理"——**判据测错了对象，
 *   数字却依然自洽**，这是最容易被当成没问题的一类错误。
 *   现在改成解析 index.html 里真实出现的资源引用，口径与被测对象物理同一。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = 'dist'
const ASSETS = join(DIST, 'assets')

let files = []
try { files = readdirSync(ASSETS) } catch {
  console.error('未找到 dist/assets，请先构建（pnpm build）')
  process.exit(2)
}

// ── 预算读取：缺键必须炸，不能静默降级 ────────────────────────────────
// 键名改过一次（`frontend_total_gzip_kb` → `_alert` / `_hard`）。若读取侧还按旧名取，
// `total > undefined` 恒为 false ⇒ 门禁一声不吭地失效，而报告照常打印（"配置项假控制"）。
// 所以这里显式校验四个键都是有限数，缺哪个就点名报哪个。
const budgets = JSON.parse(readFileSync('ci/budgets.json', 'utf8'))
const REQUIRED = [
  'frontend_first_screen_gzip_kb',
  'frontend_max_chunk_raw_kb',
  'frontend_total_gzip_kb_alert',
  'frontend_total_gzip_kb_hard',
]
const missing = REQUIRED.filter(k => !Number.isFinite(budgets[k]))
if (missing.length) {
  console.error(`ci/budgets.json 缺少（或非数值）以下预算键：${missing.join(', ')}`)
  console.error('门禁不能在没有预算的情况下"看起来通过"，请补齐后再跑。')
  process.exit(2)
}

const rows = []
let totalGzip = 0
for (const f of files) {
  const p = join(ASSETS, f)
  const raw = statSync(p).size
  const gz = gzipSync(readFileSync(p)).length
  totalGzip += gz
  rows.push({ file: f, raw, gzip: gz })
}

// ── 首屏：完全以 index.html 的引用为准 ────────────────────────────────
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const refs = [...new Set(
  [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map(m => m[0]),
)]
// 自检：解析出 0 个或只有一类资源 ⇒ 正则/产物结构变了。直接失败，
// 绝不能让"没解析到 ⇒ 首屏 0KB ⇒ 恒绿"。
const jsRefs = refs.filter(r => r.endsWith('.js'))
const cssRefs = refs.filter(r => r.endsWith('.css'))
if (jsRefs.length < 1 || cssRefs.length < 1) {
  console.error(`首屏资源解析异常：从 dist/index.html 只找到 ${jsRefs.length} 个 js / ${cssRefs.length} 个 css`)
  console.error('产物结构或本脚本的正则已变，请修脚本——不要放宽判据。')
  process.exit(2)
}
let firstScreenGzip = 0
const firstRows = []
for (const r of refs) {
  let raw
  try { raw = readFileSync(join(DIST, r)) } catch {
    console.error(`dist/index.html 引用了不存在的产物 ${r}（dist 与 index.html 不同步，请重新构建）`)
    process.exit(2)
  }
  const gz = gzipSync(raw).length
  firstScreenGzip += gz
  firstRows.push({ file: r.replace('/assets/', ''), gzip: gz })
}

// ── 单 chunk 上限 ────────────────────────────────────────────────────
// 单个文件过大意味着懒加载没切开。TerminalView 因 xterm 天然偏大（290KB raw），
// 预算是它 + 余量；真要瘦身应评估 xterm 的 WebGL addon 或把终端视图改成按需 import。
const maxChunkRawKb = budgets.frontend_max_chunk_raw_kb
const overChunks = rows.filter(r => r.raw / 1024 > maxChunkRawKb)

// ── 输出 ────────────────────────────────────────────────────────────
const kb = n => (n / 1024).toFixed(1)
rows.sort((a, b) => b.gzip - a.gzip)
console.log('file'.padEnd(46), 'raw'.padStart(10), 'gzip'.padStart(10))
for (const r of rows) {
  console.log(r.file.padEnd(46), String(r.raw).padStart(10), String(r.gzip).padStart(10))
}

console.log('---')
console.log(`首屏（硬，index.html 引用 ${refs.length} 个资源）：`)
for (const r of firstRows) {
  console.log(`    ${r.file.padEnd(40)} ${kb(r.gzip).padStart(8)} KB`)
}
console.log(
  `  合计 ${kb(firstScreenGzip)} KB  预算 ${budgets.frontend_first_screen_gzip_kb} KB` +
  `  余量 ${(budgets.frontend_first_screen_gzip_kb - firstScreenGzip / 1024).toFixed(1)} KB`,
)
console.log(`最大单 chunk（硬，raw）：${kb(Math.max(...rows.map(r => r.raw)))} KB  预算 ${maxChunkRawKb} KB`)
const totalKb = totalGzip / 1024
console.log(
  `全量（软）：${kb(totalGzip)} KB  警报线 ${budgets.frontend_total_gzip_kb_alert} KB` +
  ` / 兜底线 ${budgets.frontend_total_gzip_kb_hard} KB`,
)

// ── 判定 ────────────────────────────────────────────────────────────
const failures = []

if (firstScreenGzip / 1024 > budgets.frontend_first_screen_gzip_kb) {
  failures.push(
    `首屏 ${kb(firstScreenGzip)} KB > ${budgets.frontend_first_screen_gzip_kb} KB：` +
    '首屏字节直接决定用户等多久，不能抬额度，请减重（入口按需 import / 拆 vendor）',
  )
}
for (const r of overChunks) {
  failures.push(`单 chunk 超限：${r.file} raw ${kb(r.raw)} KB > ${maxChunkRawKb} KB（懒加载没切开）`)
}
if (totalKb > budgets.frontend_total_gzip_kb_hard) {
  failures.push(
    `全量 ${totalKb.toFixed(1)} KB > 兜底线 ${budgets.frontend_total_gzip_kb_hard} KB：` +
    '超过兜底线说明已经很久没人看体积了，请先定位增量来源',
  )
}

// 警报线只警告不失败：全量预算贴近现状时（曾只余 1.9KB）会逼人每次都抬额度，
// 反而训练出"看到红就改数字"的习惯。真正的硬约束交给首屏与单 chunk。
if (totalKb > budgets.frontend_total_gzip_kb_alert) {
  console.warn('')
  console.warn(`⚠ 全量已过警报线：${totalKb.toFixed(1)} KB > ${budgets.frontend_total_gzip_kb_alert} KB`)
  console.warn('   这不是门禁失败，但请确认增量来自预期改动。贡献最大的 5 个产物：')
  for (const r of rows.slice(0, 5)) {
    console.warn(`     ${r.file.padEnd(44)} ${kb(r.gzip).padStart(8)} KB gz`)
  }
}

if (failures.length) {
  console.error('')
  for (const f of failures) console.error(`超预算：${f}`)
  process.exit(1)
}
console.log('')
console.log('体积门禁通过（首屏 / 单 chunk 为硬判据，全量见上方软提示）')

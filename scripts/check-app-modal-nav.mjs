/**
 * 「新建应用」弹窗分区导航守卫（2026-11-16）
 *
 * 行为测试能挡住「导航不响应点击」，但挡不住另两类退化：
 *   ① 有人改了 navSections 的 id 却没改模板里的 <section id>，滚动定位静默失效；
 *   ② 有人把 @scroll / revealField 接线删掉，滚动高亮与错误定位全废，而 tsc/build
 *      与「导航项还在」的行为用例全绿。
 * 判据指向被检查的那份文件：声明、模板 section、事件接线、CSS 四者必须一致。
 *
 * 恒绿防护：先断言扫到目标文件与关键锚点各一次；末尾用三处负向变异自证——
 * 变异后必须报错，否则说明正则失效、守卫形同虚设。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REL = 'src/views/AppsView.vue'
const EXPECTED = [
  { id: 'sec-basic', label: '基础' },
  { id: 'sec-process', label: '进程配置' },
  { id: 'sec-hosting', label: '网站托管' },
  { id: 'sec-env', label: '环境变量' },
]
const FIELDS = ['name', 'runtime', 'port', 'workdir', 'exec_start', 'run_user', 'domains']

console.log('== 新建应用弹窗分区导航守卫 ==')
let src
try {
  src = readFileSync(join(process.cwd(), REL), 'utf8')
  if (!src.trim()) throw new Error('空文件')
} catch (e) {
  console.log(`  ✗ [1] 读不到 ${REL}（${e.message}）——不能静默跳过`)
  process.exit(1)
}

function count(hay, needle) { return hay.split(needle).length - 1 }

function check(s) {
  const bad = []
  const fail = (msg) => bad.push(msg)

  // [2] 分区声明：恰好一份，且四项 name/label 与登记表逐字一致
  const decl = /const navSections = \[([\s\S]*?)\] as const/.exec(s)?.[1] ?? null
  if (!decl) fail('[2] 找不到 navSections 声明（扫描口径失效或声明被删）')
  else {
    const pairs = [...decl.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
      .map(x => ({ id: x[1], label: x[2] }))
    if (pairs.length !== EXPECTED.length || pairs.some((p, i) => p.id !== EXPECTED[i].id || p.label !== EXPECTED[i].label)) {
      fail(`[2] navSections = ${JSON.stringify(pairs)}，应为 ${JSON.stringify(EXPECTED)}`)
    }
  }

  // [3] 模板 section：每个声明的 id 恰好对应一个 <section class="sector" id="…">
  for (const { id } of EXPECTED) {
    const n = count(s, `<section class="sector" id="${id}">`)
    if (n !== 1) fail(`[3] 模板里 id=${id} 的分区出现 ${n} 次（应为 1）`)
  }
  if (!/<div ref="modalBody" class="modal-body" @scroll="onBodyScroll">/.test(s)) {
    fail('[3] modal-body 的 @scroll="onBodyScroll" 接线缺失（滚动高亮会静默失效）')
  }
  if (!/@click="scrollToSec\(s\.id\)"/.test(s)) {
    fail('[3] 导航项的 @click="scrollToSec(s.id)" 接线缺失（点了没反应）')
  }
  if (count(s, '<nav class="nav-rail"') !== 1) fail('[3] nav-rail 不是恰好一个')
  // 末尾分区滚不到顶部，缺少点击后的短暂锁会被 onBodyScroll 把高亮弹回上一段
  if (!/navLockUntil = Date\.now\(\) \+ 600/.test(s) || !/Date\.now\(\) < navLockUntil/.test(s)) {
    fail('[3] 导航点击高亮的短暂锁缺失（末尾分区点了像没点中）')
  }

  // [4] 字段 → 分区映射与错误定位：字段名必须全部登记，且两个错误入口都接线
  const map = /const FIELD_SEC: Record<string, string> = \{([\s\S]*?)\}/.exec(s)?.[1] ?? ''
  for (const f of FIELDS) {
    if (!new RegExp(`\\b${f}:\\s*'sec-`).test(map)) fail(`[4] FIELD_SEC 缺字段 ${f}`)
  }
  if (!/function fieldSection\(key: string\)/.test(s)) fail('[4] fieldSection 纯函数缺失（env0/env1 会落不到环境变量段）')
  if (!/const secErrs = computed/.test(s)) fail('[4] secErrs 未由 fieldErrs 派生（红点不会随输入消失）')
  // 恰好 3 次：定义 + 前端校验入口 + 后端 detail.field 入口。少一次即某个入口被摘掉。
  const reveals = count(s, 'revealField(')
  if (reveals !== 3) {
    fail(`[4] revealField 出现 ${reveals} 次（应为 3：定义 + 两个错误入口）`)
  }

  // [5] CSS：必须**在 <style scoped> 块内**。曾踩过：样式被追加到 </style> 之后，
  // 全源文件扫描照样命中、守卫与构建全绿，真机却是 620×508 的旧弹窗、rail 横向塌陷。
  // 判据只查样式块的内容，块外出现再多次也不算数。
  const styleAt = s.indexOf('<style scoped>')
  const styleEnd = s.indexOf('</style>', styleAt)
  if (styleAt < 0 || styleEnd < 0) fail('[5] 找不到成对的 <style scoped> 块（CSS 判据会失效）')
  const css = styleAt >= 0 && styleEnd > styleAt ? s.slice(styleAt, styleEnd) : ''
  // 全屏 grid + rail + 分区两列 + 窄/矮窗转横向，缺一项都会让某档视口布局塌掉。
  // rail 与 sector 各出现 2 次：基础规则 + 媒体查询里的响应式覆写，两处都在才算完整。
  for (const [id, needle, want] of [
    ['全屏 grid', '.modal.wide.app-modal {', 1],
    ['rail（基础 + 响应式）', '.app-modal .nav-rail {', 2],
    ['分区网格（基础 + 响应式）', '.app-modal .modal-body .sector {', 2],
    ['错误红点', '.app-modal .nav-dot {', 1],
    ['响应式', '@media (max-width: 720px), (max-height: 600px) {', 1],
  ]) {
    if (count(css, needle) !== want) fail(`[5] <style> 块内 CSS ${id} 出现 ${count(css, needle)} 次（应为 ${want}）`)
  }
  return bad
}

const real = check(src)
if (real.length) {
  console.log('  ✗ 实际源码不满足：')
  for (const b of real) console.log(`      - ${b}`)
  process.exit(1)
}
console.log('  ✓ 分区声明 / 模板 section / 事件接线 / 错误映射 / CSS 五者一致')

// [6] 负向对照：三处变异必须各自变红，证明上面不是空转的恒绿判据
const mutants = [
  ['删滚动接线', s => s.replace('@scroll="onBodyScroll"', '@scroll="noop"')],
  ['改分区 id', s => s.replace('id: \'sec-env\'', 'id: \'sec-xxx\'')],
  ['删一个 section', s => s.replace('<section class="sector" id="sec-hosting">', '<section class="sector" id="gone">')],
  // 真实踩过的坑：CSS 被追加到 </style> 之后，源码里全都在，浏览器却一条都没加载。
  ['CSS 移出 style 块', s => s.replace('@media (max-width: 720px), (max-height: 600px) {', '\n</style>\n@media (max-width: 720px), (max-height: 600px) {')],
]
for (const [name, mutate] of mutants) {
  const m = mutate(src)
  if (m === src) {
    console.log(`  ✗ [6] 负向变异「${name}」没改到源码，自检口径失效`)
    process.exit(1)
  }
  if (!check(m).length) {
    console.log(`  ✗ [6] 负向变异「${name}」仍判绿——守卫是恒绿的，不可信`)
    process.exit(1)
  }
}
console.log(`  ✓ [6] ${mutants.length} 个负向变异全部变红（守卫非恒绿）`)

console.log('\nPASS：新建应用弹窗分区导航接线完整')

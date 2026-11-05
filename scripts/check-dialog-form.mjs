/**
 * 弹窗表单骨架必须只有一份（Q-09）
 *
 * CreateContainerDialog / StackEditorDialog 曾在各自 <style scoped> 里逐字复制
 * 18 行表单骨架（label 骨架 / 输入框 / 必填星号 / 焦点态）。现已搬到
 * styles/dialog-form.css，用 .dlg-form 命名空间挂在弹窗根节点上。改前/改后
 * 的 computed style 与几何逐字段对比见 .workbuddy/tmp/q09-css-*.json。
 *
 * 另外 4 个弹窗是**有意变体**（等宽 YAML 编辑 / 只有工具条 / 无 textarea /
 * 最简骨架），不接入共享类。本守卫把它们的集合钉住：既防止有人再抄出第 7 份
 * 骨架，也防止变体被误合并后登记表没跟着更新。
 *
 * 恒绿防护：登记表文件读不到或为空直接 fail；变体集合要求**恰好相等**，
 * 扫描正则一旦失效抓到 0 个就会因不等而 fail；共享规则条数有精确下限。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SHARED = 'src/styles/dialog-form.css'
const STANDARD = [
  'src/components/CreateContainerDialog.vue',
  'src/components/StackEditorDialog.vue',
]
const VARIANTS = [
  'ContainerLogsDialog.vue',
  'EditContainerDialog.vue',
  'PullImageDialog.vue',
  'StackImportDialog.vue',
]
const REQUIRED_RULES = [
  '.dlg-form label {',
  '.dlg-form label > span {',
  '.dlg-form label > span small {',
  '.dlg-form .req > span::after {',
  '.dlg-form small {',
  '.dlg-form input, .dlg-form textarea, .dlg-form select {',
  '.dlg-form textarea {',
  '.dlg-form input:focus-visible, .dlg-form textarea:focus-visible, .dlg-form select:focus-visible {',
]
const BONE_RE = [
  { re: /label\s*>\s*span/, name: 'label > span' },
  { re: /\.req\s*>\s*span::after/, name: '.req > span::after' },
  { re: /input\s*,\s*textarea\s*,\s*select\s*\{/, name: 'input, textarea, select {' },
  { re: /input:focus-visible/, name: 'input:focus-visible' },
]

console.log('== 弹窗表单骨架唯一性守卫 ==')
const bad = []

function read(rel) {
  try {
    const s = readFileSync(join(process.cwd(), rel), 'utf8')
    if (!s.trim()) throw new Error('空文件')
    return s
  } catch (e) {
    bad.push(`${rel}：读不到或为空（${e.message}）`)
    return ''
  }
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

// [1] 共享文件是唯一事实源：8 条规则各恰好一次，且不得在别处定义
const shared = read(SHARED)
if (shared) {
  for (const rule of REQUIRED_RULES) {
    const n = shared.split(rule).length - 1
    if (n !== 1) bad.push(`${SHARED}：规则 \`${rule}\` 出现 ${n} 次（应为 1）`)
  }
  const ruleCount = (shared.match(/^\.dlg-form[^{]*\{/gm) || []).length
  if (ruleCount !== REQUIRED_RULES.length) {
    bad.push(`${SHARED}：.dlg-form 规则共 ${ruleCount} 条（应为 ${REQUIRED_RULES.length}）`)
  }
}

const mainTs = read('src/main.ts')
if (mainTs) {
  const imports = (mainTs.match(/import '@\/styles\/dialog-form\.css'/g) || []).length
  if (imports !== 1) bad.push(`src/main.ts：dialog-form.css 引入 ${imports} 次（应为 1）`)
}

const srcRoot = join(process.cwd(), 'src')
const vueFiles = walk(srcRoot)
if (vueFiles.length < 50) bad.push(`src 下只扫到 ${vueFiles.length} 个 .vue（扫描链路失效？）`)

for (const f of vueFiles) {
  const body = readFileSync(f, 'utf8')
  if (/^\.dlg-form[^{]*\{/m.test(body)) {
    bad.push(`${f}：组件内又定义了 .dlg-form 规则（唯一事实源是 ${SHARED}）`)
  }
}

// [2] 两个标准弹窗：根节点挂类，scoped 段不得再有骨架副本
for (const rel of STANDARD) {
  const s = read(rel)
  if (!s) continue
  const a = s.indexOf('<style scoped>')
  const b = s.indexOf('</style>', a)
  if (a < 0 || b < 0) {
    bad.push(`${rel}：找不到 <style scoped> 段`)
    continue
  }
  const template = s.slice(0, a)
  if (!/class="[^"]*\bdlg-form\b[^"]*"/.test(template)) {
    bad.push(`${rel}：弹窗根节点没挂 dlg-form，共享样式不会命中`)
  }
  const style = s.slice(a, b)
  for (const { re, name } of BONE_RE) {
    if (re.test(style)) bad.push(`${rel}：scoped 段又出现骨架 \`${name}\``)
  }
}

// [3] 含骨架的 .vue 恰好是 4 个已知变体：多一个=又抄了，少一个=扫描失效或误合并
const boneFiles = vueFiles
  .filter((f) => /label\s*>\s*span/.test(readFileSync(f, 'utf8')))
  .map((f) => f.slice(f.lastIndexOf('/') + 1))
  .sort()
const want = [...VARIANTS].sort()
if (boneFiles.length !== want.length || boneFiles.some((f, i) => f !== want[i])) {
  bad.push(`含 \`label > span\` 的 .vue = [${boneFiles.join(', ')}]，登记表 = [${want.join(', ')}]；`
    + '新增复制骨架、把变体误合并、或扫描正则失效都会落到这里')
}

if (bad.length > 0) {
  console.log(`  ✗ ${bad.length} 条不满足：`)
  for (const b of bad) console.log(`      - ${b}`)
  console.log(`    改法：见 ${SHARED} 文件头。`)
  process.exit(1)
}

console.log(`  ✓ [1] ${SHARED} 独占 ${REQUIRED_RULES.length} 条骨架规则，main.ts 单点引入`)
console.log(`  ✓ [2] ${STANDARD.length} 个标准弹窗根节点挂 dlg-form、scoped 段无骨架副本`)
console.log(`  ✓ [3] 含 \`label > span\` 的 .vue 恰好是 ${want.length} 个已知变体（扫过 ${vueFiles.length} 个 .vue）`)

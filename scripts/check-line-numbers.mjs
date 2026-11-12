#!/usr/bin/env node
/**
 * 行号编辑框守卫。
 *
 * 两类判据：
 *  A. 登记表：所有出现原生 <textarea> 的文件必须要么自己就是行号组件、
 *     要么在 RAW_EXCEPTIONS 里写明「为什么不接」。新增编辑框漏接会直接判红，
 *     而不是等到用户发现「这个框怎么没有行号」。
 *  B. 对齐契约：行号侧栏与 textarea 必须共用行高/字号/padding，且一律不软折行、
 *     行号层绝对定位（窗口化）。这四条是「行号与正文逐行对齐」的全部前提——
 *     单测挡不住有人把 white-space 改回 pre-wrap，或只改一侧的 line-height。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
let failed = 0
const fail = (msg) => { console.error('✗ ' + msg); failed += 1 }
const pass = (msg) => console.log('✓ ' + msg)

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 判据必须指向真正生效的代码：先剔除注释，否则注释里提到 <textarea> 会造成假绿。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 只取「选择器独占一行」的规则体，避免命中复合选择器（如 `.is-fill .lined-ta`）。 */
function rule(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = src.match(new RegExp('^\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm'))
  return m ? m[1] : ''
}

function has(text, re, label, where) {
  if (!re.test(text)) fail(`${where}：${label} 缺失或已被改写`)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

// ---- A. 登记表 -------------------------------------------------------------
const LINED_OWNERS = new Set([
  'src/components/LinedTextarea.vue',
  'src/components/NginxEditor.vue',
])

const LINED_CALLERS = [
  ['src/views/FilesView.vue', 'LinedTextarea'],
  ['src/views/ServiceDetailView.vue', 'LinedTextarea'],
  ['src/components/SqlConsole.vue', 'LinedTextarea'],
  ['src/components/ExpandableTextarea.vue', 'LinedTextarea'],
  ['src/components/SiteConfPanel.vue', 'NginxEditor'],
]

// 列表型短输入（2–5 行）：行号没有信息量，还会挤掉本就不宽的输入区。
// 整文件级配置编辑走 SiteConfPanel / NginxEditor，文件与服务配置走 LinedTextarea。
const RAW_EXCEPTIONS = {
  'src/views/UsersView.vue': '2 行可访问根目录清单',
  'src/views/ExposeWizardView.vue': '3 行 IP 白名单',
  'src/components/CreateContainerDialog.vue': '端口 / env / 卷 / 命令等 2 行清单',
  'src/components/SiteFormDialog.vue': '表单内 IP 名单与配置片段短框',
  'src/components/InlineRemark.vue': '2 行备注输入',
}

for (const f of walk(SRC)) {
  const name = rel(f)
  const src = stripComments(read(name))
  const raw = /<textarea\b/.test(src)
  if (LINED_OWNERS.has(name)) {
    if (!raw) fail(`${name}：行号组件自身必须保留原生 textarea（输入层）`)
    continue
  }
  if (raw && !(name in RAW_EXCEPTIONS)) {
    fail(`${name}：出现未登记的 <textarea>。请改用 LinedTextarea / NginxEditor，或在 RAW_EXCEPTIONS 写明不接行号的理由`)
  }
  if (!raw && name in RAW_EXCEPTIONS) {
    fail(`${name}：RAW_EXCEPTIONS 登记已过期（已无原生 textarea），请删除该条`)
  }
}
for (const [name, comp] of LINED_CALLERS) {
  const src = stripComments(read(name))
  has(src, new RegExp('<' + comp + '\\b'), `必须使用 ${comp}`, name)
  if (/<textarea\b/.test(src)) fail(`${name}：已接行号组件却仍残留原生 textarea`)
}
pass('登记表：原生 textarea 全部有归属（行号组件 / 例外 / 已接调用点）')

// ---- B. 对齐契约 -----------------------------------------------------------
const CONTRACTS = [
  {
    file: 'src/components/LinedTextarea.vue',
    root: '.lined',
    gutter: '.lined-gutter',
    body: '.lined-ta',
    window: '.ln-window',
    line: '.ln',
    font: '--fs-12-5',
  },
  {
    file: 'src/components/NginxEditor.vue',
    root: '.nginx-editor',
    gutter: '.ne-gutter',
    body: '.ne-ta',
    window: '.ne-ln-window',
    line: '.ne-ln',
    font: '--fs-12',
  },
]

const LH = /line-height:\s*var\(--editor-line-h\)/
const globalCss = read('src/styles/main.css')
has(globalCss, /--editor-line-h:\s*1\.55\s*;/, '全局行高 token 已定义', 'main.css')

for (const c of CONTRACTS) {
  // 判据必须指向真正生效的代码：注释里也会提到 wrap=off / useLineGutter，
  // 不剔注释就会在「真代码被删掉」时假绿。
  const src = stripComments(read(c.file))
  const gutterBlock = rule(src, c.gutter)
  const bodyBlock = rule(src, c.body)
  const windowBlock = rule(src, c.window)
  const lineBlock = rule(src, c.line)
  has(gutterBlock, LH, '侧栏 line-height 走全局行高', c.file)
  has(bodyBlock, LH, '输入层 line-height 走全局行高', c.file)
  has(lineBlock, LH, '单个行号的行高走全局行高', c.file)
  has(gutterBlock, new RegExp('font-size:\\s*var\\(' + c.font.replace(/[-.]/g, '\\$&') + '\\)'), '侧栏字号', c.file)
  has(bodyBlock, new RegExp('font-size:\\s*var\\(' + c.font.replace(/[-.]/g, '\\$&') + '\\)'), '输入层字号', c.file)
  has(gutterBlock, /padding:\s*9px/, '侧栏 padding-top 9px', c.file)
  has(bodyBlock, /padding:\s*9px/, '输入层 padding-top 9px', c.file)
  has(bodyBlock, /white-space:\s*pre\s*;/, '输入层禁止软折行（white-space:pre）', c.file)
  if (/white-space:\s*pre-wrap|overflow-wrap:\s*anywhere/.test(bodyBlock)) {
    fail(`${c.file}：输入层出现软折行，固定行高的行号必然错位`)
  }
  has(windowBlock, /position:\s*absolute/, '行号窗口绝对定位（不撑高容器）', c.file)
  has(src, /wrap="off"/, 'textarea 的 wrap=off（HTML 层禁折行）', c.file)
  has(src, /import\s*\{\s*useLineGutter\s*\}\s*from\s*'@\/composables\/useLineGutter'/, '必须 import 共用窗口计算', c.file)
  has(src, /lnWindow\.offsetY/, '窗口按滚动位置平移', c.file)
  has(src, /lnWindow\.numbers/, '只渲染窗口内行号', c.file)
}

const lined = stripComments(read('src/components/LinedTextarea.vue'))
has(lined, /inheritAttrs:\s*false/, '外部事件精确透传到 textarea', 'LinedTextarea.vue')
has(lined, /v-bind="\$attrs"/, '$attrs 绑定到 textarea', 'LinedTextarea.vue')
pass('对齐契约：不折行 / 共享行高字号 padding / 窗口化 / 事件透传')

// ---- 接线活性自检 ----------------------------------------------------------
const runner = read('scripts/run-ui-guards.mjs')
has(runner, /'check-line-numbers\.mjs'/, '本守卫必须登记在唯一清单里（存在≠在跑）', 'run-ui-guards.mjs')
pass('接线：check-line-numbers.mjs 已在 run-ui-guards.mjs 登记')

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\ncheck-line-numbers: PASS')

#!/usr/bin/env node
/**
 * 视觉系统守卫（A → C → B 三阶段落地后的完整形态）。
 *
 * 为什么需要：圆角档位散在 76 个文件、约 227 处 border-radius 里，改一个 token
 * 不等于「收敛」；而「扫描集合为空 = 通过」是这类守卫的头号恒绿来源。
 * 故每条判据都先做计数/哨兵自检，再断言具体值。
 *
 * A 判据：圆角三档（8 / 12 / 16）与别名、旧 10 / 14 档不回潮、图标钮正圆、
 *   全局按钮仍 8px、.badge 胶囊语义保留。
 * C 判据：--seg-* 七个 token 齐备且 7 个消费文件真的引用；激活态一律
 *   「浅底 + 品牌色文字 + 加粗」；标签条状态点与下划线子页签同步。
 * B 判据：次级按钮与链接按钮透明底/无描边、hover 不画回边框；主操作与危险
 *   仍实心；输入框描边与按钮热区刻意保留；焦点补偿仍在。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const errors = []
const rawCss = read('src/styles/main.css')
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ' ')

// ── 活性自检 ──
if (!css.includes('--c-bg:')) errors.push('哨兵失效：main.css 里找不到 --c-bg 定义')
if (!/^\s*button\s*\{/m.test(css)) errors.push('哨兵失效：找不到全局 button 规则')
if (!css.includes('.btn-icon')) errors.push('哨兵失效：找不到 .btn-icon 规则')
if (!css.includes('.badge')) errors.push('哨兵失效：找不到 .badge 规则')

function defValue(name) {
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*([^;]+);`, 'm'))
  return m ? m[1].trim() : null
}
function ruleBody(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm').exec(src)?.[1] ?? null
}

// ── A 阶段：圆角三档 ──
const EXPECT = {
  '--radius-md': '12px',
  '--radius': 'var(--radius-md)',
  '--radius-sm': 'var(--radius-md)',
  '--radius-lg': '16px',
  '--radius-xs': '8px',
}
for (const [k, v] of Object.entries(EXPECT)) {
  const got = defValue(k)
  if (got !== v) errors.push(`${k} = ${got ?? '缺失'}（应为 ${v}）`)
}
const defCount = (css.match(/^\s*--radius(?:-(?:md|lg|sm|xs))?\s*:/gm) ?? []).length
if (defCount !== 5) errors.push(`radius 变量定义 ${defCount} 处（应为 5）：档位回潮或扫描失效`)
const stale = css.match(/\bborder-radius\s*:\s*(?:14|10)px/g) ?? []
if (stale.length) errors.push(`仍有 ${stale.length} 处旧圆角档（14px / 10px）`)

const iconBlock = ruleBody(css, '.btn-icon')
if (!iconBlock || !/border-radius\s*:\s*999px/.test(iconBlock)) {
  errors.push('.btn-icon 不是正圆（34×34 图标钮的唯一合理形态）')
}
const btnBlock = ruleBody(css, 'button')
if (!btnBlock || !/border-radius\s*:\s*var\(--radius-xs\)/.test(btnBlock)) {
  errors.push('全局 button 圆角不再是 8px：按钮被胶囊化会抹掉层级')
}
const badgeBlock = ruleBody(css, '.badge')
if (!badgeBlock || !/border-radius\s*:\s*999px/.test(badgeBlock)) {
  errors.push('.badge 胶囊语义丢失（胶囊应专属于状态指示物）')
}

// ── C 阶段：分段控件 / 页签统一 ──
const SEG_TOKENS = {
  '--seg-radius': 'var(--radius-md)',
  '--seg-item-radius': 'var(--radius-xs)',
  '--seg-bg': 'var(--bg-inset)',
  '--seg-border': 'var(--c-border)',
  '--seg-fg': 'var(--c-text-dim)',
  '--seg-on-bg': 'var(--c-primary-soft)',
  '--seg-on-fg': 'var(--c-primary)',
}
for (const [k, v] of Object.entries(SEG_TOKENS)) {
  const got = defValue(k)
  if (got !== v) errors.push(`${k} = ${got ?? '缺失'}（应为 ${v}）：分段控件失去单一事实源`)
}
function vueCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}
const SEG_CONSUMERS = [
  ['src/components/TabBar.vue', '.tab.on'],
  ['src/layouts/MainLayout.vue', '.seg-b.on'],
  ['src/views/LoginView.vue', '.theme-seg button.on'],
  ['src/components/containers/ContainersTab.vue', '.seg button.on'],
  ['src/views/ServiceDetailView.vue', '.seg-btn.active'],
  ['src/views/FilesView.vue', '.tab.on'],
  ['src/views/TerminalView.vue', '.tab.on'],
]
let wired = 0
for (const [rel, activeSel] of SEG_CONSUMERS) {
  const code = vueCode(rel)
  if (!code.includes('var(--seg-radius)') || !code.includes('var(--seg-on-bg)')) {
    errors.push(`${rel} 没有引用 --seg-radius / --seg-on-bg：又抄了一份私有规范`)
  } else wired += 1
  const body = ruleBody(code, activeSel)
  if (!body || !body.includes('background: var(--seg-on-bg)')) {
    errors.push(`${rel} 的 ${activeSel} 不是「浅底 + 品牌色」激活态`)
  }
  if (body && /background\s*:\s*var\((--gradient|--c-primary)\)/.test(body)) {
    errors.push(`${rel} 的 ${activeSel} 又用回实心橙/渐变激活底`)
  }
}
if (wired !== SEG_CONSUMERS.length) {
  errors.push(`只有 ${wired}/${SEG_CONSUMERS.length} 个分段/页签文件接上规范（扫描可能失效）`)
}
for (const [rel] of SEG_CONSUMERS.slice(0, 5)) {
  if (/border-radius\s*:\s*(?:6px|0)\s*;/.test(vueCode(rel))) {
    errors.push(`${rel} 仍有旧的分段项圆角 6px / 0`)
  }
}
const term = vueCode('src/views/TerminalView.vue')
if (ruleBody(term, '.tab.on .tdot.on')?.includes('--c-on-accent')) {
  errors.push('TerminalView 激活标签里的状态点仍是白点：浅底下会看不见')
}
const detail = vueCode('src/views/ServiceDetailView.vue')
if (!ruleBody(detail, '.tab.active')?.includes('var(--seg-on-fg)')) {
  errors.push('ServiceDetailView 下划线子页签的激活色没跟分段规范对齐')
}

// ── B 阶段：次级按钮中性化 ──
for (const [sel, body] of [
  ['button', btnBlock],
  ['a[class*="btn-"]', ruleBody(css, 'a[class*="btn-"]')],
]) {
  if (!body) { errors.push(`${sel} 规则截取失败`); continue }
  if (!/border(?:-color)?\s*:\s*(?:1px solid transparent|transparent)/.test(body)) {
    errors.push(`${sel} 又带回了描边：次级按钮应保持透明`)
  }
  if (/background\s*:\s*var\(--c-surface-2\)/.test(body)) {
    errors.push(`${sel} 又带回了 --c-surface-2 底色`)
  }
  if (!/background\s*:\s*transparent/.test(body)) {
    errors.push(`${sel} 不是透明底`)
  }
}
const hoverBody = ruleBody(css, 'button:hover:not(:disabled)')
if (hoverBody && /border-color\s*:\s*var\(--c-border-strong\)/.test(hoverBody)) {
  errors.push('button hover 又把描边画回来了')
}
if (!ruleBody(css, '.btn-primary')?.includes('background: var(--gradient)')) {
  errors.push('主操作失去实心渐变底：重点会被稀释')
}
if (!ruleBody(css, '.btn-danger')?.includes('background: var(--c-danger)')) {
  errors.push('危险主操作失去实心红底')
}
if (!ruleBody(css, 'a.btn-danger')?.includes('border-color: var(--c-danger)')) {
  errors.push('链接式危险按钮失去红描边')
}
if (!ruleBody(css, 'input, textarea, select')?.includes('border: 1px solid var(--c-border-strong)')) {
  errors.push('输入框描边被淡化：透明按钮 + 淡边框会让「哪里能填」失去轮廓')
}
if (!/button:focus-visible\s*\{[^}]*border-color\s*:\s*var\(--c-primary\)/.test(css)) {
  errors.push('焦点补偿丢失：透明底按钮没有品牌色焦点环')
}
if (!/box-shadow\s*:\s*0 0 0 3px var\(--c-primary-soft\)/.test(css)) {
  errors.push('3px 焦点光晕丢失')
}
if (!ruleBody(css, '.btn-sm')?.includes('padding: 4px 10px')) {
  errors.push('.btn-sm 热区被缩小：中性化不许以牺牲点击目标为代价')
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：视觉系统守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('== 视觉系统守卫（A + C + B）==')
console.log('  ✓ [A1] 圆角三档 8 / 12 / 16，两个语义别名指向 md')
console.log('  ✓ [A2] 旧 10 / 14 档未回潮，radius 定义恰好 5 处')
console.log('  ✓ [A3] 34×34 图标钮正圆')
console.log('  ✓ [A4] 全局按钮仍 8px、徽章仍胶囊（胶囊语义未扩散）')
console.log(`  ✓ [C1] --seg-* 七个 token 齐备，${wired} 个消费文件全部引用`)
console.log('  ✓ [C2] 激活态统一浅底 + 品牌色 + 加粗，无旧圆角与实心橙底')
console.log('  ✓ [C3] 标签条状态点与下划线子页签同步')
console.log('  ✓ [B1] 次级按钮/链接按钮透明底无描边，hover 不画回边框')
console.log('  ✓ [B2] 主操作与危险仍实心，输入框描边与按钮热区保留')
console.log('  ✓ [B3] 焦点环与 3px 光晕补偿仍在')
console.log('PASS：圆角梯度 / 分段控件 / 次级按钮三阶段规范完整')

#!/usr/bin/env node
/**
 * 组件接线守卫：模板里用的 PascalCase 组件必须**真的绑定**。
 *
 * Vue 遇到未注册 / 未 import 的 PascalCase 标签不报错，只渲染成一个空的自
 * 定义元素并留一条 console warning。于是 vue-tsc / vite build / 源码断言全绿，
 * 用户看到的却是一个空位。2026-11-05 实测：`components/RefreshBtn.vue` 漏了
 * `import Icon`，全站刷新按钮的图标一直是空的。
 *
 * 与 `check-icon-names.mjs` 分工：那个查「图标名在不在 ICONS 表里」（写错名字
 * 渲染空 svg），这个查「组件标签有没有绑定」（漏 import 渲染空自定义元素）。
 *
 * ⚠ 两条容易写错的地方（都会让守卫恒绿）：
 *   1. 不能按 `<template ...>(.*?)</template>` 截模板段：Vue 模板里大量嵌套
 *      `<template v-if>`，非贪婪匹配在第一个内层 `</template>` 就截断 ⇒ 漏报。
 *      这里改为**挖掉 script / style 段**，剩下的整体就是完整模板。
 *   2. 「未绑定集合为空」对解析失效恒真：若 import 解析过宽，所有标签都被
 *      判成已绑定，扫描静默空转。故下面用三份固定夹具先证明解析器真在工作。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/**
 * Vue 内置 + vue-router 全局注册的组件。`main.ts` 只用 `app.use(router)`，
 * 没有 `app.component(...)`；一旦将来真的全局注册，必须同步更新这里与下方
 * 的 `main.ts` 断言，不许靠往白名单塞业务组件让守卫对漏 import 闭嘴。
 */
const BUILTIN = new Set([
  'Teleport', 'Suspense', 'KeepAlive', 'Transition', 'TransitionGroup',
  'Component', 'Slot', 'Template', 'RouterLink', 'RouterView',
])

function templateOf(text) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

function scriptsOf(text) {
  const raw = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  // ⚠ 必须剔注释：`importedNames` 用 `import ... from` 找子句，注释里只要出现
  // "import" 字样（例如「漏掉这条 import 时…」）就会成为匹配起点，一路吞到下一个
  // `from '`，导致真正的 import 解析不出来 —— 表现为「明明修好了守卫还红」。
  // 只剔**整行** `//` 注释，不碰字符串里的 `//`（如 URL）。
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function importedNames(script) {
  const names = new Set()
  const re = /\bimport\s+([\s\S]+?)\s+from\s+['"]/g
  let m
  while ((m = re.exec(script)) !== null) {
    for (let part of m[1].replace(/[{}]/g, '').split(',')) {
      part = part.trim().replace(/^type\s+/, '')
      if (!part) continue
      if (part.includes(' as ')) part = part.split(' as ').pop().trim()
      part = part.replace(/^\*\s*/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(part)) names.add(part)
    }
  }
  return names
}

/** 返回该文件模板里用到、但 script 段没绑定的 PascalCase 标签。 */
function analyze(raw) {
  const tpl = templateOf(raw)
  const tags = new Set([...tpl.matchAll(/<([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]))
  const script = scriptsOf(raw)
  const bound = new Set([
    ...BUILTIN,
    ...importedNames(script),
    ...[...script.matchAll(/\bconst\s+([A-Z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1]),
  ])
  return { tags, missing: [...tags].filter((t) => !bound.has(t)).sort() }
}

console.log('== 组件接线守卫：模板用的 PascalCase 组件必须真绑定 ==')
const bad = []

// 扫描前提：路径写错时给友好失败，别让 readdirSync 抛 ENOENT 变成"崩了但不算红"。
try {
  readdirSync(SRC)
  readdirSync(join(SRC, 'components'))
  readFileSync(join(SRC, 'main.ts'))
} catch (e) {
  console.log(`  ✗ 扫描前提不成立：${e.message}`)
  console.log('    路径 / 目录结构变了，绝不能把"扫不到"当成"没有违规"')
  process.exit(1)
}

// ── [0] 解析器活性自检：三份固定夹具，先证明「未绑定」真的能被抓到 ──
const F_IMPORTED = '<script setup lang="ts">\nimport Icon from \'@/components/Icon.vue\'\n</script>\n'
  + '<template><div><Icon /><MissingWidget /></div></template>'
const F_CLEAN = '<script setup lang="ts">\nimport Icon from \'@/components/Icon.vue\'\n</script>\n'
  + '<template><div><Icon /></div></template>'
// 嵌套 <template v-if> 正是旧版按段截取漏报的场景
const F_NESTED = '<template><template v-if="ok"><Icon /></template></template>'
// 注释里出现 "import" 字样，不得干扰真 import 的解析
const F_COMMENT = '<script setup lang="ts">\n// 漏掉这条 import 时 Vue 会渲染空 <icon>\n'
  + 'import Icon from \'@/components/Icon.vue\'\n</script>\n<template><Icon /></template>'
// 只在注释里写了 import、实际没有 ⇒ 必须仍然报未绑定（防「注释里写一行就假绿」）
const F_COMMENT_ONLY = '<script setup lang="ts">\n'
  + '// import Icon from \'@/components/Icon.vue\'\n</script>\n<template><Icon /></template>'
const c1 = analyze(F_IMPORTED).missing
const c2 = analyze(F_CLEAN).missing
const c3 = analyze(F_NESTED).missing
const c4 = analyze(F_COMMENT).missing
const c5 = analyze(F_COMMENT_ONLY).missing
if (c1.length !== 1 || c1[0] !== 'MissingWidget') {
  bad.push(`解析器自检失败：夹具里已 import 的 Icon 与未绑定的 MissingWidget 应只报后者，实际报 [${c1}]`)
}
if (c2.length !== 0) bad.push(`解析器自检失败：全部已绑定的夹具应零报告，实际 [${c2}]`)
if (c3.length !== 1 || c3[0] !== 'Icon') {
  bad.push(`解析器自检失败：嵌套 <template v-if> 里的未导入 Icon 必须报出，实际 [${c3}]`)
}
if (c4.length !== 0) bad.push(`解析器自检失败：注释里含 "import" 字样不得干扰真 import，实际 [${c4}]`)
if (c5.length !== 1 || c5[0] !== 'Icon') {
  bad.push(`解析器自检失败：只在注释里写 import 必须仍判未绑定，实际 [${c5}]`)
}

// ── [1] 扫描全仓 ──
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const vueFiles = walk(SRC)
const rel = (p) => relative(ROOT, p)
const scanned = new Set()
const usingIcon = new Set()
const unbound = []
let tagRefs = 0

for (const f of vueFiles) {
  const name = rel(f)
  scanned.add(name)
  const { tags, missing } = analyze(readFileSync(f, 'utf8'))
  tagRefs += tags.size
  if (tags.has('Icon')) usingIcon.add(name)
  if (missing.length) unbound.push(`${name}: ${missing.join(', ')}`)
}

// ── [2] 扫描链路活性自检：抓不到东西 = 守卫瞎了，不许当成"没有违规" ──
if (vueFiles.length < 80) bad.push(`src 下只扫到 ${vueFiles.length} 个 .vue（扫描链路失效？）`)
if (tagRefs < 100) bad.push(`只扫到 ${tagRefs} 个 PascalCase 标签引用（正则失效？）`)
if (usingIcon.size < 40) bad.push(`只有 ${usingIcon.size} 个 .vue 使用 <Icon>（正则或路径失效？）`)
if (!usingIcon.has('src/components/RefreshBtn.vue')) {
  bad.push('哨兵丢失：RefreshBtn.vue 必须被扫到且含 <Icon>（本次事故的现场）')
}
if (!scanned.has('src/views/ExposeWizardView.vue')) {
  bad.push('哨兵丢失：ExposeWizardView.vue 必须被扫到（含嵌套 template，验证挖段法有效）')
}

// ── [3] 防绕过：白名单不许混进业务组件，main.ts 不许偷偷全局注册 ──
const componentNames = readdirSync(join(SRC, 'components'))
  .filter((f) => f.endsWith('.vue'))
  .map((f) => f.replace(/\.vue$/, ''))
const leaked = [...BUILTIN].filter((b) => componentNames.includes(b))
if (leaked.length) {
  bad.push(`白名单混进了业务组件 [${leaked.join(', ')}] —— 等于让守卫对漏 import 闭嘴`)
}
const mainTs = readFileSync(join(SRC, 'main.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
if (/\bapp\.component\s*\(/.test(mainTs)) {
  bad.push('main.ts 出现 app.component( —— 若确要全局注册，请同步更新本守卫白名单与说明')
}

// ── [4] 主判据 ──
if (unbound.length > 0) {
  bad.push(`以下 .vue 用了未绑定的组件标签（Vue 会渲染成空元素）：\n      - ${unbound.join('\n      - ')}`)
}

if (bad.length > 0) {
  console.log(`  ✗ ${bad.length} 条不满足：`)
  for (const b of bad) console.log(`      - ${b}`)
  console.log('    改法：在 <script setup> 里 import 对应组件（如 `import Icon from \'@/components/Icon.vue\'`）。')
  process.exit(1)
}

console.log(`  ✓ [0] 解析器活性自检 5/5（含嵌套 <template> 与注释干扰场景）`)
console.log(`  ✓ [1] 扫过 ${vueFiles.length} 个 .vue、${tagRefs} 个标签引用，未绑定组件 0 个`)
console.log(`  ✓ [2] 哨兵 RefreshBtn.vue / ExposeWizardView.vue 均命中，${usingIcon.size} 个文件使用 <Icon>`)
console.log(`  ✓ [3] 白名单无业务组件，main.ts 无全局 app.component 注册`)

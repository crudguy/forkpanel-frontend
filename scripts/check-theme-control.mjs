#!/usr/bin/env node
/**
 * 主题控制接线守卫。
 *
 * 为什么需要：`'system'` 曾只存在于类型里，UI 却是二态 toggle —— 用户永远切不到
 * 「跟随系统」，是典型的「配置项假控制」；登录页也没有任何切换入口。这类接线缺失
 * vue-tsc / vite build / 单测全绿，行为测试只能证明函数本身对，证明不了 UI 接上了。
 *
 * 判据（全部指向被检查的那份文件，断言前剔注释）：
 *   ① THEME_OPTIONS 恰好三态且含 system，每项 icon 都在 Icon.vue 的图标表里
 *   ② getTheme 走白名单校验且 dark 兜底；setTheme 更新单例并 apply；
 *      themeMode 全局只定义一份；cycleTheme（盲切快捷钮专用）不得复活
 *   ③ MainLayout 里主题入口**恰好一处**（用户菜单三段控件）：不得回退二态，
 *      也不得再加回顶栏循环快捷钮（三态循环无法指定目标档，纯重复）
 *   ④ LoginView 有三态入口，且控件在 .login 根层、所有 v-if 表单之外
 *      （缩进层级 + 全模板次数 == 根层级次数，只数标签会恒绿）
 *
 * ⚠ 先做活性自检：路径或正则失效抓到空集时，「未覆盖 = 空 = 通过」会恒绿。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const errors = []

/** 剔行注释、块注释与 HTML 注释；保留字符串原文（选择器/图标名要留着）。 */
function stripComments(s) {
  const out = []
  let i = 0
  let state = null
  while (i < s.length) {
    const c = s[i]
    if (state === null) {
      if (s.startsWith('//', i)) { state = 'line'; i += 2; out.push(' '); continue }
      if (s.startsWith('/*', i)) { state = 'block'; i += 2; out.push(' '); continue }
      if (s.startsWith('<!--', i)) { state = 'html'; i += 4; out.push(' '); continue }
      if (c === "'" || c === '"' || c === '`') { state = c; out.push(c); i += 1; continue }
      out.push(c); i += 1
    } else if (state === 'line') {
      if (c === '\n') { state = null; out.push(c) } else out.push(' ')
      i += 1
    } else if (state === 'block' || state === 'html') {
      const end = state === 'block' ? '*/' : '-->'
      if (s.startsWith(end, i)) { state = null; i += end.length; continue }
      out.push(c === '\n' ? '\n' : ' '); i += 1
    } else {
      out.push(c)
      if (c === '\\') { if (i + 1 < s.length) { out.push(s[i + 1]); i += 2; continue } }
      if (c === state) state = null
      i += 1
    }
  }
  return out.join('')
}

/** 按花括号配对截函数体；找不到返回 null，绝不返回 '' 冒充空块。 */
function blockAt(src, selector) {
  const i = src.indexOf(selector)
  if (i < 0) return null
  const open = src.indexOf('{', i)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}' && --depth === 0) return src.slice(open + 1, j)
  }
  return null
}

const themeTs = stripComments(read('src/composables/theme.ts'))
const layout = stripComments(read('src/layouts/MainLayout.vue'))
const login = stripComments(read('src/views/LoginView.vue'))
const iconVue = stripComments(read('src/components/Icon.vue'))

const ICONS = new Set(
  [...iconVue.matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:/gm)].map((m) => m[1]),
)

// ── 活性自检 ──
if (ICONS.size < 30) errors.push(`图标表只解析到 ${ICONS.size} 个（期望 ≥30）：Icon.vue 结构或正则失效`)
if (!themeTs.includes('THEME_OPTIONS')) errors.push('哨兵失效：theme.ts 找不到 THEME_OPTIONS')
if (!layout.includes('class="menu"')) errors.push('哨兵失效：MainLayout 找不到用户菜单')
if (!login.includes('class="login"')) errors.push('哨兵失效：LoginView 找不到 .login 根')
if (layout.includes('v-for="o in DENSITY_OPTIONS"') === false) {
  errors.push('哨兵失效：MainLayout 里找不到既有的密度分段控件（扫描范围可能不对）')
}

// ① 三态选项与图标有效性
// ⚠ 不能用「声明起点后的第一个 ]」截块：类型注解里的 `}[]` 就是那个 ]，
//    会把数组体整个截没（实测 value / icon 都解析到 0 项，看起来像「没写」）。
const optMatch = themeTs.match(/export const THEME_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\]/)
const optBlock = optMatch ? optMatch[1] : null
if (optBlock === null) {
  errors.push('截取不到 THEME_OPTIONS 数组')
} else {
  const values = [...optBlock.matchAll(/value:\s*'([a-z]+)'/g)].map((m) => m[1])
  const want = ['dark', 'light', 'system']
  if (values.length !== 3 || want.some((v) => !values.includes(v))) {
    errors.push(`THEME_OPTIONS 的 value 为 [${values.join(', ')}]（应为 ${want.join(', ')}）：system 不许被删`)
  }
  const icons = [...optBlock.matchAll(/icon:\s*'([a-z-]+)'/g)].map((m) => m[1])
  if (icons.length !== 3) errors.push(`THEME_OPTIONS 的 icon 解析到 ${icons.length} 项（应为 3）`)
  for (const ic of icons) {
    if (!ICONS.has(ic)) errors.push(`THEME_OPTIONS 的图标 '${ic}' 不在 Icon.vue 表里（会渲染空图标）`)
  }
}

// ② 单一状态源与写入链路
const getBlock = blockAt(themeTs, 'function getTheme')
if (!getBlock || !/isThemeMode/.test(getBlock) || !/:\s*'dark'/.test(getBlock)) {
  errors.push('getTheme 缺「白名单校验 + dark 兜底」：脏 localStorage 会变成无人匹配的 data-theme')
}
const setBlock = blockAt(themeTs, 'function setTheme')
if (!setBlock || !/isThemeMode\(mode\)/.test(setBlock) ||
    !/themeMode\.value\s*=\s*mode/.test(setBlock) || !/applyTheme\(\)/.test(setBlock)) {
  errors.push('setTheme 没有「校验 + 更新单例 + 重新应用」三件套：UI 选中态会与 DOM 分叉')
}
// cycleTheme 的唯一消费方（顶栏循环快捷钮）已删：留着它就是无消费方的死导出，
// 还会诱导人再造一个「循环」入口。要恢复循环交互，须同时改本守卫与该行注释。
if (/cycleTheme/.test(themeTs)) errors.push('theme.ts 又出现 cycleTheme：消费方已删，属死代码')
const modeDefs = themeTs.match(/export const themeMode\s*=\s*ref</g) ?? []
if (modeDefs.length !== 1) errors.push(`themeMode 单例定义 ${modeDefs.length} 处（应为 1）`)
for (const [name, code] of [['MainLayout.vue', layout], ['LoginView.vue', login]]) {
  if (/const themeMode\s*=\s*ref/.test(code)) {
    errors.push(`${name} 自己又持了一份 themeMode ref：两处选中态会互相覆盖`)
  }
}

// ③ 主题入口恰好一处（用户菜单）。本类问题的退化方式就是「再加一个入口」，
//    「接上了 setTheme」对重复入口完全无感 ⇒ 必须数次数，不能只断言存在。
if (/toggleTheme/.test(layout)) errors.push('MainLayout 又出现 toggleTheme：三态会被打回二态假控制')
if (/\?\s*'light'\s*:\s*'dark'/.test(layout)) errors.push('MainLayout 又出现二态三元切换')
if (/cycleTheme/.test(layout)) errors.push('顶栏循环快捷钮被加回来了：三态循环无法指定目标档，与菜单里的同一偏好重复')
const writePts = (layout.match(/@click="setTheme\(o\.value\)"/g) ?? []).length
if (writePts !== 1) errors.push(`MainLayout 的主题写入点 ${writePts} 处（应为 1）：多出来的就是重复入口`)
const segLoops = (layout.match(/v-for="o in THEME_OPTIONS"/g) ?? []).length
if (segLoops !== 1) errors.push(`MainLayout 的 THEME_OPTIONS 分段控件 ${segLoops} 处（应为 1）`)
if (!layout.includes('id="theme-mode-label"')) errors.push('用户菜单缺「主题」分组标签')
if (!/themeMode\s*===\s*o\.value/.test(layout)) errors.push('用户菜单没用共享 themeMode 表达选中态')

// ④ 登录页三态入口 + 根层缩进（挪进 v-if 块内时编译与单测都不报错，真机才看不到）
if (!login.includes('v-for="o in THEME_OPTIONS"')) errors.push('登录页没遍历 THEME_OPTIONS')
if (!login.includes('@click="setTheme(o.value)"')) errors.push('登录页主题按钮没接 setTheme')
if (!/themeMode\s*===\s*o\.value/.test(login)) errors.push('登录页没用共享 themeMode 表达选中态')
const allSeg = (login.match(/<div class="theme-seg"/g) ?? []).length
const rootSeg = (login.match(/^    <div class="theme-seg"/gm) ?? []).length
if (allSeg !== 1 || rootSeg !== 1) {
  errors.push(`登录页 .theme-seg 出现 ${allSeg} 次、根层 ${rootSeg} 次（各应为 1）：可能被挪进 v-if 块`)
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：主题控制接线守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('== 主题控制接线守卫 ==')
console.log('  ✓ [1] THEME_OPTIONS 恰好三态含 system，图标名有效')
console.log('  ✓ [2] 白名单校验 / 单例 / setTheme 链路齐备，cycleTheme 未复活')
console.log('  ✓ [3] 主题入口恰好一处（用户菜单），无二态 / 无顶栏循环钮')
console.log('  ✓ [4] 登录页三态入口在 .login 根层、v-if 表单之外')
console.log('PASS：主题控制三态接线完整')

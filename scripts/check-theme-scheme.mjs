#!/usr/bin/env node
/**
 * 主题声明 / 浏览器原生控件配色守卫。
 *
 * 为什么需要：这类声明「删了不报错」——vue-tsc、vite build、单测全绿，只有真机
 * 首屏闪一下浅色、或登录页被密码管理器填成淡蓝白框时才暴露。行为测试触碰不到
 * 浏览器 UA 样式，只能在源码层钉住。
 *
 * 判据（全部指向被检查的那份文件，断言前剔注释）：
 *   ① index.html 的 <html> 不得写死 data-theme（静态首屏与运行时默认必须同向）
 *   ② main.css 的 :root / [data-theme='light'] 各有一处 color-scheme，且剔注释后
 *      全文件声明恰好 2 处 —— 先钉住「扫描抓到了」，再钉住「别处为 0」
 *   ③ theme.ts 的 getTheme 走白名单校验且默认 'dark'（静态 :root 是暗色，不能分叉）
 *   ④ 自动填充兜底规则含三条关键声明，且不含 box-shadow（会顶掉 :focus-visible
 *      的 3px 焦点环）；焦点环本身也必须还在
 *
 * ⚠ 扫描式守卫先做活性自检：路径或正则一旦失效抓到空集，「未覆盖 = 空 = 通过」
 *   会变成恒绿，比没有守卫更危险。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const errors = []

/** 剔行注释、块注释与 HTML 注释；保留字符串原文（选择器里的引号要留着）。 */
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

/** 从 selector 之后按花括号配对截块；找不到返回 null，绝不返回 '' 冒充空块。 */
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

const html = stripComments(read('index.html'))
const css = stripComments(read('src/styles/main.css'))
const themeTs = stripComments(read('src/composables/theme.ts'))

// ── 活性自检：证明三份文件都读到了、截块确实抓到了内容 ──
if (!css.includes('--c-bg:')) errors.push('哨兵失效：main.css 里找不到 --c-bg 定义')
if (!css.includes('input, textarea, select')) errors.push('哨兵失效：找不到基础控件规则')
if (!/<html\b/.test(html)) errors.push('哨兵失效：index.html 里找不到 <html> 标签')
if (!themeTs.includes('getTheme')) errors.push('哨兵失效：theme.ts 里找不到 getTheme')
const rootBlock = blockAt(css, ':root')
const lightBlock = blockAt(css, ":root[data-theme='light']")
if (!rootBlock || !rootBlock.includes('--c-bg:')) errors.push('活性自检：:root 块截取失败或内容不符')
if (!lightBlock || !lightBlock.includes('--c-bg:')) errors.push('活性自检：light 块截取失败或内容不符')

// ① 静态 HTML 不得写死主题，否则 CSS 先按浅色画一帧、JS 再改深（首屏闪）
const htmlTag = html.match(/<html\b[^>]*>/)?.[0] ?? ''
if (!htmlTag) errors.push('index.html 里解析不出 <html> 标签')
else if (/data-theme/.test(htmlTag)) {
  errors.push('index.html 的 <html> 又写死了 data-theme：静态值与运行时默认值会打架')
}

// ② 两套主题各自的原生控件配色；全文件恰好 2 处（防漏写、防重复写、防扫描空转）
if (rootBlock && !/color-scheme\s*:\s*dark\s*;/.test(rootBlock)) {
  errors.push(':root 块里缺 color-scheme: dark（浏览器会按 light 渲染自动填充）')
}
if (lightBlock && !/color-scheme\s*:\s*light\s*;/.test(lightBlock)) {
  errors.push(':root[data-theme=light] 块里缺 color-scheme: light')
}
const schemeDecls = css.match(/\bcolor-scheme\s*:/g) ?? []
if (schemeDecls.length !== 2) {
  errors.push(`剔注释后 color-scheme 声明共 ${schemeDecls.length} 处（应为 2）：漏写、重复或扫描失效`)
}

// ③ 静态首屏是 :root 的暗色，运行时默认必须同向
const getThemeBlock = blockAt(themeTs, 'function getTheme')
if (!getThemeBlock || !/isThemeMode/.test(getThemeBlock) || !/:\s*'dark'/.test(getThemeBlock)) {
  errors.push('theme.ts 的 getTheme 缺「白名单校验 + dark 兜底」：会与静态 :root 的暗色首屏分叉')
}

// ④ 自动填充兜底 + 焦点环保全
const afStart = css.indexOf('input:-webkit-autofill')
const afOpen = afStart < 0 ? -1 : css.indexOf('{', afStart)
const afEnd = afOpen < 0 ? -1 : css.indexOf('}', afOpen)
const afBody = afEnd < 0 ? null : css.slice(afOpen + 1, afEnd)
if (afBody === null) {
  errors.push('找不到 input:-webkit-autofill 兜底规则')
} else {
  if (!afBody.includes('-webkit-text-fill-color: var(--c-text)')) {
    errors.push('自动填充兜底缺 -webkit-text-fill-color：UA 会强制把字变黑')
  }
  if (!afBody.includes('background-color: var(--c-bg) !important')) {
    errors.push('自动填充兜底缺 background-color: var(--c-bg) !important：压不住 UA 的浅色底')
  }
  if (!afBody.includes('color: var(--c-text) !important')) {
    errors.push('自动填充兜底缺 color: var(--c-text) !important')
  }
  if (afBody.includes('box-shadow')) {
    errors.push('自动填充兜底用了 box-shadow：会顶掉 :focus-visible 的 3px 焦点环')
  }
}
if (!css.includes('input:-webkit-autofill:focus')) {
  errors.push('自动填充兜底没有覆盖 :focus 变体（聚焦后 UA 样式会再次生效）')
}
if (!css.includes('box-shadow: 0 0 0 3px var(--c-primary-soft)')) {
  errors.push('全局 :focus-visible 的 3px 焦点环不见了')
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：主题配色守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('== 主题声明 / 自动填充兜底守卫 ==')
console.log('  ✓ [1] index.html 未写死 data-theme（静态首屏与运行时默认同向）')
console.log('  ✓ [2] :root=dark / light=light，全文件 color-scheme 恰好 2 处')
console.log('  ✓ [3] theme.ts 的 getTheme 有白名单校验且默认 dark')
console.log('  ✓ [4] 自动填充兜底三条声明齐备、无 box-shadow，焦点环仍在')
console.log('PASS：主题声明与自动填充兜底完整')

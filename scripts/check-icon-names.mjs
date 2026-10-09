#!/usr/bin/env node
/**
 * 图标名守卫：`components/Icon.vue` **不是**全局注册的，每个模板里的 `name="x"`
 * 都靠同名 prop 命中 ICONS 表。
 *
 * 为什么必须有这个门禁：写错图标名（或用了不存在的名字）**不会报错**——
 * Vue 只是渲染一个空的 `<svg>`，视觉上表现为「图标位置一片空白」，
 * 只有肉眼逐个页面比对才能发现。vue-tsc / vite build 全绿。
 * 这与「`Icon` 组件漏 import` 一样静默」，属同一类高性价比的静态守卫目标。
 *
 * 扫两处来源：
 *   1. `icon: 'x'`   —— SideNav 等数组式配置
 *   2. `name="x"`    —— 模板里直接传给 `<Icon>` 的静态 name
 * 只取字面量（动态 `:name="expr"` 无法静态判定，故跳过）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ICONS_FILE = join(root, 'src/components/Icon.vue')
const SCAN_DIRS = ['src/views', 'src/components', 'src/layouts']

/** 允许的例外：这些名字不是图标（自定义组件的 name / HTML 元素 name 属性等） */
const ALLOW = new Set([
  // Icon.vue 自身内部的注册与映射
  'Icon',
])

function readIcons() {
  const src = readFileSync(ICONS_FILE, 'utf8')
  const names = new Set()
  // ICONS 表里的键形如 `  play: `在对象字面量里，缩进 2
  const re = /^\s{2}'?([a-z][a-z0-9-]*)'?:/gm
  let m
  while ((m = re.exec(src)) !== null) names.add(m[1])
  if (names.size === 0) {
    console.error('FAIL：未能从 Icon.vue 解析出任何图标名——正则失效或文件结构变了')
    process.exit(1)
  }
  return names
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (['.vue', '.ts', '.tsx'].includes(extname(p))) out.push(p)
  }
  return out
}

const icons = readIcons()
const files = SCAN_DIRS.flatMap(d => walk(join(root, d)))

const bad = []
let checked = 0

for (const f of files) {
  const rel = f.slice(root.length)
  const src = readFileSync(f, 'utf8')
  // icon: 'x'
  for (const m of src.matchAll(/\bicon:\s*'([a-z][a-z0-9-]*)'/g)) {
    checked++
    if (!icons.has(m[1])) bad.push(`${rel}: icon: '${m[1]}'`)
  }
  // <Icon name="x"> —— 只取静态绑定。
  // ⚠ 必须排除 `:name="x"`（动态传变量，x 可能是任意运行时值，静态无从判定）。
  for (const m of src.matchAll(/<Icon\b(?![^>]*:name)[^>]*?\bname="([a-z][a-z0-9-]*)"/g)) {
    checked++
    if (!icons.has(m[1])) bad.push(`${rel}: <Icon name="${m[1]}">`)
  }
}

if (checked === 0) {
  console.error('FAIL：未扫描到任何图标引用——扫描范围或正则失效（恒绿守卫 = 没用的守卫）')
  process.exit(1)
}

if (bad.length) {
  console.error(`FAIL：${bad.length} 处图标名不在 Icon.vue 的 ICONS 表里（会静默渲染空图标）：`)
  for (const b of bad) console.error(`      ${b}`)
  console.error(`\n可用图标：${[...icons].sort().join(', ')}`)
  process.exit(1)
}

console.log(`PASS：图标名全部有效（扫描 ${checked} 处引用，ICONSet 共 ${icons.size} 个图标）`)
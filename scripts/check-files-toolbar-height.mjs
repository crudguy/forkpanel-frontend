#!/usr/bin/env node
// 文件页工具行控件等高守卫（2026-11-19 反馈修复）。
//
// 为什么需要：align-items:center 只对齐几何中心，控件自身高度不齐时上下边仍参差。
// 真机量测（1366）曾出现：上传 38.4 / 筛选 36.8 / 帮助 34 / 图标态按钮 30~31 /
// 显示隐藏 19.2 —— 用户描述为「有的靠上，有的靠下」。tsc / vite build / vitest /
// 既有 UI 守卫全绿，只有真机量得出来，故须源码守卫钉住高度契约。
//
// 判据指向被检查的 FilesView.vue scoped 样式，并用好/坏样本自检解析链路：
// 正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = join(ROOT, 'src/views/FilesView.vue')

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}
function styleText(s) {
  return [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }))
}

// 高度契约：一条规则同时覆盖 .fsearch / .hid / button，且 height 精确 38px。
// 原生按钮 padding7 + 行高22.4 + 边框2 = 38.4px，必须显式压到 38 才与上边齐平。
function hasUniformHeight(rawCss) {
  const css = stripComments(rawCss)
  const r = rules(css).find((x) =>
    /\.tools-actions\s*>/.test(x.sel) && /\.fsearch/.test(x.sel) &&
    /\.hid/.test(x.sel) && />\s*button/.test(x.sel),
  )
  return !!r && /height\s*:\s*38px\s*;/.test(r.body)
}
// 帮助按钮是自定义组件，父 scoped 只能命中其根元素；须同时给宽高，
// 否则只给高会变成 34×38 椭圆（或只给宽仍 34px 高，上下边不齐）。
function helpBtnSquare(rawCss) {
  const css = stripComments(rawCss)
  const r = rules(css).find((x) => /\.tools-actions\s*>\s*\.help-btn/.test(x.sel))
  return !!r && /width\s*:\s*38px\s*;/.test(r.body) && /height\s*:\s*38px\s*;/.test(r.body)
}

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ ${label}`)
    failed = true
  }
}

console.log('== 文件页工具行控件等高守卫 ==')

// ── 解析链路自检 ──
const PROBE_OK = `
.fp-head-row > .tools-row > .tools-actions > .fsearch,
.fp-head-row > .tools-row > .tools-actions > .hid,
.fp-head-row > .tools-row > .tools-actions > button { height: 38px; }
.fp-head-row > .tools-row > .tools-actions > .help-btn { width: 38px; height: 38px; }
`
const PROBE_BAD = `
.fp-head-row > .tools-row > .tools-actions > .fsearch { height: 36px; }
.fp-head-row > .tools-row > .tools-actions > .help-btn { width: 34px; }
`
check(hasUniformHeight(stripComments(PROBE_OK)), '[1] 等高契约好样本能被解析检出')
check(!hasUniformHeight(stripComments(PROBE_BAD)), '[2] 缺 .hid/button 或高度 36px 的坏样本能被判红')
check(helpBtnSquare(stripComments(PROBE_OK)), '[3] 帮助按钮 38×38 好样本能被解析检出')
check(!helpBtnSquare(stripComments(PROBE_BAD)), '[4] 帮助按钮 34px 坏样本能被判红')
check(!hasUniformHeight('/* .tools-actions > .fsearch, .tools-actions > .hid, .tools-actions > button { height:38px; } */'), '[5] 注释里的规则不参与判定')

// ── 真实文件 ──
const raw = readFileSync(FILES, 'utf8')
check(hasUniformHeight(styleText(stripComments(raw))), '[6] FilesView 工具行 .fsearch/.hid/button 统一 38px')
check(helpBtnSquare(styleText(stripComments(raw))), '[7] FilesView 帮助按钮 38×38（父 scoped 命中根元素）')

if (failed) process.exit(1)
console.log('PASS：文件页工具行控件等高契约通过')

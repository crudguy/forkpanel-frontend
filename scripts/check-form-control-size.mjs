#!/usr/bin/env node
// 表单控件宽高一致性守卫（2026-11-19 备份页反馈修复）。
//
// 为什么需要：备份计划表单里 select 36/37px、input 39.2px 混排，且远端/时间选择
// 两个 inline 组件（display:contents）的 label 用 flex:1 1 140px，而全局
// `.row > label` 是 flex:1（=1 1 0%），同行宽度被分成 140 vs 148/143px。
// tsc / vite build / vitest / 既有 UI 守卫全绿，只有真机量得出来。
//
// 判据指向被检查的那份样式源码，并在末尾用坏样本自检解析链路：
// 正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(ROOT, 'src/styles/main.css')
const SCHED = join(ROOT, 'src/components/BackupScheduleInput.vue')
const REMOTE = join(ROOT, 'src/components/RemoteTargetForm.vue')

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}
function styleText(file) {
  let s = readFileSync(file, 'utf8')
  if (file.endsWith('.vue')) {
    s = [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
  }
  return stripComments(s)
}
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }))
}
function ruleFor(css, selRe) {
  return rules(css).find((r) => selRe.test(r.sel)) ?? null
}

// ── 判定函数：真实文件与坏样本自检共用同一份，确保自检有效 ──
// 高度契约：必须是后代选择器（.row input / .row select），不能用 `>`，
// 因为 display:contents 内联组件的子控件不是 .row 直接子元素。
function hasHeightContract(css) {
  const r = rules(css).find((x) =>
    /\.row\s+input:not\(/.test(x.sel) && /\.row\s+select/.test(x.sel) &&
    !/\s>\s/.test(x.sel),
  )
  if (!r) return false
  return /height\s*:\s*38px\s*;/.test(r.body) && /padding\s*:\s*0\s+11px\s*;/.test(r.body)
}
// inline label 的 flex 基值必须与全局 `.row > label` 的 flex:1（=1 1 0%）完全一致。
// 写 flex:1 1 140px 会让内联字段比同行普通字段宽一截。
function inlineFlexOk(css, selRe) {
  const r = ruleFor(css, selRe)
  if (!r) return false
  return /flex\s*:\s*1\s*;/.test(r.body) && /min-width\s*:\s*140px\s*;/.test(r.body)
}

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ ${label}`)
    failed = true
  }
}

console.log('== 表单控件宽高一致性守卫 ==')

// ── 解析链路自检 ──
const PROBE_OK = `
.row input:not([type='checkbox']):not([type='radio']), .row select { height:38px; padding:0 11px; }
.sched.inline label { flex:1; min-width:140px; }
.remote.inline label:not(.wide) { flex:1; min-width:140px; }
`
const PROBE_BAD = `
.row input:not([type='checkbox']):not([type='radio']), .row select { height:36px; padding:9px 11px; }
.sched.inline label { flex:1 1 140px; min-width:140px; }
`
check(hasHeightContract(stripComments(PROBE_OK)), '[1] 高度契约好样本能被解析检出')
check(!hasHeightContract(stripComments(PROBE_BAD)), '[2] 高度契约坏样本（36px）能被判红')
check(inlineFlexOk(stripComments(PROBE_OK), /^\.sched\.inline label$/), '[3] inline flex 好样本能被解析检出')
check(!inlineFlexOk(stripComments(PROBE_BAD), /^\.sched\.inline label$/), '[4] inline flex 坏样本（1 1 140px）能被判红')
check(!hasHeightContract('/* .row select { height:38px; padding:0 11px; } */'), '[5] 注释里的坏规则不参与判定')
check(!hasHeightContract('.row > select { height:38px; padding:0 11px; }'), '[6] 直接子选择器变体被拒（须覆盖 display:contents 子控件）')

// ── 真实文件 ──
const mainCss = styleText(MAIN)
const schedCss = styleText(SCHED)
const remoteCss = styleText(REMOTE)
check(hasHeightContract(mainCss), '[7] main.css 存在 .row 后代控件统一 38px 高度契约')
check(inlineFlexOk(schedCss, /^\.sched\.inline label$/), '[8] BackupScheduleInput inline label 用 flex:1 同基值')
check(inlineFlexOk(remoteCss, /^\.remote\.inline label:not\(\.wide\)$/), '[9] RemoteTargetForm inline label 用 flex:1 同基值')
// .wide（URL 字段）应保留更宽基值，不能被上面归一类一起压成 140px
const wide = ruleFor(remoteCss, /^\.remote label\.wide$/)
check(!!wide && /flex\s*:\s*1\s+1\s+280px/.test(wide.body ?? ''), '[10] RemoteTargetForm .wide 保留 280px 基值（URL 字段不被压窄）')

if (failed) process.exit(1)
console.log('PASS：表单控件宽高契约全部通过')

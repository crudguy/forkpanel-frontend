#!/usr/bin/env node
// 防火墙「端口规则」表单行间距守卫（2026-11-20 反馈修复）。
//
// 为什么需要：动作下拉被写死 width:128px，而 .row > label 是 flex:1 均分后的
// 254px 列——下拉右边空出 126px，到端口输入框的视觉间距 136px，其它列间只有
// 10px（老板截图圈出的空白）。真机 CDP 量得：
//   改前 selW=128, selRight=403, portLeft=539 → gap=136
//   改后 selW=254, selRight=529, portLeft=539 → gap=10，行高/控件高/Y 全不变
// tsc/build/单测/既有 UI 守卫都看不见这种留白，只有源码契约 + 几何量测守得住。
//
// 另一个坑：不能把 flex 写成 `flex: 0 0 128px`。.row > label 是 column flex，
// flex-basis 会落到高度上，把 select 撑成 128px 高（历史 45px 错位）。
// 因此宽度用 width:100%，高度用 flex:none 保持按内容，两者缺一不可。
//
// 判据指向被检查的 FirewallView.vue scoped 样式，并用好/坏样本自检解析链路；
// 正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'src/views/FirewallView.vue')

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}
function styleText(s) {
  return [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}
/** 取所有 select.fw-action 规则体（剔注释后），缺项返回 [] —— 供活性自检。 */
function actionRules(rawCss) {
  const css = stripComments(rawCss)
  const out = []
  for (const m of css.matchAll(/select\.fw-action\s*\{([^{}]*)\}/g)) {
    out.push(m[1].trim())
  }
  return out
}
function declarations(body) {
  const out = {}
  for (const part of body.split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*([^;]+?)\s*$/.exec(part)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ ${label}`); failed = true }
}

console.log('== 防火墙表单行动作列守卫 ==')

// ── 解析链路自检（好/坏样本 + 活性自检）──
const GOOD = 'select.fw-action { width: 100%; flex: none; }'
const BAD_FIXED = 'select.fw-action { width: 128px; flex: none; }'
const BAD_FLEX = 'select.fw-action { width: 100%; flex: 0 0 128px; }'
check(actionRules(GOOD).length === 1, '[1] 好样本能被解析检出（恰好 1 处）')
check(declarations(actionRules(GOOD)[0] ?? '').width === '100%', '[2] 好样本 width:100% 能被解析')
check(declarations(actionRules(BAD_FIXED)[0] ?? '').width === '128px', '[3] 固定 px 坏样本能被识别')
check(declarations(actionRules(BAD_FLEX)[0] ?? '').flex === '0 0 128px', '[4] flex 缩写坏样本能被识别')
check(actionRules('/* select.fw-action { width: 128px; } */').length === 0, '[5] 注释里的旧规则不参与判定')

// ── 真实文件 ──
const raw = styleText(readFileSync(FILE, 'utf8'))
const rules = actionRules(raw)
check(rules.length === 1, `[6] select.fw-action 恰好定义 1 处（实际 ${rules.length}）`)
if (rules.length === 1) {
  const d = declarations(rules[0])
  check(d.width === '100%', `[7] 动作下拉宽度撑满列 width:100%（实际 ${d.width ?? '无'}）`)
  check(d.flex === 'none', `[8] 高度保持 flex:none，不得用 flex 缩写把 basis 落到高度（实际 ${d.flex ?? '无'}）`)
  check(!/^\d+px$/.test(d.width ?? ''), '[9] 不得退回固定 px 宽度（会留下 126px 空白）')
}

if (failed) process.exit(1)
console.log('PASS：防火墙表单行动作列契约通过')

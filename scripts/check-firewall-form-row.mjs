#!/usr/bin/env node
// 防火墙「端口规则」表单行布局守卫（2026-11-20 / 11-21 反馈修复）。
//
// 1) 动作下拉曾被写死 width:128px，而 .row > label 是 flex:1 均分后的 254px
//    列——下拉右边空出 126px，到端口输入框的视觉间距 136px，其它列间只有
//    10px（老板 11-20 截图圈出的空白）。真机 CDP 量得：
//      改前 selW=128, selRight=403, portLeft=539 → gap=136
//      改后 selW=254, selRight=529, portLeft=539 → gap=10，行高/控件高/Y 全不变
// 2) 11-21 老板要求「动作列调窄，端口/备注调宽」。四列 flex:1 均分（1440 下
//    各 254px）浪费：动作最长选项仅需 147px，端口 placeholder 147px、实际
//    输入常更长，备注典型 143px。改为相对权重 0.8 / 1.35 / 1 / 1.35，
//    实测三档（1440: 181/305/226/305；1280: 152/257/190/257；
//    1024: 140/160/140/160）端口/备注始终比动作宽，下拉文字不截断、无横滚。
//    ⚠ 别把动作列写死 px：1024 下 168px 会比端口/备注的 146px 还宽。
//    ⚠ 不能把 select 的 flex 写成 `flex: 0 0 Npx`：.row > label 是 column
//    flex，basis 会落到高度上，把 select 撑成 N px 高（历史 45px 错位）。
//
// tsc/build/单测/既有 UI 守卫都看不见这类留白与宽度分配，只有源码契约 +
// 几何量测守得住。判据指向被检查的 FirewallView.vue，并用好/坏样本自检
// 解析链路；正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
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
function declarations(body) {
  const out = {}
  for (const part of body.split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*([^;]+?)\s*$/.exec(part)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}
/** 取所有 select.fw-action 规则体（剔注释后），缺项返回 [] —— 供活性自检。 */
function actionRules(rawCss) {
  const out = []
  for (const m of stripComments(rawCss).matchAll(/select\.fw-action\s*\{([^{}]*)\}/g)) {
    out.push(m[1].trim())
  }
  return out
}
/** 取四列 flex 声明映射（剔注释后），键缺失即不返回——供集合相等断言。 */
function colRules(rawCss) {
  const out = {}
  for (const m of stripComments(rawCss).matchAll(
    /\.row\s*>\s*label\.(fw-form-[a-z]+)\s*\{([^{}]*)\}/g)) {
    out[m[1]] = declarations(m[2]).flex
  }
  return out
}

/** 四列权重契约：动作最窄、端口与备注最宽、来源居中。 */
const COLS = {
  'fw-form-act': '0.8 1 0%',
  'fw-form-port': '1.35 1 0%',
  'fw-form-src': '1 1 0%',
  'fw-form-cmt': '1.35 1 0%',
}
const COL_KEYS = Object.keys(COLS)
const weight = (flex) => Number.parseFloat(flex ?? '')

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ ${label}`); failed = true }
}

console.log('== 防火墙表单行动作列 + 四列宽度守卫 ==')

// ── 解析链路自检（好/坏样本 + 活性自检）──
const GOOD = 'select.fw-action { width: 100%; flex: none; }'
const BAD_FIXED = 'select.fw-action { width: 128px; flex: none; }'
const BAD_FLEX = 'select.fw-action { width: 100%; flex: 0 0 128px; }'
check(actionRules(GOOD).length === 1, '[1] 好样本能被解析检出（恰好 1 处）')
check(declarations(actionRules(GOOD)[0] ?? '').width === '100%', '[2] 好样本 width:100% 能被解析')
check(declarations(actionRules(BAD_FIXED)[0] ?? '').width === '128px', '[3] 固定 px 坏样本能被识别')
check(declarations(actionRules(BAD_FLEX)[0] ?? '').flex === '0 0 128px', '[4] flex 缩写坏样本能被识别')
check(actionRules('/* select.fw-action { width: 128px; } */').length === 0, '[5] 注释里的旧规则不参与判定')

const GOOD_COLS = COL_KEYS.map((k) => `.row > label.${k} { flex: ${COLS[k]}; }`).join('\n')
const BAD_COLS = GOOD_COLS.replace('flex: 0.8 1 0%', 'flex: 0 0 168px')
check(Object.keys(colRules(GOOD_COLS)).length === 4, '[6] 四列好样本能被解析检出（活性自检）')
check(colRules(BAD_COLS)['fw-form-act'] === '0 0 168px', '[7] 动作列写死 px 的坏样本能被识别')
check(Object.keys(colRules('/* .row > label.fw-form-act { flex: 0.8 1 0%; } */')).length === 0,
  '[8] 注释里的列宽不参与判定')

// ── 真实文件 ──
const src = readFileSync(FILE, 'utf8')
const css = styleText(src)
const rules = actionRules(css)
check(rules.length === 1, `[9] select.fw-action 恰好定义 1 处（实际 ${rules.length}）`)
if (rules.length === 1) {
  const d = declarations(rules[0])
  check(d.width === '100%', `[10] 动作下拉宽度撑满列 width:100%（实际 ${d.width ?? '无'}）`)
  check(d.flex === 'none', `[11] 高度保持 flex:none，不得用 flex 缩写把 basis 落到高度（实际 ${d.flex ?? '无'}）`)
  check(!/^\d+px$/.test(d.width ?? ''), '[12] 不得退回固定 px 宽度（会留下 126px 空白）')
}

const cols = colRules(css)
const keys = Object.keys(cols)
check(keys.length === COL_KEYS.length && COL_KEYS.every((k) => k in cols),
  `[13] 四列定义齐全（实际 ${keys.join(',') || '无'}）`)
for (const k of COL_KEYS) {
  check(cols[k] === COLS[k], `[14-${k}] ${k} flex=${COLS[k]}（实际 ${cols[k] ?? '无'}）`)
  const uses = [...src.matchAll(new RegExp(`class="${k}"`, 'g'))].length
  check(uses === 1, `[15-${k}] 模板中恰好使用 1 次（实际 ${uses}）`)
}
check(weight(cols['fw-form-port']) > weight(cols['fw-form-act'])
  && weight(cols['fw-form-cmt']) > weight(cols['fw-form-act'])
  && weight(cols['fw-form-src']) > weight(cols['fw-form-act']),
  '[16] 端口/来源/备注权重均大于动作（动作最窄）')
check(weight(cols['fw-form-port']) === weight(cols['fw-form-cmt'])
  && weight(cols['fw-form-port']) > weight(cols['fw-form-src']),
  '[17] 端口与备注同权且比来源宽')

if (failed) process.exit(1)
console.log('PASS：防火墙表单行布局契约通过')

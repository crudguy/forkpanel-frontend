#!/usr/bin/env node
// WAF 页表格几何守卫（2026-11-11 截图反馈修复）。
//
// 为什么需要：这次的坏布局 tsc / vite build / vitest / 既有 23 个 UI 守卫全绿——
//   CSS 里 `td { display:flex }` 会让 td 失去 table-cell 身份，浏览器用匿名单元格
//   包裹，连续两个这样的 td 叠到同一列位置上下堆叠。真机实测 WAF 站点表：
//   名称弹性列被压成 0（整列不可见）、行高 42→120、「应用」按钮掉到 IP 名单下方；
//   另外全局 `select{width:100%}` 让威胁日志两个下拉各撑满一行，筛选条 48→133px。
//
// 判据全部指向**被检查的那份样式源码**，并在末尾用坏样本自检解析链路：
// 正则写错会让「没找到 = 通过」静默退化成恒绿，比没守卫更危险。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(ROOT, 'src/styles/main.css')
const WAF = join(ROOT, 'src/views/WafView.vue')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p)
  }
  return out
}

// ⚠ 必须先剔注释：main.css 里那句「td 绝不能改成 display:flex」是给开发者看的，
//   不剔注释这条守卫会把自己判红；反过来，若有人把坏规则写进注释也不会假绿。
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
function targetsTd(sel) {
  return sel.split(',').some((part) => /(^|[\s>+~])td(?=$|[\s.:#[,+>~])/i.test(part))
}
function hasLayoutDisplay(body) {
  return /\bdisplay\s*:\s*(flex|inline-flex|grid|inline-grid|block|inline-block|inline)\b/i.test(body)
}
function ruleFor(css, selectorRe) {
  return rules(css).find((r) => selectorRe.test(r.sel)) ?? null
}

let failed = false
function check(ok, label) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ ${label}`)
    failed = true
  }
}

console.log('== WAF 表格几何守卫 ==')

// ── 解析链路自检：坏样本必须能被抓到，注释样本必须不被抓到 ──
const PROBE_BAD = 'td.col-actions { display:flex; gap:6px; } .ip-cell { display:flex } .evt-filters select { width:100%; flex:none }'
const PROBE_OK = '/* td 绝不能改成 display:flex */\ntd.col-actions { white-space: nowrap; }'
const badRules = rules(stripComments(PROBE_BAD))
const okRules = rules(stripComments(PROBE_OK))
check(!stripComments(PROBE_OK).includes('display:flex'), '[1] 注释剔除有效（说明性文字不参与判定）')
check(badRules.some((r) => targetsTd(r.sel) && hasLayoutDisplay(r.body)), '[2] td 坏 display 样本能被解析检出')
check(!okRules.some((r) => targetsTd(r.sel) && hasLayoutDisplay(r.body)), '[3] 正常 td 规则不会被误报')
check(/white-space\s*:\s*nowrap/.test(ruleFor(stripComments(PROBE_OK), /td\.col-actions/)?.body ?? ''), '[4] 规则块解析器能取到声明体')

const files = walk(join(ROOT, 'src'))
const mainCss = styleText(MAIN)
const wafCss = styleText(WAF)
const wafRaw = readFileSync(WAF, 'utf8')

// ── 全仓：td 选择器不得改 display（会失去 table-cell 身份） ──
// 已知例外显式登记：容器页状态列是单 td 内徽章 + ellipsis，属他线既有实现，
// 本轮不动。登记项必须真实命中，否则说明代码已变、登记过时 → 判红要求复核，
// 避免白名单退化成「写一行就永久放行」的恒绿。
const KNOWN_TD_DISPLAY = [
  {
    file: 'src/components/containers/ContainersTab.vue',
    sel: /^td\.state-cell$/,
    body: /display\s*:\s*flex/i,
    why: '容器页状态列：徽章不缩 + 原始串 ellipsis（既有实现，见该文件注释）',
  },
]
const tdFlex = []
const allowed = []
for (const f of files) {
  for (const rule of rules(styleText(f))) {
    if (!targetsTd(rule.sel) || !hasLayoutDisplay(rule.body)) continue
    const rel = relative(ROOT, f)
    const known = KNOWN_TD_DISPLAY.find((k) => k.file === rel && k.sel.test(rule.sel) && k.body.test(rule.body))
    if (known) allowed.push(known)
    else tdFlex.push(`${rel}  ${rule.sel.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}
check(files.length >= 80, `[5] 扫描链路覆盖 ${files.length} 个样式源文件（期望 ≥80）`)
if (tdFlex.length) {
  console.error(`  ✗ [6] ${tdFlex.length} 条未登记的规则给 td 改了 display（表格会塌成匿名单元格）：`)
  for (const t of tdFlex.slice(0, 20)) console.error(`      ${t}`)
  failed = true
} else {
  console.log(`  ✓ [6] 无新增 td 规则改写 display（${allowed.length} 处为已登记既有例外）`)
}
check(allowed.length === KNOWN_TD_DISPLAY.length && new Set(allowed).size === KNOWN_TD_DISPLAY.length,
  `[6b] 已登记例外 ${KNOWN_TD_DISPLAY.length} 项均恰好真实命中一次（防登记过时恒绿）`)

// ── 公共操作列：保持 nowrap + 相邻间距，不靠 flex ──
const actRule = ruleFor(mainCss, /^td\.col-actions$/)
check(!!actRule && /white-space\s*:\s*nowrap/.test(actRule.body), '[7] main.css 的 td.col-actions 保持 nowrap')
check(!!actRule && !hasLayoutDisplay(actRule.body ?? ''), '[8] main.css 的 td.col-actions 未改写 display')

// ── WAF 访问控制列：两个 IP 输入靠 nowrap 同排，不能改成 flex ──
const ipRule = ruleFor(wafCss, /^\.ip-cell$/)
check(!!ipRule && /white-space\s*:\s*nowrap/.test(ipRule.body), '[9] WafView .ip-cell 保持 nowrap')
check(!!ipRule && !hasLayoutDisplay(ipRule.body ?? ''), '[10] WafView .ip-cell 未改写 display')

// ── 威胁日志筛选条：全局 select{width:100%} 必须被局部覆盖 ──
const selRule = ruleFor(wafCss, /^\.evt-filters select$/)
check(!!selRule && /width\s*:\s*auto/.test(selRule.body ?? ''), '[11] .evt-filters select 覆盖全局 width:100%')
check(!!selRule && /flex\s*:\s*0\s+1\s+\d+px/.test(selRule.body ?? ''), '[12] .evt-filters select 用有限 flex-basis 保持同排')

// ── 站点表固定列总和：必须给唯一的弹性列（站点名）留余量 ──
const EXPECT_COLS = ['w-wfdom', 'w-wfkind', 'w-wfon', 'w-wfprof', 'w-wfrate', 'w-wfburst', 'w-wfip', 'w-wfacts']
const colDefs = [...wafCss.matchAll(/col\.(w-wf[a-z]+)\s*\{\s*width:\s*(\d+)px\s*;?\s*\}/g)]
  .map((m) => ({ cls: m[1], px: Number(m[2]) }))
const foundCols = colDefs.map((c) => c.cls).sort()
const wantCols = [...EXPECT_COLS].sort()
check(foundCols.length === wantCols.length && foundCols.every((c, i) => c === wantCols[i]),
  `[13] 固定列定义恰好 ${wantCols.length} 条且集合不变（当前 ${foundCols.join(',')}）`)
const total = colDefs.reduce((n, c) => n + c.px, 0)
check(total >= 700 && total <= 900, `[14] 固定列总和 ${total}px 落在 [700,900]：1280 视口容器 1000px 下弹性列有余量`)
check(/col\.w-wfname\s*\{\s*width:\s*auto\s*;?\s*\}/.test(wafCss), '[15] 站点名列 w-wfname 是唯一弹性列（width:auto）')

// CSS 定义与模板 colgroup 必须对得上，否则「删一列让总和变小」会假绿
const colgroup = /<colgroup[^>]*>([\s\S]*?)<\/colgroup>/.exec(wafRaw)?.[1] ?? ''
const used = [...colgroup.matchAll(/class="(w-wf[a-z]+)"/g)].map((m) => m[1])
check(used.length === 9 && used.includes('w-wfname') && EXPECT_COLS.every((c) => used.includes(c)),
  `[16] 模板 colgroup 用齐 ${used.length} 列（含弹性列与 8 条固定列）`)

if (failed) process.exit(1)
console.log('PASS：WAF 表格几何约束全部守恒')

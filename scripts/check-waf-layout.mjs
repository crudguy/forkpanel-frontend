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

// ── 站点表列宽：中小屏基础档与宽屏档必须分开判定 ──
// ⚠ 宽屏档是 @media 嵌套块，里面的 9 条 col 定义与基础档同名。不分块的话
//   [13]「恰好 8 条」会把宽屏定义一起数进来（假红），或两档混算成恒绿。
function takeMedia(css, re) {
  const m = re.exec(css)
  if (!m) return { block: '', rest: css }
  const open = css.indexOf('{', m.index + m[0].length)
  if (open < 0) return { block: '', rest: css }
  let depth = 0
  let close = -1
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) { close = i; break }
  }
  if (close < 0) return { block: '', rest: css, end: css.length }
  return { block: css.slice(open + 1, close), rest: css.slice(0, m.index) + css.slice(close + 1), end: close + 1 }
}
// 宽屏档里两张表的 col 定义混在同一个 @media 块，必须按前缀分组，
// 否则站点表「恰好 9 条」会把模板表 7 条一起数进来（假红 / 混算恒绿）。
function parseCols(css, prefix) {
  return [...css.matchAll(/col\.(w-[a-z]+)\s*\{\s*width:\s*(\d+)px\s*;?\s*\}/g)]
    .map((m) => ({ cls: m[1], px: Number(m[2]) }))
    .filter((c) => c.cls.startsWith(prefix))
}
const WIDE_RE = /@media\s*\(\s*min-width:\s*1440px\s*\)/
const { block: wideCss, rest: baseCss } = takeMedia(wafCss, WIDE_RE)

// 解析链路自检：块提取必须真把两档拆开（坏样本里块内的宽度不得混进基础档）
const PROBE_MEDIA = 'col.w-wfname { width:auto } @media (min-width: 1440px) { col.w-wfname { width:180px } }'
const probeSplit = takeMedia(PROBE_MEDIA, WIDE_RE)
check(probeSplit.rest.includes('width:auto') && !probeSplit.rest.includes('180px'), '[13a] 媒体块提取把基础档与宽屏档分开')
check(probeSplit.block.includes('180px'), '[13b] 媒体块提取能取到宽屏档声明体')

const EXPECT_COLS = ['w-wfdom', 'w-wfkind', 'w-wfon', 'w-wfprof', 'w-wfrate', 'w-wfburst', 'w-wfip', 'w-wfacts']
const TPL_COLS = ['w-tprof', 'w-trate', 'w-tburst', 'w-tipa', 'w-tipd', 'w-tacts']
const colDefs = parseCols(baseCss, 'w-wf')
const foundCols = colDefs.map((c) => c.cls).sort()
const wantCols = [...EXPECT_COLS].sort()
check(foundCols.length === wantCols.length && foundCols.every((c, i) => c === wantCols[i]),
  `[13] 基础档固定列定义恰好 ${wantCols.length} 条且集合不变（当前 ${foundCols.join(',')}）`)
const total = colDefs.reduce((n, c) => n + c.px, 0)
check(total >= 700 && total <= 900, `[14] 基础档固定列总和 ${total}px 落在 [700,900]：1280 视口容器 1000px 下弹性列有余量`)
check(/col\.w-wfname\s*\{\s*width:\s*auto\s*;?\s*\}/.test(baseCss), '[15] 基础档站点名列 w-wfname 仍是唯一弹性列（width:auto）')

// CSS 定义与模板 colgroup 必须对得上，否则「删一列让总和变小」会假绿
const colgroups = [...wafRaw.matchAll(/<colgroup[^>]*>([\s\S]*?)<\/colgroup>/g)].map((m) => m[1])
const siteColgroup = colgroups[0] ?? ''
const tplColgroup = colgroups[1] ?? ''
const used = [...siteColgroup.matchAll(/class="(w-[a-z]+)"/g)].map((m) => m[1])
const tplUsed = [...tplColgroup.matchAll(/class="(w-[a-z]+)"/g)].map((m) => m[1])
check(colgroups.length === 3, `[16a] WAF 页恰好 3 组 colgroup（站点 / 模板 / 事件），当前 ${colgroups.length}`)
check(used.length === 9 && used.includes('w-wfname') && EXPECT_COLS.every((c) => used.includes(c)),
  `[16] 站点表 colgroup 用齐 ${used.length} 列（含弹性列与 8 条固定列）`)
check(tplUsed.length === 7 && tplUsed.includes('w-tname') && TPL_COLS.every((c) => tplUsed.includes(c)),
  `[16b] 模板表 colgroup 用齐 ${tplUsed.length} 列（含弹性列与 6 条固定列）`)
const tplBaseDefs = parseCols(baseCss, 'w-t')
const tplBaseSum = tplBaseDefs.reduce((n, c) => n + c.px, 0)
check(tplBaseDefs.length === TPL_COLS.length && TPL_COLS.every((c) => tplBaseDefs.some((d) => d.cls === c)),
  `[16c] 基础档模板表 ${tplBaseDefs.length} 条固定列集合不变`)
check(tplBaseSum >= 700 && tplBaseSum <= 900, `[16d] 基础档模板表总和 ${tplBaseSum}px 落在 [700,900]`)
check(/col\.w-tname\s*\{\s*width:\s*auto\s*;?\s*\}/.test(baseCss), '[16e] 基础档模板表名称列仍是唯一弹性列（width:auto）')

// ── 宽屏档：两张表都按内容实宽等比放大，名称列不再独吞余量 ──
// 判据与负向自检共用同一个函数，避免「测试自持一套实现」的恒绿。
function violationsFor(block, colgroupUsed, prefix, opts) {
  const v = []
  const defs = parseCols(block, prefix)
  const names = defs.map((c) => c.cls).sort()
  const want = [...colgroupUsed].sort()
  if (defs.length !== want.length || names.some((n, i) => n !== want[i])) v.push('列集合 / 条数与 colgroup 不一致')
  const sum = defs.reduce((n, c) => n + c.px, 0)
  // 1440 视口下 .t-scroll 容器实测 1160px：总和超出就会横向滚动。
  if (sum < 1000 || sum > 1160) v.push(`总和 ${sum} 超出 [1000,1160]`)
  const name = defs.find((c) => c.cls === opts.nameCol)
  if (!name || name.px > opts.nameMax) v.push(`${opts.nameCol} 未定宽或过宽（会重新独吞余量）`)
  if (opts.minCol) {
    const m = defs.find((c) => c.cls === opts.minCol)
    if (!m || m.px < opts.minVal) v.push(`${opts.minCol} 低于 ${opts.minVal}px（${opts.minWhy}）`)
  }
  const px = defs.map((c) => c.px)
  if (px.length && Math.min(...px) < opts.minAny) v.push('存在过窄列（控件放不下）')
  if (px.length && Math.max(...px) / Math.min(...px) > 5) v.push('最宽 / 最窄列比例失衡')
  return v
}
const SITE_WIDE = { nameCol: 'w-wfname', nameMax: 200, minCol: 'w-wfdom', minVal: 180, minWhy: '长域名被截断', minAny: 50 }
const TPL_WIDE = { nameCol: 'w-tname', nameMax: 300, minCol: 'w-tacts', minVal: 164, minWhy: '3 个按钮折行', minAny: 80 }
const wideProblems = violationsFor(wideCss, used, 'w-wf', SITE_WIDE)
check(wideProblems.length === 0,
  `[17] 宽屏档站点表 9 列理想宽守恒${wideProblems.length ? `：${wideProblems.join('、')}` : ''}`)
const wideDefs = parseCols(wideCss, 'w-wf')
check(wideDefs.length === 9, `[18] 宽屏档站点表恰好 ${wideDefs.length} 列定义（含站点名，不再有 auto 弹性列）`)
check(wideDefs.find((c) => c.cls === 'w-wfname')?.px <= 200, '[19] 宽屏档站点名列有固定上限，不再吸收全部余量')

const tplProblems = violationsFor(wideCss, tplUsed, 'w-t', TPL_WIDE)
check(tplProblems.length === 0,
  `[23] 宽屏档模板表 7 列理想宽守恒${tplProblems.length ? `：${tplProblems.join('、')}` : ''}`)
const tplWideDefs = parseCols(wideCss, 'w-t')
check(tplWideDefs.length === 7, `[24] 宽屏档模板表恰好 ${tplWideDefs.length} 列定义（含名称列，不再有 auto 弹性列）`)
check(tplWideDefs.find((c) => c.cls === 'w-tname')?.px <= 300, '[25] 宽屏档模板表名称列有固定上限，不再吸收全部余量')

// 列宽放大会同步放大单元格：IP 输入必须跟着伸，否则宽屏留白、窄屏被裁
const ipWidth = ruleFor(baseCss, /^\.ip$/)?.body ?? ''
check(/width\s*:\s*calc\([^)]*100%[^)]*\)/.test(ipWidth), '[20] .ip 用 calc(100%) 随列宽伸缩，不写死 84px')

// 负向自检：把宽屏档改回旧语义（名称列 auto / 总和超上限 / 操作列压窄）必须能被同一套判据判红
const BAD_AUTO = wideCss.replace(/col\.w-wfname\s*\{\s*width:\s*180px\s*;?\s*\}/, 'col.w-wfname { width: auto; }')
check(BAD_AUTO !== wideCss && violationsFor(BAD_AUTO, used, 'w-wf', SITE_WIDE).length > 0,
  '[21] 负向：宽屏站点名退回 width:auto（旧语义）能判红')
const BAD_SUM = wideCss.replace(/col\.w-wfdom\s*\{\s*width:\s*200px\s*;?\s*\}/, 'col.w-wfdom { width: 400px; }')
check(BAD_SUM !== wideCss && violationsFor(BAD_SUM, used, 'w-wf', SITE_WIDE).some((v) => v.includes('总和')),
  '[22] 负向：宽屏站点表总和超出 1440 容器能判红')
const BAD_TPL_AUTO = wideCss.replace(/col\.w-tname\s*\{\s*width:\s*260px\s*;?\s*\}/, 'col.w-tname { width: auto; }')
check(BAD_TPL_AUTO !== wideCss && violationsFor(BAD_TPL_AUTO, tplUsed, 'w-t', TPL_WIDE).length > 0,
  '[26] 负向：宽屏模板名退回 width:auto（旧语义）能判红')
const BAD_TPL_ACTS = wideCss.replace(/col\.w-tacts\s*\{\s*width:\s*170px\s*;?\s*\}/, 'col.w-tacts { width: 120px; }')
check(BAD_TPL_ACTS !== wideCss && violationsFor(BAD_TPL_ACTS, tplUsed, 'w-t', TPL_WIDE).some((v) => v.includes('w-tacts')),
  '[27] 负向：模板表操作列压到 120px（按钮折行）能判红')

// ── 顺序活性：scoped 编译后基础档与 @media 内规则特异性相同，谁在后谁赢 ──
// 实测踩过：模板表基础档写在 @media 之后，7 条宽屏定宽被整组盖掉，1920 下名称列
// 仍退回 898px，而「宽屏档存在 / 总和合理」等判据全绿。故必须单独钉住顺序。
const BASE_COL_RE = /col\.(w-(?:wf|t)[a-z]+)\s*\{\s*width:/g
const wideEnd = takeMedia(wafCss, WIDE_RE).end
const trailingDefs = [...wafCss.slice(wideEnd).matchAll(BASE_COL_RE)]
check(trailingDefs.length === 0,
  `[28] 站点/模板表基础档定义全部排在 @media 之前（当前媒体档后仍有 ${trailingDefs.length} 条，会盖掉宽屏定宽）`)
const PROBE_ORDER = PROBE_MEDIA + '\ncol.w-tacts { width: 170px; }'
const orderSplit = takeMedia(PROBE_ORDER, WIDE_RE)
const probeTrailing = [...PROBE_ORDER.slice(orderSplit.end).matchAll(BASE_COL_RE)]
check(probeTrailing.length > 0, '[29] 负向：基础档定义挪到媒体档之后能被顺序判据检出')

if (failed) process.exit(1)
console.log('PASS：WAF 表格几何约束全部守恒')

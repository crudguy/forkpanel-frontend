#!/usr/bin/env node
// WAF 页 P2 接线守卫：停用态守恒 / 编辑弹窗入口 / 应用前草稿冲突检测。
// 纯函数单测只能证明 hasConflict 本身对，挡不住「三条 apply 路径里漏接一条」
// 「检测写在 POST 之后」「入口又挂回 v-if wafOn 里」这类接线退化。
// 判据一律指向被检查的那份文件，且先剔注释，避免注释里复述造成假绿。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
const count = (s, needle) => s.split(needle).length - 1

const errors = []
const check = (ok, msg) => {
  if (ok) console.log(`  ✓ ${msg}`)
  else errors.push(msg)
}

const dlg = strip(read('src/components/SiteFormDialog.vue'))
const waf = strip(read('src/views/WafView.vue'))
const pure = strip(read('src/composables/siteWaf.ts'))
check(dlg.length > 1000 && waf.length > 1000 && pure.length > 1000,
  '活性自检：三份被检查文件都取到内容（取不到即判红）')

// ── P2-1：站点编辑弹窗 → WAF 页定位 ───────────────────────────────
check(count(dlg, ':to="{ path: \'/waf\', query: { site: editing.name } }"') === 1,
  '编辑弹窗 WAF 区块有带站点名的 /waf 入口')
check(count(dlg, 'v-if="editing" class="waf-goto-row"') === 1,
  '入口仅编辑态可见（新建站点无可定位对象）')
check(count(dlg, '.modal-body .sector > .waf-goto-row { grid-column: 1 / -1;') === 1,
  '入口行跨两列（防 scoped 跨列规则失效）')
check(count(waf, 'route.query.site') === 2, 'WAF 页读取 ?site= 参数')
check(count(waf, 'focusFromQuery') === 2, '定位函数定义 + watch(sites) 触发各一处')
check(count(waf, 'watch(sites,') === 1, '站点列表加载完成后才定位')
check(count(waf, 'void load()') === 1, 'onMounted 仍保留 load（迁移时最易漏）')
check(count(waf, 'row-focus') === 4, '行高亮 class + 滚动目标 + 两条 scoped 规则')
check(count(waf, '.row-focus > td { background: var(--c-primary-soft); }') === 1,
  '高亮样式用设计变量，不写裸色')

// ── P2-2：应用前草稿冲突检测 ─────────────────────────────────────
check(count(pure, 'export function applyBaseline(s: Site): string') === 1, '基线快照纯函数恰好一处')
check(count(pure, 'export function hasConflict(baseline: Site, latest: Site | undefined): boolean') === 1,
  '冲突判定纯函数恰好一处')
check(count(pure, 'if (!latest) return true') === 1, '站点已被删除算冲突')
check(count(pure, '].sort()') === 2, '两份 IP 名单排序后比较（只换顺序不误报）')
check(count(waf, 'hasConflict') === 2, 'WAF 页恰好：导入一次 + 比对一次')
check(count(waf, 'assertFresh') === 4, '冲突检测定义一处 + 三条 apply 路径各一处')
check(count(waf, "error.value = `无法校验站点现值：") === 1,
  '重拉失败落到页面错误条（不静默放行）')

// 顺序判据：检测必须在 POST 之前，否则只是「写完再查」的假接线。
const body = (name) => {
  const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)
  return re.exec(waf)?.[0] ?? ''
}
for (const [fn, label] of [
  ['applyWaf', '逐站应用'], ['applyAll', '应用全部'], ['doApplyTpl', '模板套用'],
]) {
  const b = body(fn)
  check(!!b && b.includes('assertFresh') && b.indexOf('assertFresh') < b.indexOf('api.post'),
    `${label}：冲突检测在 POST 之前`)
}

// ── P2-3：停用态守恒（后端 apply.rs 的 deploy = cur_row.enabled != 0） ──
check(count(waf, ':disabled="!canApply || !s.enabled') === 0,
  '停用站点不再被误禁用（失实文案曾导致功能不可用）')
check(count(waf, '会一并启用') === 0, '失实文案「套用会一并启用站点」已清除')
check(count(waf, 'upsert 会把站点') === 0, '帮助抽屉不再声称 enabled 会被置 1')
check(count(waf, 'blockedReason') === 0 && count(waf, 'applyHint') === 3,
  '门控提示改走 applyHint（定义一处 + 两处引用）')
check(count(waf, 'blockedPending') === 0 && count(waf, 'stoppedPending') === 4,
  '不可下发计数改为「待启用后下发」计数')
// 两处分别钉死：只数全文件出现次数会把工具条 title 里的子串一起算进去，
// 删掉任一条都不会被「总数恰好 N」以外的方式发现。
check(count(waf, "if (!s.enabled) return '站点已停用：改动会保存，启用站点后才下发'") === 1,
  '逐站门控提示如实说明「保存但不下发」')
check(count(waf, '`${stoppedPending} 个站点已停用：改动会保存，启用站点后才下发`') === 1,
  '工具条汇总提示如实说明「保存但不下发」')
check(count(waf, 's.enabled && canApply.value && dirty(s)') === 0,
  '「应用全部」不再把停用站点排除在外')

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：WAF P2 接线守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('PASS：WAF P2 接线完整')

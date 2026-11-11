#!/usr/bin/env node
// WAF 呈现接线守卫。
// 纯函数单测只能证明 wafBadge/wafDetail/wafCoverage 本身对，挡不住视图里另写死一套
// （未开启又变回灰破折号、两档又共用绿徽章、两页各算一遍覆盖率、摘要只挂在列上
//   不进展开、IP 名单又被塞回 wafOn 条件里让未开 WAF 的站点丢掉访问控制）。
// 判据一律指向被检查的那份模板片段，且先剔注释，避免注释里的复述造成假绿。
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

const sites = strip(read('src/views/SitesView.vue'))
const wafCell = /<td v-if="shown\('waf'\)"[^>]*>[\s\S]*?<\/td>/.exec(sites)?.[0] ?? null
check(!!wafCell, '能定位 SitesView 的 WAF 单元格（判据自校验，取不到即判红）')
if (wafCell) {
  check(count(wafCell, 'wafBadge(s).cls') === 1, 'WAF 列徽章色接 wafBadge')
  check(count(wafCell, 'wafBadge(s).label') === 1, 'WAF 列文案接 wafBadge')
  check(count(wafCell, ':title="wafDetail(s)"') === 1, 'WAF 列 title 接 wafDetail')
  check(count(wafCell, 'badge-ok') === 0, 'WAF 列不再写死绿色徽章')
  check(count(wafCell, 'class="dim">—') === 0, '未开启不再退化成灰破折号')
}
check(count(sites, 'wafDetail(s)') === 2, '站点页 WAF 摘要恰好两处且都接 wafDetail（列 title + 行展开）')
check(count(sites, '<div class="d-item"><span class="d-k">WAF</span><span class="d-v">{{ wafDetail(s) }}</span></div>') === 1,
  '行展开有 WAF 完整摘要')
check(count(sites, 'wafCoverage(sites.value ?? []).off') === 1, '站点页汇总接 wafCoverage')
check(count(sites, '<RouterLink v-if="wafOffCount" class="waf-cover" to="/waf">') === 1, '汇总可点到 WAF 页')

const waf = strip(read('src/views/WafView.vue'))
check(count(waf, 'wafCoverage(sites.value)') === 1, 'WAF 页覆盖率接同一个 wafCoverage')
check(count(waf, 'sub: off ?') === 1, 'WAF 页未开启数用 off')
check(count(waf, 'total - on.length ?') === 0, 'WAF 页不再另算一遍口径')

const dlg = strip(read('src/components/SiteFormDialog.vue'))
check(count(dlg, "label: '安全与高级'") === 1, 'rail 安全分区名存在')
check(count(dlg, '<h4 class="sector-h">安全与高级</h4>') === 1, '正文安全分区名与 rail 一致')
check(count(dlg, "label: '日志 · 证书 · 原文'") === 1, 'rail 日志分区名存在')
check(count(dlg, '<h4 class="sector-h">日志 · 证书 · 原文</h4>') === 1, '正文日志分区名与 rail 一致')
check(count(dlg, 'class="sub-h"') === 1, 'WAF 区块有独立小节标题')
check(count(dlg, '.modal-body .sector > .sub-h { grid-column: 1 / -1; }') === 1,
  '小节标题跨两列（防 scoped 跨列规则失效）')

// P1：IP 名单从「访问控制与反代」搬进 WAF 区块，但**不能**放进 wafOn 条件里。
// 后端 ip_allow / ip_deny 独立于 waf_enabled 渲染；放进 v-if 会让未开 WAF 的站点
// 连访问控制都配不了。按「.waf 块 + 唯一的 </template> 边界」切两段验证归属。
const wafBlock = /<div class="waf">([\s\S]*?)<\/div>/.exec(dlg)?.[1] ?? null
check(!!wafBlock, '能定位编辑弹窗的 .waf 区块（判据自校验，取不到即判红）')
if (wafBlock) {
  check(count(wafBlock, '<template v-if="form.wafOn">') === 1, 'WAF 条件块恰好一个')
  const seg = wafBlock.split('</template>')
  check(seg.length === 2, 'WAF 区块只有一个条件 template 收口（判据自校验）')
  if (seg.length === 2) {
    check(!seg[0].includes('form.ipAllow') && !seg[0].includes('form.ipDeny'),
      'IP 名单不在 v-if="form.wafOn" 之内')
    check(seg[1].includes('form.ipAllow') && seg[1].includes('form.ipDeny'),
      'IP 名单留在 wafOn 条件之外（未开 WAF 仍可配访问控制）')
  }
  check(count(wafBlock, 'class="blk full adv-row waf-ip"') === 2, '两个 IP 名单字段都在 WAF 区块内')
}
check(count(dlg, 'v-model="form.ipAllow"') === 1, 'IP 白名单字段全站只有一处')
check(count(dlg, 'v-model="form.ipDeny"') === 1, 'IP 黑名单字段全站只有一处')
check(count(dlg, '.modal-body .waf > .waf-ip { grid-column: 1 / -1; margin: 0; }') === 1,
  'IP 名单在 .waf 网格内跨两列（防换容器后布局塌掉）')

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：WAF 呈现接线守卫 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log('PASS：WAF 呈现接线完整')

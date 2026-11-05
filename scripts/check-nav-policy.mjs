#!/usr/bin/env node
// F-05 / F-09 接线守卫：可达性判据只能有一份，且所有消费者必须真的接上。
//
// 为什么需要：把判据抽进 navPolicy.ts 之后，最危险的失败不是「判据写错」，
// 而是「某个视图没接」——它继续用旧的 METRICS_READ 兜底，测试与构建全绿，
// 只有用户看到 Tab 可见却点进去无权限。这类「配置项假控制」必须靠接线守卫。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let failed = 0
function must(cond, code, msg) {
  if (cond) { console.log(`  ✓ [${code}] ${msg}`); return }
  console.error(`  ✗ [${code}] ${msg}`)
  failed += 1
}

// ── [0] 活性自检：哨兵文件都在，且确实读到了内容（防「空集恒真」） ──
const FILES = [
  'src/composables/navPolicy.ts',
  'src/composables/navItems.ts',
  'src/components/SideNav.vue',
  'src/components/CommandPalette.vue',
  'src/layouts/MainLayout.vue',
  'src/views/LogCenterView.vue',
  'src/views/TaskCenterView.vue',
  'src/views/SecurityCenterView.vue',
  'src/router/index.ts',
]
const src = {}
for (const f of FILES) {
  must(existsSync(join(ROOT, f)), '0', `${f} 存在且可读`)
  if (existsSync(join(ROOT, f))) src[f] = read(f)
}
must(Object.keys(src).length >= 8, '0', `活性自检 ≥8/${FILES.length}：读入 ${Object.keys(src).length} 个文件`)
must(strip(src['src/composables/navPolicy.ts'] ?? '').includes('export function whyDisabledForPath'), '0',
  '活性自检：navPolicy.ts 确实是判据源（含 whyDisabledForPath 定义）')

// ── [1] 每个消费者都必须真的调用同一判据 ──
const CONSUMERS = {
  'src/components/SideNav.vue': 'whyDisabledForPath(',
  'src/components/CommandPalette.vue': 'whyDisabledForPath(',
  'src/layouts/MainLayout.vue': 'whyDisabledForPath(',
  'src/views/LogCenterView.vue': 'whyDisabledForPath(',
  'src/views/TaskCenterView.vue': 'whyDisabledForPath(',
  'src/views/SecurityCenterView.vue': 'whyDisabledForPath(',
  'src/router/index.ts': 'navGuardDecision(',
}
for (const [f, needle] of Object.entries(CONSUMERS)) {
  const body = strip(src[f] ?? '')
  must(body.includes(needle), '1', `${f} → ${needle}`)
  must(body.includes("from '@/composables/navPolicy'"), '1', `${f} 从 navPolicy 导入`)
}

// ── [2] 不许再有「拿 METRICS_READ 当恒真兜底」的旧判据 ──
for (const f of Object.keys(CONSUMERS)) {
  const body = strip(src[f] ?? '')
  must(!body.includes('whyDisabled(CAP.METRICS_READ'), '2', `${f} 无 METRICS_READ 兜底判据`)
  must(!/\bauth\.whyDisabled\(/.test(body), '2', `${f} 无裸 auth.whyDisabled 调用`)
}

// ── [3] 恒显语义：恰好 8 条，且只在定义处出现 METRICS_READ ──
const navItems = src['src/composables/navItems.ts'] ?? ''
must((navItems.match(/cap: ALWAYS_CAP/g) ?? []).length === 8, '3', 'navItems.ts 恒显项恰好 8 条')
must((strip(navItems).match(/CAP\.METRICS_READ/g) ?? []).length === 1, '3',
  'navItems.ts 里 CAP.METRICS_READ 只在 ALWAYS_CAP 定义处出现 1 次')
must(strip(navItems).includes('export const ALWAYS_CAP'), '3', 'ALWAYS_CAP 已导出')

// ── [4] 非导航门控表：键集合恰好等于四项，不许悄悄增删 ──
const policy = strip(src['src/composables/navPolicy.ts'] ?? '')
const block = policy.slice(policy.indexOf('const EXTRA_GATES'), policy.indexOf('function normalize'))
const keys = [...block.matchAll(/^\s*'(\/[^']+)':\s*\{/gm)].map((m) => m[1]).sort()
const WANT = ['/cron/tasks', '/firewall/baseline', '/logs/audit', '/notifications'].sort()
must(keys.length === 4 && JSON.stringify(keys) === JSON.stringify(WANT), '4',
  `EXTRA_GATES 键集合恰好 4 项：${keys.join(', ')}`)
must(block.includes("cap: null, perm: 'system.view'"), '4', '/notifications 显式声明 system.view')

// ── [5] 路由守卫接线：取状态 + 纯决策 + 失败 toast ──
const routerBody = strip(src['src/router/index.ts'] ?? '')
const g = routerBody.slice(routerBody.indexOf('router.beforeEach'))
must(g.includes('whyDisabledForPath(auth, to.path)'), '5', 'beforeEach 取同一份判据')
must(g.includes('capsLoaded: Object.keys(auth.capabilities).length > 0'), '5', '能力矩阵未加载时放行')
must(g.includes('navGuardDecision('), '5', '守卫调纯决策函数')
must(g.includes('toast(') && g.includes("'err'"), '5', '被挡时有可见失败提示')
must(g.includes('return decision'), '5', '决策结果真的被返回（不是算完不用）')

if (failed > 0) {
  console.error(`\nFAIL：check-nav-policy ${failed} 项未通过`)
  process.exit(1)
}
console.log('\nPASS：check-nav-policy 全部通过')

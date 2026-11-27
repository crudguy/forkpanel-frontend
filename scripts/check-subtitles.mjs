#!/usr/bin/env node
/**
 * 顶栏副标题覆盖率守卫。用法：`pnpm check:ui`（与其它 check-*.mjs 串联）。
 *
 * 为什么需要：顶栏副标题是 `MainLayout.vue` 里一张按 route.name 取值的静态表，
 * 而路由表在 `router/index.ts`——**两个文件、一处映射**。加路由时如果忘了补副标题，
 * 该页顶栏就静默少一行说明：`vue-tsc` 看不见、build 照过、页面照渲染，只有肉眼
 * 逐页翻才会发现（实测漏了 dashboard / files / firewall / notifications /
 * service-detail 五条）。这正是「契约层有、实现层丢」型的漏项，只能显式断言。
 *
 * 断言口径：
 *   [1] 路由表必须真的解析出 name（数量下限）——解析不到时下面的检查会恒绿。
 *   [1b] 反之，副标题表也得解析出键，否则同样是恒绿。
 *   [2] 除白名单外，每个 route.name 都必须有副标题。
 *   [3] 副标题表里不得残留已删路由的键（改路由名后容易忘删）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (id, msg) => { console.log(`  ✗ [${id}] ${msg}`); failures.push(id) }
const pass = (id, msg) => console.log(`  ✓ [${id}] ${msg}`)

// login 走独立全屏视图，没有顶栏，天然不需要副标题
const NO_SUBTITLE = new Set(['login'])
const MIN_ROUTES = 20

console.log('== 顶栏副标题覆盖率守卫 ==')

const router = readFileSync(join(root, 'src/router/index.ts'), 'utf8')
const layout = readFileSync(join(root, 'src/layouts/MainLayout.vue'), 'utf8')

const names = [...new Set([...router.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]))]
const block = layout.slice(layout.indexOf('const SUBTITLES'), layout.indexOf('const subtitle ='))
const keys = [...block.matchAll(/^\s*'?([a-z0-9-]+)'?:/gm)].map((m) => m[1])

if (names.length < MIN_ROUTES) {
  fail('1', `只解析出 ${names.length} 个 route.name（下限 ${MIN_ROUTES}）——正则失效会让下面恒绿`)
} else {
  pass('1', `解析出 ${names.length} 个 route.name`)
}
if (!keys.length) {
  fail('1b', 'SUBTITLES 表里一个键都没解析出来——正则失效会让下面恒绿')
} else {
  pass('1b', `解析出 ${keys.length} 条副标题`)
}

// 路由表都没解析出来时再谈覆盖率只会输出一个误导性的数字（实测会打出「-1 个」），
// 此时 [1] 已经报错，这里明确跳过而不是假通过。
if (names.length < MIN_ROUTES) {
  console.log('  – [2] 跳过：路由表未解析出 name，先修 [1]')
} else {
  const missing = names.filter((n) => !NO_SUBTITLE.has(n) && !keys.includes(n))
  if (missing.length) {
    fail('2', `缺副标题的路由 ${missing.length} 个：${missing.join('、')}`)
  } else {
    pass('2', `${names.length - NO_SUBTITLE.size} 个带顶栏的路由均有副标题`)
  }
}

const stale = keys.filter((k) => !names.includes(k))
if (stale.length) {
  fail('3', `副标题表里残留已不存在的路由 ${stale.length} 个：${stale.join('、')}`)
} else {
  pass('3', '副标题表无失效键')
}

// ── [4][5] 文案密度与口径（2026-11-27 复盘后新增）────────────────────────
// 为什么需要：副标题是**全局最贵的一行位置**（顶栏，每页必现），此前 30 条平均
// 43 字、最长 87 字，1280px 下每条都折成两行（29px）压在 27px 的页名下面——
// 说明比标题还高，顶栏被灰字填满；16/30 条还在末尾挂权限点与角色名。
// 这两条断言把「≤28 字、不写权限/角色」变成机器可判，而不是靠下次 review 记得。
const LIMIT = 28
const PERM_RE = /[a-z]+\.(manage|view|write)\b/
const ROLE_RE = /只读|操作员|管理员|owner|admin/i

const bodies = [...block.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'([^']*)'/gm)].map((m) => [m[1], m[2]])
if (!bodies.length) {
  fail('4', '一条副标题正文都没解析出来——正则失效会让 [4][5] 恒绿')
} else {
  const tooLong = bodies.filter(([, v]) => v.length > LIMIT)
  if (tooLong.length) {
    fail('4', `${tooLong.length} 条副标题超 ${LIMIT} 字（1280px 下会折行）：`
      + tooLong.map(([k, v]) => `${k}(${v.length}字)`).join('、'))
  } else {
    const max = Math.max(...bodies.map(([, v]) => v.length))
    pass('4', `${bodies.length} 条副标题均 ≤ ${LIMIT} 字（最长 ${max}）`)
  }
}

const leaked = bodies.filter(([, v]) => PERM_RE.test(v) || ROLE_RE.test(v))
if (leaked.length) {
  fail('5', `${leaked.length} 条副标题含权限点/角色名：`
    + leaked.map(([k]) => k).join('、')
    + '（能不能点由按钮 :title 与 EmptyState.reason 表达，顶栏不重复）')
} else {
  pass('5', '无副标题泄漏权限点或角色名')
}

if (failures.length) {
  console.log(`\nFAIL：副标题覆盖有 ${failures.length} 条问题（${failures.join(', ')}）`)
  process.exit(1)
}
console.log('\nPASS：顶栏副标题覆盖完整')

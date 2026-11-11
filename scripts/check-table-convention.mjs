#!/usr/bin/env node
/**
 * 「表格分页 + 表头排序」规范守卫（项目级）。
 * 用法：`pnpm check:ui`（由 scripts/run-ui-guards.mjs 汇总）；退出码非 0 即违规。
 *
 * 为什么需要：本规范要求**每张记录列表**都能自定义每页条数（10/20/50/100）且表头可点排序。
 * 这套接线散在 20+ 个视图/组件里，任何一处漏接，症状都是「这页看起来正常，就是没分页」——
 * `vue-tsc` / `vite build` / 单页点一遍全绿，只有逐页比对才发现。更常见的退化是
 * 「新加一张表时忘了接」，靠人肉 review 挡不住，故用登记表把决定钉死：
 *   要么接（必须能在文件里找到 <TablePager> / <SortTh>），
 *   要么**显式登记为例外并写明理由**（固定几行的 KV / 实时快照 / 服务端日志流）。
 *
 * 判据（剥离注释后再断言，避免"注释里提过"就算接）：
 *   [1] 扫描到的每个含 <table> 的 .vue 必须在 REGISTRY 里 —— 新表不登记直接红；
 *   [2] 登记的 <table> 数量必须与文件实际相等 —— 防止登记过时后恒绿；
 *   [3] pager: true 的文件必须真有 <TablePager> 用法；pager: false 的必须没有；
 *   [4] sort: true 的文件必须真有 <SortTh>；sort: false 的必须没有；
 *   [5] 客户端分页（client: true）必须调 useTableControls( —— 只写 pageRows 可能是手搓的；
 *   [6] 视图里不得再出现私有 `.pager {` 样式 —— 分页脚只有 TablePager 一个来源；
 *   [7] 活性自检：登记表至少 20 项、扫描到的表文件数与之相等（扫错目录/正则失效即红）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] ? process.argv[2] : join(root, 'src')

const R = (file, tables, opts = {}) => ({ file, tables, pager: true, sort: true, client: true, ...opts })

/**
 * 登记表：file 相对 src/；tables 为该文件里 `<table` 的数量；
 * pager/sort/client 表示「该文件的记录列表是否接了对应能力」；
 * note 只在例外时写理由（会打印出来，提醒 review 别把例外当默认）。
 */
const REGISTRY = [
  R('views/AppsView.vue', 1),
  R('views/AuditView.vue', 1, { sort: false, client: false, note: '服务端分页的审计流，跨页排序需后端 order 参数（本改动不含后端契约变更）' }),
  R('views/BackupsView.vue', 4, { note: '计划表 + 弹窗内三张产物表各自独立分页' }),
  R('views/CertsView.vue', 1),
  R('views/CronView.vue', 1),
  R('views/DatabasesView.vue', 2, { note: '连接表接；浏览数据表列由后端动态下发 + offset/limit 服务端分页，无法定义列比较函数' }),
  R('views/FilesView.vue', 1, { note: '目录列表：本地排序（目录恒在前）+ 分页；选仍按可见集' }),
  R('views/FirewallView.vue', 1),
  R('views/ProcessesView.vue', 1),
  R('views/SecurityView.vue', 1),
  R('views/ServicesView.vue', 1),
  R('views/SettingsView.vue', 2, { note: '角色表接；能力矩阵是固定行只读总览，按规范不分页也不排序' }),
  R('views/SitesView.vue', 1),
  R('views/TasksView.vue', 1),
  R('views/UsersView.vue', 1),
  R('views/WafView.vue', 3, { note: '站点/模板表接；拦截事件按页服务端取（接口无总数），事件流不做表头排序' }),
  R('components/containers/ComposeTab.vue', 3, { note: '编排 / 项目 / 下钻容器三张表各自独立分页' }),
  R('components/containers/ContainersTab.vue', 1),
  R('components/containers/ImagesTab.vue', 1),
  R('components/containers/NetworksTab.vue', 1),
  R('components/containers/StatsTab.vue', 1, { pager: false, sort: false, client: false, note: '实时指标快照：每 3s 整表重采样，分页/排序会破坏「同一时刻对照」的语义' }),
  R('components/containers/VolumesTab.vue', 1),
  // SQL 控制台的查询结果网格：列是任意 SQL 的投影、行数由 LIMIT 截断且已在界面上说明，
  // 不是「可翻页的记录列表」（分页会让"这条 SQL 返回了哪些行"变得不可核对）。
  R('components/SqlConsole.vue', 1, { pager: false, sort: false, client: false, note: 'SQL 结果网格：列/行由查询本身决定，不分页不排序' }),
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 剔注释：HTML 注释 / 块注释 / 整行行注释。本仓 .vue 里没有含 `//` 的字符串字面量，安全 */
function stripComments(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const files = walk(SRC)
const withTables = files.filter((f) => stripComments(readFileSync(f, 'utf-8')).includes('<table'))

const fail = []
const byRel = new Map(withTables.map((f) => [relative(SRC, f).split('\\').join('/'), f]))

// [7] 活性自检：扫到的文件数必须与登记表一致，且都不为空
if (REGISTRY.length < 20) fail.push(`登记表只有 ${REGISTRY.length} 项（<20），疑似被误删`)
if (byRel.size !== REGISTRY.length) {
  fail.push(`扫描到 ${byRel.size} 个含 <table> 的 .vue，登记表 ${REGISTRY.length} 项 —— 数量不一致`)
}

for (const e of REGISTRY) {
  const abs = byRel.get(e.file)
  if (!abs) {
    fail.push(`[漏登记?] ${e.file} 在登记表里，但文件不存在或不含 <table>`)
    continue
  }
  const src = stripComments(readFileSync(abs, 'utf-8'))
  const tables = (src.match(/<table\b/g) ?? []).length
  if (tables !== e.tables) {
    fail.push(`[${e.file}] 实际 ${tables} 张表，登记 ${e.tables} 张 —— 增删表后请同步登记表`)
  }
  const hasPager = /<TablePager\b/.test(src)
  const hasSort = /<SortTh\b/.test(src)
  const hasClient = /useTableControls\s*[<(]/.test(src)
  if (e.pager !== hasPager) {
    fail.push(`[${e.file}] pager=${e.pager} 但${hasPager ? '有' : '没有'} <TablePager> 用法`)
  }
  if (e.sort !== hasSort) {
    fail.push(`[${e.file}] sort=${e.sort} 但${hasSort ? '有' : '没有'} <SortTh> 用法`)
  }
  if (e.client !== hasClient) {
    fail.push(`[${e.file}] client=${e.client} 但${hasClient ? '有' : '没有'} useTableControls( 调用`)
  }
}

// 未登记的表文件：新加表格页面必须先做决定（接 / 登记例外）
const registered = new Set(REGISTRY.map((e) => e.file))
for (const rel of byRel.keys()) {
  if (!registered.has(rel)) fail.push(`[未登记] ${rel} 含 <table> 但不在登记表里：接规范，或登记为例外+理由`)
}

// [6] 分页脚单一来源：视图里不得再私有写 .pager 样式（TablePager 自己除外）
for (const f of files) {
  const rel = relative(SRC, f).split('\\').join('/')
  if (rel === 'components/TablePager.vue') continue
  const src = readFileSync(f, 'utf-8')
  if (/^\s*\.pager\s*\{/m.test(src)) {
    fail.push(`[${rel}] 私有 .pager 样式：分页脚只能用 <TablePager>（样式在组件内）`)
  }
}

if (fail.length) {
  console.error('FAIL：表格分页/排序规范未满足')
  for (const m of fail) console.error('  ✗ ' + m)
  process.exit(1)
}

const notes = REGISTRY.filter((e) => e.note)
console.log(`PASS：${REGISTRY.length} 个含表格的文件全部登记，${notes.length} 项带例外说明`)
for (const e of notes) console.log(`  · ${e.file}：${e.note}`)

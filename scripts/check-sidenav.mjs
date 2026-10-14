#!/usr/bin/env node
/**
 * 侧边栏折叠态的**结构性守卫**（用法：`pnpm check:ui`；退出码非 0 即有违规）。
 *
 * 为什么需要这么一道纯文本检查：这两处问题全在 CSS / 模板层，
 * `vue-tsc` 类型检查看不见、`vite build` 照常成功、页面也照常渲染——
 * 只是折叠之后品牌区露出半截 "Fo"、折叠按钮被挤出可视区导致**收起来就展不开**。
 * 类型系统对"元素被挤到可视区之外"这件事没有任何意见，所以只能显式断言。
 *
 * 被钉住的六条不变量（改回去立刻变红）：
 *   [1] 折叠态隐藏品牌文字——76px 栏宽装不下 logo+文字+按钮，靠挤只会得到 "Fo"
 *   [2] 品牌行里**不得**放按钮——这是"展不开"的成因（`margin-left:auto` 在满行里
 *       被推到可视区外，点不到）
 *   [3] 开关所在区块 `flex: none`——否则会被 `flex:1` 的导航区挤掉
 *   [4] 开关必须存在且折叠态隐藏其文字——它是唯一的展开入口，且 60px 宽装不下文字
 *   [5] 箭头方向：展开态朝左（收起）、折叠态朝右（展开）——chevron 原生朝右，
 *       靠 rotate 翻转表达"点了会往哪走"；翻转这两条 vue-tsc / build 同样不报错
 *   [6] 一级扁平菜单（2026-10-14 起：用户决定改回一级，取消「8 组折叠 + 组图标 drill-down」）。折叠态（76px）每路由一个图标直接点（icon-per-route），不再有组图标中转、不再有 drill-down。拆分：
 *   [6a] 折叠态每个菜单项直接渲染自身路由图标 `it.icon`（icon-per-route），不用组图标
 *   [6b] 折叠态无「分组→子项」drill：不得出现 isCollapsedDirect / openGroups / 组按钮 / .sub
 *   [6c] 一级菜单：折叠态不存在嵌套子项块 `.collapsed .sub`（无缩进+引导线的上下级）
 *   [6d] 折叠态无「上级/下级图标差一档」设定（`.collapsed .sub .item .ico` 应消失）
 *   [6e] 折叠态 `.item` 图标居中（justify-content:center），保证 18 图标直接可见可达
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 可传入路径覆盖（负向验证用：拿一份**故意改坏**的副本跑，确认守卫真的会红）
const FILE = process.argv[2] ? process.argv[2] : join(root, 'src/components/SideNav.vue')
const src = readFileSync(FILE, 'utf8')
console.log(`（检查 ${FILE}）`)

const styleAt = src.indexOf('<style')
const template = src.slice(src.indexOf('<template>'), styleAt)
const style = src.slice(styleAt)

/** 取出某个选择器的规则体（选择器按字面量精确匹配，允许 `{` 前有空格）。 */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = style.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : null
}

const failures = []

function must(cond, id, msg) {
  if (cond) {
    console.log(`  ✓ [${id}] ${msg}`)
  } else {
    console.log(`  ✗ [${id}] ${msg}`)
    failures.push(id)
  }
}

console.log('== 侧边栏折叠态守卫 ==')

// [1] 折叠态隐藏品牌文字
const brandName = ruleBody('.collapsed .brand-name')
must(
  brandName !== null && /display\s*:\s*none/.test(brandName),
  '1',
  '折叠态必须 display:none 品牌文字（否则 76px 栏宽会把 ForkPanel 挤成半截 "Fo"）',
)

// [2] 品牌行里不得放按钮
const brandFrom = template.indexOf('class="brand"')
const brandTo = template.indexOf('<nav')
const brandBlock = brandFrom >= 0 && brandTo > brandFrom ? template.slice(brandFrom, brandTo) : ''
must(
  brandBlock.length > 0 && !/<button/.test(brandBlock),
  '2',
  '折叠开关不得放在品牌行内：该行在折叠态已被图标占满，margin-left:auto 的按钮会被挤出可视区',
)

// [3] 开关区块不被导航区挤掉
const bottom = ruleBody('.bottom')
must(
  bottom !== null && /(^|;|\s)flex\s*:\s*none/.test(bottom),
  '3',
  '`.bottom` 必须 flex:none，否则会被 flex:1 的导航区挤掉、开关再次点不到',
)

// [4] 开关存在 + 折叠态隐藏其文字
const toggleLabel = ruleBody('.collapsed .toggle-label')
must(
  /class="toggle"/.test(template) && ruleBody('.toggle') !== null && /@click/.test(template),
  '4a',
  '必须存在可点击的折叠开关（.toggle + @click）——它是唯一的展开入口',
)
must(
  toggleLabel !== null && /display\s*:\s*none/.test(toggleLabel),
  '4b',
  '折叠态必须隐藏开关文字：60px 宽装不下「收起侧边栏」，会折行或溢出',
)

// [5] 箭头方向：展开朝左、折叠朝右（chevron 原生朝右，靠 rotate 翻转）
//     `.chev`（基础=展开态）必须 rotate(180deg) → 朝左；
//     `.collapsed .chev` 必须 rotate(0deg) → 朝右。两条一起翻转＝手感反掉。
const chev = ruleBody('.chev')
const chevCollapsed = ruleBody('.collapsed .chev')
must(
  chev !== null && /rotate\(\s*180deg\s*\)/.test(chev),
  '5a',
  '展开态 chevron 必须 rotate(180deg)：箭头朝左=点它会收起',
)
must(
  chevCollapsed !== null && /rotate\(\s*0(?:deg)?\s*\)/.test(chevCollapsed),
  '5b',
  '折叠态 chevron 必须 rotate(0deg)：箭头朝右=点它会展开',
)

// [6] 一级扁平菜单（2026-10-14 起）。折叠态（76px）每路由一个图标直接点
//     （icon-per-route），不再有组图标中转、不再有 drill-down。五条断言：
//       [6a] 每个菜单项直接渲染自身路由图标 `it.icon`（非组图标 `g.gicon`）。
//       [6b] 无「分组→子项」drill：模板不得出现 isCollapsedDirect / openGroups /
//             组按钮（class="grp"）/ 嵌套子项块 .sub。
//       [6c] 一级菜单：折叠态不存在嵌套子项块 `.collapsed .sub`。
//       [6d] 无「上级/下级图标差一档」设定（`.collapsed .sub .item .ico` 应消失）。
//       [6e] 折叠态 `.item` 图标居中（justify-content:center），18 图标直接可见可达。
//     这些同样 vue-tsc / build 都不报错，只能显式断言。
must(
  /<Icon[^>]*:name="it\.icon"/.test(template),
  '6a',
  '折叠态每个菜单项必须直接渲染自身路由图标 `it.icon`（icon-per-route），不再用组图标 `g.gicon` 中转',
)
must(
  !/isCollapsedDirect|openGroups|gicon/.test(template) &&
    !/class="grp"/.test(template) &&
    !/\.sub\b/.test(style),
  '6b',
  '折叠态不得有「分组→子项」drill：模板不得出现 isCollapsedDirect / openGroups / gicon / class="grp" 组按钮，样式不得有 .sub 嵌套块',
)
const subCollapsed = ruleBody('.collapsed .sub')
must(
  subCollapsed === null,
  '6c',
  '一级菜单：折叠态不得存在嵌套子项块 `.collapsed .sub`（无缩进+引导线的上下级层级）',
)
must(
  ruleBody('.collapsed .sub .item .ico') === null,
  '6d',
  '折叠态不得存在「上级/下级图标差一档」设定（`.collapsed .sub .item .ico` 应消失）',
)
const itemCollapsed = ruleBody('.collapsed .item')
must(
  itemCollapsed !== null && /justify-content\s*:\s*center/.test(itemCollapsed),
  '6e',
  '折叠态 `.item` 必须图标居中（justify-content:center），保证 18 个路由图标直接可见可达',
)

if (failures.length) {
  console.log(`\nFAIL：侧边栏折叠态有 ${failures.length} 条违规（${failures.join(', ')}）`)
  process.exit(1)
}
console.log('\nPASS：侧边栏折叠态不变量全部满足')

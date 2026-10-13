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
 *   [6] 折叠态渲染**全部**条目（图标栏非空）——条目 v-if 必须旁路分组折叠
 *       `navCollapsed || openGroups.has(...)`；否则折叠后只剩当前组的图标，
 *       而折叠态组头是 pointer-events:none 的分隔线，用户无法展开其余组
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

// [6] 折叠态必须渲染全部条目（图标栏非空）
//     条目渲染的 v-if 必须带 `navCollapsed || ` 旁路。折叠态组头已退化为
//     pointer-events:none 的分隔线，若仍按 openGroups 裁条目，图标栏会只剩
//     「当前路由所在组」的图标、且用户无法展开其余组——图标栏形同空白
//     （A10 分组上线后实测：收起后侧栏仅 2 个图标 + 一大片空白）。
//     这条同样 vue-tsc / build 都不报错，只能显式断言。
must(
  /v-if="navCollapsed\s*\|\|\s*openGroups\.has\(/.test(template),
  '6',
  '折叠态必须旁路分组折叠：条目 v-if 需 `navCollapsed || openGroups.has(...)`，否则折叠后图标栏只剩当前组、其余菜单既看不到也点不到',
)

if (failures.length) {
  console.log(`\nFAIL：侧边栏折叠态有 ${failures.length} 条违规（${failures.join(', ')}）`)
  process.exit(1)
}
console.log('\nPASS：侧边栏折叠态不变量全部满足')

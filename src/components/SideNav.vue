<script setup lang="ts">
/**
 * 侧边导航。
 *
 * ⚠️ 纪律（同前）：菜单可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，
 * **禁止**出现 isLinux / navigator.platform / target_os 之类的平台判断。
 * 新模块的 cap 复用既有常量兜底（如明细类用 METRICS_READ），仅 perm 区分可见性。
 *
 * ── 折叠态的两个约定（都踩过坑，别再改回去）──
 * 1. 折叠后品牌区**只留应用图标**：栏宽 76px 装不下 logo(32) + 文字 + 按钮(26)，
 *    三者并存的结果是文字被挤成 "Fo"、按钮被挤出可视区。
 *    现在折叠态隐藏文字、去掉品牌行的按钮，只居中一个图标。
 * 2. 折叠开关**固定在底部**且两种状态都不换位置（VS Code / Supabase / 宝塔同款）。
 *    曾经的实现把它放在品牌行右侧，用的是 `margin-left:auto`——折叠后那行已被
 *    logo 占满，按钮被推到可视区之外，于是**收起来就再也展不开**。
 *    也刻意**不做**"点 logo 展开"：logo 在展开态点击没有语义（既非链接也不是开关），
 *    同一个元素在不同状态下做不同事，用户只会更犹豫该点哪里。
 * 3. 折叠态**保留「分组(上级) → 子项(下级)」层级**，不能拍平成 18 个平级图标
 *    （用户明确否定过"拍平"方案）：折叠后 76px 栏只渲染 8 个分组图标（上级），
 *    点分组图标 → 内联展开该组子项（下级）。单子项分组（安全/日志/任务）的组图标
 *    即自身、点之直接跳转；多子项分组点图标切换展开/收起。组头在折叠态是**可点**
 *    的图标按钮（不再是不可点的分隔线）。
 *    ⚠ 层级必须**看得见**：子项包在 `.sub` 块里（缩进 + 左引导线 + 图标小一档 16px），
 *    只保留 DOM 层级而视觉上与他人无异 = 用户看不出上下级（实测踩到）。
 *    判据见 scripts/check-sidenav.mjs [6a/6b/6c/6d]。
 *
 * ── 箭头方向约定（2026-09-30 调整）──
 * chevron 图标原生朝右（">"）。展开态旋转 180° → 朝左（点我会「收起」）；
 * 折叠态旋转 0°   → 朝右（点我会「展开」）。箭头即"点了侧边栏会往哪走"。
 *
 * ── 系统基础信息已移出侧边栏 ──
 * 底部的 distro·arch 原来塞在折叠开关上方，既挤占开关空间又和 topbar 重复。
 * 现统一放到 MainLayout 的 topbar 右侧状态簇，侧边栏底部只留折叠开关。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { NAV_ITEMS, GROUP_ICONS } from '@/composables/navItems'
import { navCollapsed, toggleNav, navDrawerOpen } from '@/composables/nav'
import Icon from '@/components/Icon.vue'

interface Item { to: string; label: string; icon: string; cap: string; perm: string; group: string }
/**
 * 渲染用菜单项 = 定义 + 预计算的禁用原因。
 *
 * 为什么不在模板里调 `why(it)`：原先每个 item 的 :class / :title / :aria-disabled /
 * :tabindex 各调一次，一轮渲染每个菜单项把权限矩阵查 4 遍。权限矩阵在 auth 里是
 * 稳定数据（不随渲染变化），放在 computed 里算一次即可（审计 P1-P3）。
 */
interface NavItem extends Item { off: string | null }

const auth = useAuthStore()

// 菜单项定义抽到 navItems.ts（与命令面板 A11 共用单一事实源），此处只算禁用原因。
// 可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，**禁止** isLinux / navigator.platform
// 之类平台判断。新模块 cap 复用既有常量兜底（明细类用 METRICS_READ），仅 perm 区分可见性。
// 仍是扁平列表（A10 分组是独立一期工作），group 字段供命令面板归类展示。
const items = computed<NavItem[]>(() =>
  NAV_ITEMS.map((it) => ({ ...it, off: auth.whyDisabled(it.cap, it.perm) })),
)

const route = useRoute()
// 含页内子 Tab 的菜单（主机监控 /system/*、软件与服务 /services/*、日志 /logs/audit、
// 任务 /cron/tasks、安全 /firewall/baseline）高亮按**前缀**匹配；
// 其余仍精确匹配——概览 '/' 是所有路径的前缀，绝不能改前缀，否则全页常亮。
function isOn(it: Item): boolean {
  return route.path === it.to || route.path.startsWith(it.to + '/')
}

// ── 能力域分组（A10）──────────────────────────────────────────────
// 18 项菜单扁平铺开需要滚动才能看全；按 navItems.ts 的 group 字段分 8 组，
// 组头可折叠、展开状态记忆到 localStorage；默认只展开「当前路由所在组」。
// 约束：分组只影响**渲染**，不影响可见性口径（仍是 cap AND perm，见 items）。
const GROUP_STORE = 'forkpanel.nav.groups'

/** 当前路由落在哪个分组（前缀匹配，与 isOn 同口径） */
function groupOfPath(p: string): string {
  const hit = NAV_ITEMS.find((n) => p === n.to || p.startsWith(n.to + '/'))
  return hit?.group ?? NAV_ITEMS[0].group
}

function readOpenGroups(): Set<string> {
  // 当前路由所在组**必须**在展开集里（深链直入 /logs 时若只信任存储，
  // 日志组仍是收起态，用户看不到自己所在页——实测踩到）。
  const must = groupOfPath(route.path)
  try {
    const raw = localStorage.getItem(GROUP_STORE)
    if (raw) {
      const arr = JSON.parse(raw)
      // 存储损坏/非数组时退回默认，不让脏数据渲染出空侧栏
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        const set = new Set<string>(arr)
        set.add(must)
        return set
      }
    }
  } catch { /* 隐私模式等存储不可用：退回默认 */ }
  return new Set([must])
}

const openGroups = ref<Set<string>>(readOpenGroups())

function persistOpen() {
  try { localStorage.setItem(GROUP_STORE, JSON.stringify([...openGroups.value])) } catch { /* 忽略 */ }
}

function toggleGroup(name: string) {
  const next = new Set(openGroups.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  openGroups.value = next
  persistOpen()
}

// 跳转到的页面必须可见：所在组若在收起态则自动展开（并记忆）。
// 只自动展开、绝不自动收起——用户手动展开的组不应因跳转被悄悄关掉。
watch(() => route.path, (p) => {
  const g = groupOfPath(p)
  if (!openGroups.value.has(g)) {
    const next = new Set(openGroups.value)
    next.add(g)
    openGroups.value = next
    persistOpen()
  }
})

/** 渲染分组：保持 navItems.ts 的定义顺序；空组不会出现（从 items 派生） */
const groups = computed(() => {
  const out: { name: string; gicon: string; list: NavItem[] }[] = []
  for (const it of items.value) {
    const hit = out.find((x) => x.name === it.group)
    if (hit) hit.list.push(it)
    else out.push({ name: it.group, gicon: GROUP_ICONS[it.group] || it.icon, list: [it] })
  }
  return out
})

// 折叠态分组图标（上级菜单）的点击行为：
// - 单子项分组（安全/日志/任务）：组图标即自身，点之直接跳转（展开只会露出同一子项，冗余）。
// - 多子项分组：点之切换展开/收起，子项在该组位置下方内联展开，保留上级→下级层级。
//
// `isCollapsedDirect` 是「折叠态该组是否直达」的**单一判据**：子项 v-if、点击行为、
// title / aria-expanded / 禁用态四处共用同一函数，避免同一条约束散成多份而漂移。
const router = useRouter()
function go(to: string) { router.push(to) }
function groupHasCurrent(g: { list: NavItem[] }): boolean {
  return g.list.some((it) => isOn(it))
}
/** 折叠态「直达组」：父级下只有 1 个子项 → 组图标即子项本身，点它是跳转而非展开 */
function isCollapsedDirect(g: { list: NavItem[] }): boolean {
  return navCollapsed.value && g.list.length === 1
}
/** 组按钮 tooltip：直达组不说「展开/收起」（点它是跳转）；子项无权限时透出禁用原因 */
function groupTitle(g: { name: string; list: NavItem[] }): string {
  if (isCollapsedDirect(g)) return g.list[0].off ?? g.list[0].label
  // 脚本里没有模板的 ref 自动解包：这里必须 `.value`
  return openGroups.value.has(g.name) ? `收起「${g.name}」` : `展开「${g.name}」`
}
function onGroupClick(g: { name: string; list: NavItem[] }) {
  // 直达组：无权限（it.off）时不跳转，与展开态 `.item.disabled` 同口径
  if (isCollapsedDirect(g)) { if (!g.list[0].off) go(g.list[0].to); return }
  toggleGroup(g.name)
}
</script>

<template>
  <aside class="side" :class="{ collapsed: navCollapsed, 'is-drawer': navDrawerOpen }">
    <div class="brand">
      <div class="logo"><Icon name="dog" :size="25" /></div>
      <span class="brand-name">ForkPanel</span>
    </div>

    <nav class="nav">
      <!-- 分组菜单（A10）：组头可折叠；收起用 v-if 直接移除 DOM（Tab / 读屏均不可达），
           展开的组由 openGroups 驱动并记忆到 localStorage。 -->
      <template v-for="g in groups" :key="g.name">
        <button class="grp" type="button"
          :class="{ on: groupHasCurrent(g), disabled: isCollapsedDirect(g) && !!g.list[0].off }"
          :aria-expanded="isCollapsedDirect(g) ? undefined : openGroups.has(g.name)"
          :title="groupTitle(g)"
          :aria-disabled="isCollapsedDirect(g) && g.list[0].off ? 'true' : undefined"
          @click="onGroupClick(g)">
          <!-- 折叠态：组头退化成组图标（上级菜单，可点内联展开子项）；展开态：文字 + chevron（原样） -->
          <Icon v-if="navCollapsed" :name="g.gicon" :size="19" class="grp-ico" />
          <template v-else>
            <span class="grp-t">{{ g.name }}</span>
            <Icon name="chevron" :size="12" class="grp-chev" :class="{ open: openGroups.has(g.name) }" />
          </template>
        </button>
        <!-- 子项（下级菜单）：按 openGroups 内联展开，保留上级→下级层级。
             折叠态「直达组」（单子项：安全/日志/任务）不再重复渲染子项——组图标即自身、点之已跳转。
             子项包在 `.sub` 块里：折叠态该块整体缩进 + 左引导线，与上方分组图标（上级）
             形成可辨识的从属关系；展开态 `.sub` 只是等距容器，视觉与原先一致。 -->
        <template v-if="openGroups.has(g.name) && !isCollapsedDirect(g)">
          <div class="sub">
            <RouterLink
              v-for="it in g.list"
              :key="it.to"
              :to="it.to"
              class="item"
              :class="{ disabled: !!it.off, on: isOn(it) }"
              :title="it.off ?? it.label"
              :aria-label="it.label"
              :aria-current="isOn(it) ? 'page' : undefined"
              :aria-disabled="it.off ? 'true' : undefined"
              :tabindex="it.off ? -1 : undefined"
            >
              <Icon :name="it.icon" :size="19" class="ico" />
              <span class="label">{{ it.label }}</span>
            </RouterLink>
          </div>
        </template>
      </template>
    </nav>

    <!-- 底部固定区：只放折叠开关。两种状态都不换位置，用户学一次就够。
         系统基础信息（distro·arch 等）已移往 MainLayout 的 topbar 右侧状态簇。 -->
    <div class="bottom">
      <button class="toggle" :title="navCollapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-expanded="!navCollapsed" @click="toggleNav">
        <Icon name="chevron" :size="16" class="chev" />
        <span class="toggle-label">收起侧边栏</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: 234px; flex: none;
  display: flex; flex-direction: column;
  /* 侧栏背板（B1）：比内容区暗一档，与卡片形成「暗背板 → 内容 → 亮卡片」的层级 */
  background: var(--bg-nav);
  border-right: 1px solid var(--c-border);
  transition: width .2s ease;
  position: sticky; top: 0; height: 100vh;
}
.side.collapsed { width: 76px; }

.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 16px 14px;
}
.logo {
  width: 32px; height: 32px; border-radius: 9px; flex: none;
  display: grid; place-items: center; color: #fff;
  background: var(--gradient); box-shadow: var(--glow);
}
.brand-name { font-weight: 700; font-size: var(--fs-16); letter-spacing: .3px; }
/* 折叠态：只留图标。文字必须 display:none 而不是靠容器裁切——
   76px 的栏宽装不下 logo+文字+按钮，靠挤只会得到 "Fo" 这种半截文本。 */
.collapsed .brand { justify-content: center; gap: 0; padding: 16px 0 14px; }
.collapsed .brand-name { display: none; }

.nav { flex: 1; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 3px; }

/* ── 分组头（A10）── 可点击折叠。行高：组头 ~26px、菜单项压到 ~38px（原 42-45px）；
   「当前组展开 + 其余折叠」形态下 18 项一屏看全，不再需要滚动找菜单。 */
.grp {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 6px 11px 4px; margin-top: 4px;
  border: none; background: transparent; cursor: pointer; text-align: left;
  color: var(--c-text-mute); font-size: var(--fs-12); font-weight: 600;
  letter-spacing: .5px; font-family: inherit;
}
.grp:hover { color: var(--c-text-dim); }
.grp-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* chevron 原生朝右：收起 = 朝右(0)；展开 = 旋转 90° 朝下 */
.grp-chev { flex: none; transition: transform .16s ease; }
.grp-chev.open { transform: rotate(90deg); }
/* 子项块（下级菜单）。展开态只是等距容器，行距与原扁平列表一致（gap 3px）；
   折叠态才启用「缩进 + 左引导线」（见 .collapsed .sub），和上级图标拉开层级。 */
.sub { display: flex; flex-direction: column; gap: 3px; }
/* 折叠态（76px）：分组头 = 组图标按钮（上级菜单），可点内联展开子项；
   不再是不可点的分隔线——否则用户无法在折叠态展开分组（A10 后实测踩到）。 */
.collapsed .grp {
  display: flex; align-items: center; justify-content: center;
  width: 100%; padding: 10px; margin: 0 0 1px;
  border: none; background: transparent; cursor: pointer; border-radius: 10px;
  color: var(--c-text-dim);
}
.collapsed .grp:hover { background: var(--c-hover); color: var(--c-text); }
.collapsed .grp.on { color: var(--c-primary); background: var(--c-active); }
.collapsed .grp-ico { flex: none; }
.collapsed .grp-t, .collapsed .grp-chev { display: none; }
/* 折叠态直达组（单子项）而该子项无权限：与展开态 .item.disabled 同口径（置灰 + 不可点） */
.grp.disabled { opacity: .4; pointer-events: none; }

.item {
  position: relative;
  display: flex; align-items: center; gap: 11px;
  padding: 7px 11px; border-radius: 10px;
  color: var(--c-text-dim); text-decoration: none; font-size: var(--fs-14);
  transition: background .14s ease, color .14s ease;
}
.item:hover:not(.disabled) { background: var(--c-hover); color: var(--c-text); }
.item .ico { flex: none; }
.collapsed .label { display: none; }
/* 折叠态基础条目：图标居中（无 .sub 包裹时用，如窄屏抽屉内的兜底） */
.collapsed .item { justify-content: center; padding: 8px; }
/* 折叠态子项块：整体右移 + 左侧引导线，视觉从属于上方的分组图标（上级）。
   层级必须靠「缩进 + 引导线 + 图标小一档」三重视觉区分——只靠展开/收起状态区分
   在 76px 栏里等于没有（实测改动前上级/下级图标几何完全一致：同为 left 28 / 19×19）。 */
.collapsed .sub { margin: 2px 0 4px 10px; padding-left: 8px; border-left: 1px solid var(--c-border); }
.collapsed .sub .item { padding: 7px 6px; }
.collapsed .sub .item .ico { width: 16px; height: 16px; }
/* 子项当前项：左侧已有引导线，去掉外挑的高亮竖条（否则与引导线叠在一起） */
.collapsed .sub .item.on::before { content: none; }

.item.router-link-exact-active,
.item.on {
  color: var(--c-primary); background: var(--c-active); font-weight: 600;
}
.item.router-link-exact-active::before,
.item.on::before {
  content: ''; position: absolute; left: -12px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 20px; border-radius: 0 3px 3px 0; background: var(--gradient);
  box-shadow: 0 0 10px var(--c-primary);
}
.item.disabled { opacity: .4; pointer-events: none; }

.bottom {
  flex: none; border-top: 1px solid var(--c-border);
  padding: 6px 8px 8px;
}
.toggle {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: none; background: transparent; cursor: pointer;
  color: var(--c-text-dim); border-radius: 10px; font-size: var(--fs-13); font-family: inherit;
  transition: background .14s ease, color .14s ease;
}
.toggle:hover { background: var(--c-hover); color: var(--c-text); }
.chev { flex: none; transition: transform .2s ease; transform: rotate(180deg); }
/* 展开态箭头朝左（点我会收起），折叠态翻转朝右（点我会展开）。
   箭头方向即"点了侧边栏会往哪走"，与主流面板一致。 */
.collapsed .chev { transform: rotate(0deg); }
.collapsed .toggle { justify-content: center; padding: 8px; }
.collapsed .toggle-label { display: none; }

/* 移动端抽屉（审计 R1）：<=900px 侧栏脱离文档流、默认滑出视口左侧，
   由顶栏汉堡按钮切换 .is-drawer 滑入。宽度强制 234px（不受桌面折叠态影响），
   遮罩由 MainLayout 提供。桌面端这套规则不生效，侧栏照常 sticky 常驻。 */
@media (max-width: 900px) {
  .side, .side.collapsed {
    position: fixed; top: 0; left: 0; z-index: 60; height: 100vh;
    width: 234px; transform: translateX(-100%);
    transition: transform .22s ease; box-shadow: var(--shadow-lg);
  }
  .side.is-drawer { transform: translateX(0); }
  /* 抽屉内不再提供折叠开关：抽屉本身即全宽浮层，折叠无意义且会误导 */
  .bottom { display: none; }
}
</style>

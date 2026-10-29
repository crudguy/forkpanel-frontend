<script setup lang="ts">
/**
 * 侧边导航（一级扁平模式，2026-10-14 起）。
 *
 * 设计变更：此前是「8 组折叠 + 折叠态组图标 drill-down」两级菜单。实际导航项
 * 由 `navItems.ts` 单一维护（当前 19 项），两级归类收益有限，而折叠态点到子项要
 * 多一层点击，体感更复杂。用户决定改回一级菜单——本文件即新实现。
 *
 * ⚠️ 本文件里若出现具体项数，属于**会过时的计数注释**：增删导航项时必须同步，
 *   否则后来者会照着错的基数改。故此处不再写死数字，改指回单一事实源。
 *
 * 一级模型：
 * - 展开态（234px）：全部导航项单列表，按 group 字段插入**静态**分组分隔线
 *   （不可点、不折叠、无 drill），保留「证书归哪」的归类提示但不增加操作步数。
 * - 折叠态（76px）：每路由一个图标直接点（icon-per-route），tooltip 出 label /
 *   禁用原因。不再有组图标中转、不再有 drill-down。
 *
 * ⚠️ 纪律（不变）：菜单可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，
 * 禁止 isLinux / navigator.platform / target_os 之类平台判断。
 *
 * 折叠态约定（仍有效，踩过的坑别再犯）：
 * 1. 折叠后品牌区只留应用图标（76px 装不下 logo+文字+按钮）。
 * 2. 折叠开关固定在底部、两态不换位置（VS Code / Supabase 同款）。
 * 3. 箭头方向：展开态 chevron 朝左（点我会收起）、折叠态朝右（点我会展开）。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { NAV_ITEMS } from '@/composables/navItems'
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
const items = computed<NavItem[]>(() =>
  NAV_ITEMS.map((it) => ({ ...it, off: auth.whyDisabled(it.cap, it.perm) })),
)

const route = useRoute()
// 高亮统一按**前缀**匹配（含页内子 Tab 的菜单如 /system/*、/services/*、
// /logs/audit、/cron/tasks、/firewall/baseline 都靠它）。
//
// ⚠️ 概览 `/` 不需要特殊照顾：拼成 `it.to + '/'` 后是 `'//'`，
//   `route.path.startsWith('//')` 恒为假，天然不参与前缀匹配。
//   此前注释写的是" '/' 匹配一切，靠长度取胜"——结论恰好正确，但推理是错的，
//   照那条推理去"优化"会引入回归（见下方 ⚠️ 双高亮说明）。
//
// ⚠️ 但纯前缀匹配在「一个菜单项是另一个的前缀」时会**双高亮**：例如历史上
// `/system` 曾是 `/system/expose` 的真前缀，访问公网访问页时「主机监控」和
// 「公网访问」会同时点亮，看起来像当前停在了两个地方。故取**最长前缀优先**：
// 只有当没有另一个更具体的菜单项也匹配时，才认为本项是当前项。
const matchedPath = computed(() => {
  let best = ''
  for (const it of items.value) {
    const hit = route.path === it.to || route.path.startsWith(it.to + '/')
    // '/' 是空前缀语义上匹配一切，但它的 to 长度是 1；用严格长度比较即可，
    // 因为任何以 '/' 开头且更长的命中都会胜过它（概览只在真的在首页时点亮）。
    if (hit && it.to.length > best.length) best = it.to
  }
  return best
})
function isOn(it: Item): boolean {
  return matchedPath.value === it.to
}

/**
 * 禁用项要「点不动，但说得出为什么不动」。
 *
 * ⚠️ 此前靠 CSS `.item.disabled { pointer-events: none }` 挡点击，副作用是把
 *    `:title`**（禁用原因）一起屏蔽了**——鼠标悬停什么都不出、键盘也够不着，
 *    用户只看到一项灰着，观感上等同于"这功能没做"。能力位不支持的项（如未装
 *    nginx 时的「公网访问」）尤其致命：看不出原因就无从补救。
 *
 * 故改为 JS 拦点击：元素照常接收 hover，tooltip 出得来，但点了不跳转。
 *
 * ⚠️ 必须是 `.capture` 而不是普通 `@click`：`<RouterLink>` 内部把
 *   `onClick: link.navigate` 挂在根 `<a>` 上，我们写在外层的 `@click` 会以
 *   fallthrough attr 合并成 `[navigate, 我们的处理器]`，**我们的那个后跑**
 *   ——那时 navigate 已经 push 过了，拦不住。加 `.capture` 后走
 *   `addEventListener(..., {capture:true})`，按 DOM 派发顺序先于 navigate，
 *   此时 `e.preventDefault()` 生效，navigate 开头检查
 *   `e.defaultPrevented` 直接返回，不跳转。
 *
 * 这一条由 `SideNav.disabledReason.test.ts` 源码级钉住（禁止回退 pointer-events，
 * 也禁止把 `.capture` 简化成普通 `@click`）。
 */
function onNavClick(it: NavItem, e: MouseEvent) {
  if (it.off) e.preventDefault()
}
</script>

<template>
  <aside class="side" :class="{ collapsed: navCollapsed, 'is-drawer': navDrawerOpen }">
    <div class="brand">
      <div class="logo"><Icon name="dog" :size="25" /></div>
      <span class="brand-name">ForkPanel</span>
    </div>

    <nav class="nav">
      <!-- 一级扁平列表：展开态按 group 插入静态分隔线（不可点、无 drill），保留归类提示；
           折叠态只渲染每路由图标，直接点跳转。 -->
      <template v-for="(it, i) in items" :key="it.to">
        <div v-if="!navCollapsed && i > 0 && items[i - 1].group !== it.group" class="grp-sep">
          <span>{{ it.group }}</span>
        </div>
        <RouterLink
          :to="it.to"
          class="item"
          :class="{ disabled: !!it.off, on: isOn(it) }"
          :title="it.off ?? it.label"
          :aria-label="it.label"
          :aria-current="isOn(it) ? 'page' : undefined"
          :aria-disabled="it.off ? 'true' : undefined"
          :tabindex="it.off ? -1 : undefined"
          @click.capture="onNavClick(it, $event)"
        >
          <Icon :name="it.icon" :size="19" class="ico" />
          <span class="label">{{ it.label }}</span>
        </RouterLink>
      </template>
    </nav>

    <!-- 底部固定区：只放折叠开关。两种状态都不换位置，用户学一次就够。 -->
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

/* 静态分组分隔线（不可点、不折叠、无 drill）：仅展开态显示，保留归类提示但不增加操作步数 */
.grp-sep {
  display: flex; align-items: center; gap: 6px;
  margin: 10px 0 2px; padding: 0 11px;
  color: var(--c-text-mute); font-size: var(--fs-12); font-weight: 600;
  letter-spacing: .5px;
}

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
/* 折叠态基础条目：图标居中（icon-per-route 直接点），无嵌套子项块包裹 */
.collapsed .item { justify-content: center; padding: 8px; }

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
/* 置灰但**必须保留 hover**：`:title`（禁用原因）是用户获知"为什么不能用"的
   唯一途径，`pointer-events: none` 会把它一起屏蔽——曾导致能力位不支持的菜单项
   悬停无任何提示，看起来像功能缺失。点击拦截改由 onNavClick 负责。 */
.item.disabled { opacity: .4; cursor: not-allowed; }

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

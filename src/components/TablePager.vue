<script setup lang="ts">
/**
 * 数据表分页条（项目规范，全站共用）。
 *
 * 统一形态：左侧「共 N 条 · 第 X / Y 页」，右侧「每页 <select> 条」+ 上一页 / 下一页。
 * 每页条数含「10 / 20 / 50 / 100 / 全部」五档；「全部」不分页、整表展示（`PAGE_SIZE_ALL`），
 * 服务端分页的表可传 `:allow-all="false"` 关掉它（避免一次拉全库）。
 * 此前各页自造分页脚（ProcessesView / AuditView / DatabasesView 三套长相、间距还不一致），
 * 抽成组件后一处改、处处变；间距与配色沿用 main.css 的 `.pager` 基线。
 *
 * 用法：`<TablePager :total :page :size :page-count @update:page @update:size />`
 * - 客户端分页（useTableControls）：把组合式的 page/size 传进来并转发其 gotoPage/changeSize；
 * - 服务端分页且**知道总数**（审计 / 数据库浏览）：传 `total` + `pageCount`，page/size 回传接口；
 * - 服务端分页但**不知道总数**（WAF 拦截事件：接口只给 limit/offset，不回 total）：
 *   `total` 传 null、`hasNext` 传本页是否还满，左侧只说「第 X 页」——不编一个假总数。
 *
 * **可见性由组件自己判**（`total > 最小档位`）：调用方不要再写 `v-if="total > size"`——
 * 那个判据是错的，30 条数据配默认 100 时会把分页脚藏起来，用户就再也切不到 10 条/页；
 * 反过来 5 条数据时露一条「第 1 / 1 页」纯属噪音。判据放这里，各页不可能各写一套。
 */
import { computed } from 'vue'
import { PAGE_SIZE_ALL, TABLE_PAGE_SIZES } from '@/composables/useTableControls'

// ⚠️ `allowAll` 必须经 withDefaults 声明默认 true：Vue 对**声明为 Boolean 且缺席**的 prop
// 会强制转成 false（不是 undefined），只靠 `props.allowAll !== false` 判默认值会得到相反结果——
// 「全部」会被静默地全站隐藏，而 style 块照常更新，极难发现。
const props = withDefaults(defineProps<{
  /** 已知总数；服务端不返回总数时传 null */
  total?: number | null
  page: number
  size: number
  /** total 已知时必填；未知时可省（用 hasNext 判末页） */
  pageCount?: number
  /** total 未知时用：还有没有下一页（本页取满即认为可能还有） */
  hasNext?: boolean
  /** 可选覆盖每页条数候选；缺省用全站规范 [10,20,50,100] */
  pageSizes?: readonly number[]
  /**
   * 是否显示「全部」档位（默认显示）。**服务端分页的表必须传 false**：
   * 它们把 size 当 limit/offset 发给接口，「全部」等于一次拉全库，会拖垮接口。
   */
  allowAll?: boolean
}>(), { allowAll: true })
const emit = defineEmits<{
  (e: 'update:page', v: number): void
  (e: 'update:size', v: number): void
}>()

const sizes = computed<readonly number[]>(() => props.pageSizes ?? TABLE_PAGE_SIZES)
/** 最小档位 = 「一页装得下就不必分页」的门槛；只在候选为空时退化到 100（防御脏入参） */
const minSize = computed(() => Math.min(...(sizes.value.length ? sizes.value : [100])))
const known = computed(() => typeof props.total === 'number')
/** 「全部」档位是否出现（服务端分页表传 allowAll=false 关掉） */
const showAll = computed(() => props.allowAll !== false)
const isAll = computed(() => props.size === PAGE_SIZE_ALL)
const visible = computed(() =>
  known.value ? (props.total as number) > minSize.value : props.page > 1 || !!props.hasNext)
const atEnd = computed(() => (known.value ? props.page >= (props.pageCount ?? 1) : !props.hasNext))
const summary = computed(() => {
  if (!known.value) return `第 ${props.page} 页`
  // 整表展示时没有「第 X / Y 页」的概念，直说「全部」更贴合语义
  if (isAll.value) return `共 ${props.total} 条 · 全部`
  return `共 ${props.total} 条 · 第 ${props.page} / ${props.pageCount ?? 1} 页`
})

function onSize(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value)
  emit('update:size', v)
}
</script>

<template>
  <div v-if="visible" class="pager">
    <span class="muted">{{ summary }}</span>
    <span class="spacer" />
    <label class="page-size">
      {{ isAll ? '显示' : '每页' }}
      <select class="ps-select" :value="size" aria-label="每页条数" @change="onSize">
        <option v-for="s in sizes" :key="s" :value="s">{{ s }}</option>
        <option v-if="showAll" :value="PAGE_SIZE_ALL">全部</option>
      </select>
      <template v-if="!isAll">条</template>
    </label>
    <button class="btn-ghost btn-sm" type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">上一页</button>
    <button class="btn-ghost btn-sm" type="button" :disabled="atEnd" @click="emit('update:page', page + 1)">下一页</button>
  </div>
</template>

<style scoped>
/* 自包含布局：组件走到哪，分页脚长一个样（不再依赖各页 scoped 的 .pager 基线）。
   与 AuditView / DatabasesView / ProcessesView 旧分页脚同构：左信息、右控件、上边线。

   自持**不透明**主题底色（暗 #181c26 / 亮 #f6f8fb）：此前分页脚是透明的、直接坐在卡片的
   半透明 --c-glass 上，容器底色偏白时次级灰字会被“吃掉”（白底白字 / 看不清）。给一个与文字
   同源于同一主题的实色底，无论外层是卡片、弹层还是裸页面都不会再透底。 */
.pager {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; font-size: var(--fs-13);
  border-top: 1px solid var(--c-border);
  background: var(--c-surface-2);
}
.spacer { flex: 1; }
/* 摘要文字显式取主题主文字色：全局 .muted 是给正文旁注的次级灰，放在「每页都要读」的
   分页脚上偏淡。这里覆盖掉，保证「共 N 条 · 第 X / Y 页」始终清晰。 */
.pager > .muted { color: var(--c-text); }
/* 「每页 N 条」选择框：视觉与全局 .filter / 进程页 .find 一致（同边框、同圆角、同高度 31px）。
   flex 允许收缩，窄屏先让选择框变窄而不是把上下页按钮挤出去。 */
.page-size { display: inline-flex; align-items: center; gap: 6px; color: var(--c-text-dim); white-space: nowrap; }
.ps-select {
  flex: 0 1 84px; min-width: 60px;
  height: 31px; padding: 0 8px;
  border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  background: var(--c-glass); color: var(--c-text);
  font-family: inherit; font-size: var(--fs-13);
}
.ps-select:focus { outline: none; border-color: var(--c-primary); }
</style>

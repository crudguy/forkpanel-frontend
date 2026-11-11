<script setup lang="ts">
/**
 * 数据表分页条（项目规范，全站共用）。
 *
 * 统一形态：左侧「共 N 条 · 第 X / Y 页」，右侧「每页 <select> 条」+ 上一页 / 下一页。
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
import { TABLE_PAGE_SIZES } from '@/composables/useTableControls'

const props = defineProps<{
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
}>()
const emit = defineEmits<{
  (e: 'update:page', v: number): void
  (e: 'update:size', v: number): void
}>()

const sizes = computed<readonly number[]>(() => props.pageSizes ?? TABLE_PAGE_SIZES)
/** 最小档位 = 「一页装得下就不必分页」的门槛；只在候选为空时退化到 100（防御脏入参） */
const minSize = computed(() => Math.min(...(sizes.value.length ? sizes.value : [100])))
const known = computed(() => typeof props.total === 'number')
const visible = computed(() =>
  known.value ? (props.total as number) > minSize.value : props.page > 1 || !!props.hasNext)
const atEnd = computed(() => (known.value ? props.page >= (props.pageCount ?? 1) : !props.hasNext))
const summary = computed(() =>
  known.value ? `共 ${props.total} 条 · 第 ${props.page} / ${props.pageCount ?? 1} 页` : `第 ${props.page} 页`)

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
      每页
      <select class="ps-select" :value="size" aria-label="每页条数" @change="onSize">
        <option v-for="s in sizes" :key="s" :value="s">{{ s }}</option>
      </select>
      条
    </label>
    <button class="btn-ghost btn-sm" type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">上一页</button>
    <button class="btn-ghost btn-sm" type="button" :disabled="atEnd" @click="emit('update:page', page + 1)">下一页</button>
  </div>
</template>

<style scoped>
/* 自包含布局：组件走到哪，分页脚长一个样（不再依赖各页 scoped 的 .pager 基线）。
   与 AuditView / DatabasesView / ProcessesView 旧分页脚同构：左信息、右控件、上边线。 */
.pager {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; font-size: var(--fs-13);
  border-top: 1px solid var(--c-border);
}
.spacer { flex: 1; }
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

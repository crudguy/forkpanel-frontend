<script setup lang="ts">
/**
 * 数据表分页条（项目规范，全站共用）。
 *
 * 统一形态：左侧「共 N 条 · 第 X / Y 页」，右侧「每页 <select> 条」+ 上一页 / 下一页。
 * 此前各页自造分页脚（ProcessesView / AuditView / DatabasesView 三套长相、间距还不一致），
 * 抽成组件后一处改、处处变；间距与配色沿用 main.css 的 `.pager` 基线。
 *
 * 用法：`<TablePager :total :page :size :page-count @update:page @update:size />`
 * - 服务端分页页：把 `page` / `size` 做成本地 ref（或 v-model）接到接口参数即可；
 * - 客户端分页（useTableControls）：把组合式的 page/size 传进来并转发其 gotoPage/changeSize。
 *
 * `pageCount` 单独传入而非内部算：服务端页的 count 来自 `total`，避免每页各算一遍口径不一。
 */
import { TABLE_PAGE_SIZES, type PageSize } from '@/composables/useTableControls'

const props = defineProps<{
  total: number
  page: number
  size: number
  pageCount: number
  /** 可选覆盖每页条数候选；缺省用全站规范 [10,20,50,100] */
  pageSizes?: readonly number[]
}>()
const emit = defineEmits<{
  (e: 'update:page', v: number): void
  (e: 'update:size', v: number): void
}>()

function onSize(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value)
  emit('update:size', v)
}
</script>

<template>
  <div class="pager">
    <span class="muted">共 {{ total }} 条 · 第 {{ page }} / {{ pageCount }} 页</span>
    <span class="spacer" />
    <label class="page-size">
      每页
      <select class="ps-select" :value="size" @change="onSize">
        <option v-for="s in (pageSizes ?? TABLE_PAGE_SIZES)" :key="s" :value="s">{{ s }}</option>
      </select>
      条
    </label>
    <button class="btn-ghost btn-sm" type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">上一页</button>
    <button class="btn-ghost btn-sm" type="button" :disabled="page >= pageCount" @click="emit('update:page', page + 1)">下一页</button>
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

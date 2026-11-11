<script setup lang="ts">
/**
 * 可排序表头（项目规范，全站共用）。
 *
 * 取代各页手写 `<th class="sortable" @click="toggleSort('x')">{{label}} {{sortInd('x')}}`——
 * 此前 ProcessesView / ServicesView / FilesView 各自拼这个，指示符还长得不一样。
 * 现在统一：点击切换升/降序、当前列高亮、右侧三角指示 ▲/▼，样式沿用 main.css 的
 * `.sortable` 基线（hover 提亮、active 用主题色）。
 *
 * 与 `useTableControls` 配合：父组件 `@sort` 调 `toggleSort(key)` 即可；
 * 不接组合式的服务端页也可直接用（父组件自己维护 key/dir）。
 *
 * ⚠ 非数据列（操作列、状态图标列等）**不要**用本组件——它们不参与排序，
 * 套上 `.sortable` 反而暗示可点，是误导。
 */
import type { SortDir } from '@/composables/useTableControls'

defineProps<{
  label: string
  /** 当前是否按这一列排序 */
  active?: boolean
  dir?: SortDir
}>()
const emit = defineEmits<{ (e: 'sort'): void }>()
</script>

<template>
  <th class="sortable" :class="{ active }" @click="emit('sort')">
    {{ label }}<span v-if="active" class="sort-ind">{{ dir === 'asc' ? '▲' : '▼' }}</span>
  </th>
</template>

<style scoped>
/* 排序表头交互：指针、hover 提亮、当前列用主题色（与 FilesView/ServicesView/ProcessesView
   旧写法同口径，但收进组件后一处改、处处变，不再各页漂移）。 */
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--c-text); }
.sortable.active { color: var(--c-primary); }
/* 三角与文字在同基线：用轻微左间距，不靠空格占位（空格在 scoped 里会跟变体一起被 strip） */
.sort-ind { margin-left: 3px; font-size: 0.82em; opacity: 0.85; }
</style>

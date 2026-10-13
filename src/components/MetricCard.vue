<script setup lang="ts">
/** 指标卡：标签 + 大数值 + 可选进度条 + 图标。不引图表库（保体积预算）。 */
import Icon from '@/components/Icon.vue'
import type { MetricTone } from '@/composables/metricTone'

defineProps<{
  label: string
  value: string
  unit?: string
  /** 副行（总量 / 出站速率等次要读数）。**恒定预留一行高度**——同行内有无副行的
      卡片保持等高、数值行基线对齐（评估 B7）。 */
  sub?: string
  icon?: string
  progress?: number // 0-100
  /** 语义色。联合类型与阈值刻度见 composables/metricTone.ts（单一事实源）。
      **不传 = 中性灰**——此前基础样式是品牌橙，漏传会被误读为「主操作」（B5）。 */
  tone?: MetricTone
}>()
</script>

<template>
  <div class="card stat">
    <div class="head">
      <span v-if="icon" class="ico" :class="tone"><Icon :name="icon" :size="18" /></span>
      <span class="label">{{ label }}</span>
    </div>
    <!-- .val 用 flex + baseline：数值与单位**同基线、永不折行**。此前是行内混排，
         长复合值会把单位挤到第二行（实测「45.7 GB / 102.1 GB」折行、卡片基线参差）。 -->
    <div class="val"><span class="num">{{ value }}</span><em v-if="unit">{{ unit }}</em></div>
    <div class="sub">{{ sub ?? '' }}</div>
    <div v-if="progress !== undefined" class="progress">
      <i :style="{ width: Math.min(100, Math.max(0, progress)) + '%' }" :class="tone" />
    </div>
  </div>
</template>

<style scoped>
.stat { display: flex; flex-direction: column; gap: 11px; }
.head { display: flex; align-items: center; gap: 9px; }
/* tone → 颜色。**基础（无 tone）= 中性 UI 灰**，不再默认品牌橙（B5）——
   数据卡漏传 tone 不应看起来像主操作；品牌橙须显式 tone="primary"。
   数据系列色（cpu/hot/load）引用 --chart-*，与图表柱/线同源、随主题切换。 */
.ico { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
      background: color-mix(in srgb, var(--c-text-dim) 16%, transparent); color: var(--c-text-dim); }
.ico.primary { background: var(--c-primary-soft); color: var(--c-primary); }
.ico.cyan { background: rgba(56, 189, 248, .14); color: var(--c-cyan); }
.ico.ok { background: var(--c-ok-soft); color: var(--c-ok); }
.ico.warn { background: var(--c-warn-bg); color: var(--c-warn); }
.ico.danger { background: var(--c-danger-soft); color: var(--c-danger); }
.ico.hot { background: color-mix(in srgb, var(--chart-hot) 18%, transparent); color: var(--chart-hot); }
.ico.cpu { background: color-mix(in srgb, var(--chart-cpu) 18%, transparent); color: var(--chart-cpu); }
.ico.load { background: color-mix(in srgb, var(--chart-load) 18%, transparent); color: var(--chart-load); }
.ico.neutral { background: color-mix(in srgb, var(--c-text-dim) 16%, transparent); color: var(--c-text-dim); }
.label { font-size: var(--fs-12-5); color: var(--c-text-dim); }
.val { display: flex; align-items: baseline; gap: 5px; min-width: 0;
      font-size: var(--fs-26); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.val .num { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.val em { font-style: normal; font-size: var(--fs-13); color: var(--c-text-dim); font-weight: 500; white-space: nowrap; }
/* 副行恒定占位：无副行的卡片也保留一行高度，同行卡片等高、数值行基线对齐（B7） */
.sub { min-height: 15px; font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.25;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.progress { height: 6px; }
/* 基础（无 tone）= 中性灰，理由同上；品牌橙渐变须显式 tone="primary" */
.progress > i { display: block; height: 100%; border-radius: 999px; background: var(--c-text-dim); }
.progress > i.primary { background: var(--gradient); }
.progress > i.cyan { background: var(--c-cyan); }
.progress > i.ok { background: var(--c-ok); }
.progress > i.warn { background: var(--c-warn); }
.progress > i.danger { background: var(--c-danger); }
.progress > i.hot { background: var(--chart-hot); }
.progress > i.cpu { background: var(--chart-cpu); }
.progress > i.load { background: var(--chart-load); }
.progress > i.neutral { background: var(--c-text-dim); }
</style>

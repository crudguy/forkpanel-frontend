<script setup lang="ts">
/** 指标卡。刻意不用图表库：首屏 JS 预算 ≤150KB gzip，ECharts 单库就 350KB。 */
defineProps<{ label: string; value: string; unit: string }>()
</script>

<template>
  <div class="card">
    <span class="label">{{ label }}</span>
    <span class="value">{{ value }}<em v-if="unit">{{ unit }}</em></span>
  </div>
</template>

<style scoped>
.card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 14px 16px; border: 1px solid var(--c-border); border-radius: 10px;
  background: var(--c-surface);
}
.label { font-size: 12px; color: var(--c-text-dim); }
.value { font-size: 24px; font-variant-numeric: tabular-nums; }
em { font-style: normal; font-size: 13px; color: var(--c-text-dim); margin-left: 4px; }
</style>

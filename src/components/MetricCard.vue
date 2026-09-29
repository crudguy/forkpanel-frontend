<script setup lang="ts">
/** 指标卡：标签 + 大数值 + 可选进度条 + 图标。不引图表库（保体积预算）。 */
import Icon from '@/components/Icon.vue'

defineProps<{
  label: string
  value: string
  unit?: string
  icon?: string
  progress?: number // 0-100
  tone?: 'primary' | 'cyan' | 'ok' | 'warn' | 'danger'
}>()
</script>

<template>
  <div class="card stat">
    <div class="head">
      <span v-if="icon" class="ico" :class="tone"><Icon :name="icon" :size="18" /></span>
      <span class="label">{{ label }}</span>
    </div>
    <div class="val">{{ value }}<em v-if="unit">{{ unit }}</em></div>
    <div v-if="progress !== undefined" class="progress">
      <i :style="{ width: Math.min(100, Math.max(0, progress)) + '%' }" :class="tone" />
    </div>
  </div>
</template>

<style scoped>
.stat { display: flex; flex-direction: column; gap: 11px; }
.head { display: flex; align-items: center; gap: 9px; }
.ico { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
      background: var(--c-primary-soft); color: var(--c-primary); }
.ico.cyan { background: rgba(56, 189, 248, .14); color: var(--c-cyan); }
.ico.ok { background: var(--c-ok-soft); color: var(--c-ok); }
.ico.warn { background: var(--c-warn-bg); color: var(--c-warn); }
.ico.danger { background: var(--c-danger-soft); color: var(--c-danger); }
.label { font-size: 12.5px; color: var(--c-text-dim); }
.val { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.val em { font-style: normal; font-size: 13px; color: var(--c-text-dim); margin-left: 5px; font-weight: 500; }
.progress { height: 6px; }
.progress > i { display: block; height: 100%; border-radius: 999px; background: var(--gradient); }
.progress > i.cyan { background: var(--c-cyan); }
.progress > i.ok { background: var(--c-ok); }
.progress > i.warn { background: var(--c-warn); }
.progress > i.danger { background: var(--c-danger); }
</style>

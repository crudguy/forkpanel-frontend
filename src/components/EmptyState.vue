<script setup lang="ts">
/**
 * 空状态 / 不可用状态。
 *
 * 关键：区分「没有数据」与「功能不可用」。后者必须说明原因，
 * 否则用户会以为面板坏了 —— 而不支持的原因恰恰来自能力矩阵。
 */
defineProps<{
  title: string
  hint?: string
  /** 能力不支持时给出后端返回的 reason */
  reason?: string
}>()
</script>

<template>
  <div class="empty">
    <p class="title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <p v-if="reason" class="reason">原因：{{ reason }}</p>
    <div v-if="$slots.cta" class="cta"><slot name="cta" /></div>
  </div>
</template>

<style scoped>
.empty { padding: 32px; text-align: center; border: 1px dashed var(--c-border); border-radius: var(--radius); }
.title { margin: 0 0 6px; font-size: var(--fs-14); }
.hint { margin: 0; font-size: var(--fs-13); color: var(--c-text-dim); }
.reason { margin: 6px 0 0; font-size: var(--fs-12); color: var(--c-warn); font-family: var(--mono); }
.cta { margin-top: 14px; display: flex; justify-content: center; }
</style>

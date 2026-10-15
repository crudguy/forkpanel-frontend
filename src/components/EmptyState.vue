<script setup lang="ts">
import { computed } from 'vue'
/**
 * 空状态 / 不可用状态。
 *
 * 关键：区分「没有数据」与「功能不可用」。后者必须说明原因，
 * 否则用户会以为面板坏了 —— 而不支持的原因恰恰来自能力矩阵。
 */
const props = defineProps<{
  title: string
  hint?: string
  /** 能力不支持时给出后端返回的 reason */
  reason?: string
}>()

/**
 * 能力位是**面板启动时探测一次并缓存**的（`state.capabilities`）。
 * 于是"我刚装好 nginx/openssl/docker，回来刷新页面按钮还是灰的"是预期行为——
 * 但不说清楚，用户只会认为面板坏了。故 `binary_missing` 时补一句重启提示。
 */
const needsRestart = computed(() => props.reason === 'binary_missing')
</script>

<template>
  <div class="empty">
    <p class="title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <p v-if="reason" class="reason">原因：{{ reason }}</p>
    <p v-if="needsRestart" class="tip">能力在面板启动时探测；若组件是刚安装的，需重启面板后才会重新检测。</p>
    <div v-if="$slots.cta" class="cta"><slot name="cta" /></div>
  </div>
</template>

<style scoped>
.empty { padding: 32px; text-align: center; border: 1px dashed var(--c-border); border-radius: var(--radius); }
.title { margin: 0 0 6px; font-size: var(--fs-14); }
.hint { margin: 0; font-size: var(--fs-13); color: var(--c-text-dim); }
.reason { margin: 6px 0 0; font-size: var(--fs-12); color: var(--c-warn); font-family: var(--mono); }
.tip { margin: 4px 0 0; font-size: var(--fs-12); color: var(--c-text-dim); }
.cta { margin-top: 14px; display: flex; justify-content: center; }
</style>

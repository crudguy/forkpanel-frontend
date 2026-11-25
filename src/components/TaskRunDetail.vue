<script setup lang="ts">
import { fmtDateTime, taskStateBadge, taskStateLabel } from '@/api/types'
import Icon from '@/components/Icon.vue'

/** 与后端 task_runs 实态对齐（契约 Task schema），字段与 TasksView 的 Task 同形。 */
interface Task {
  id: number; key: string; kind: string; state: string; progress: number
  started_at: number | null; finished_at: number | null; exit_code: number | null
  output_path?: string | null; duration_secs?: number | null; needs_human?: boolean
}

defineProps<{ task: Task; output: string; outLoading: boolean }>()
const emit = defineEmits<{ close: [] }>()

const stateText = taskStateLabel
function stateClass(s: string) { return taskStateBadge(s) }
</script>

<template>
  <div class="detail-card">
    <div class="sec-head">
      <Icon name="terminal" :size="16" />
      <span>任务 #{{ task.id }} · {{ task.key || task.kind }}</span>
      <span class="badge" :class="stateClass(task.state)">{{ stateText(task.state) }}</span>
      <span class="spacer" /><button class="btn-sm" type="button" @click="emit('close')">关闭</button>
    </div>
    <p class="meta">
      类型 <span class="mono">{{ task.kind }}</span>
      · 开始 {{ fmtDateTime(task.started_at) }}
      · 结束 {{ fmtDateTime(task.finished_at) }}
      · 耗时 <span class="mono">{{ task.duration_secs != null ? task.duration_secs + 's' : '—' }}</span>
      <template v-if="task.exit_code != null"> · 退出码 <span class="mono">{{ task.exit_code }}</span></template>
    </p>
    <pre v-if="outLoading" class="skeleton" style="height:120px" />
    <pre v-else class="out">{{ output }}</pre>
  </div>
</template>

<style scoped>
/* 行内展开：比外层卡片轻一档，靠底色与描边和所在数据行区分，不额外再套一层玻璃面板。 */
.detail-card { padding: 12px 14px; background: var(--c-active); border: 1px solid var(--c-border);
  border-radius: var(--radius-sm); }
.detail-card .sec-head { margin-bottom: 10px; }
.meta { margin: 0 0 10px; font-size: var(--fs-12-5); color: var(--c-text-dim); }
.out { margin: 0; padding: 14px; background: var(--c-bg); border: 1px solid var(--c-border);
  border-radius: var(--radius-sm); font-family: var(--mono); font-size: var(--fs-12-5);
  white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
</style>

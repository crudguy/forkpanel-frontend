<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { fmtDateTime, taskStateBadge, taskStateLabel } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

/** 与后端 task_runs 实态对齐（契约 Task schema） */
interface Task {
  id: number; key: string; kind: string; state: string; progress: number
  started_at: number | null; finished_at: number | null; exit_code: number | null
  output_path?: string | null; duration_secs?: number | null; needs_human?: boolean
}

const tasks = ref<Task[]>([])
const error = ref('')
const loading = ref(true)
const sel = ref<Task | null>(null)
const output = ref('')
const outLoading = ref(false)
let poll: number | undefined

async function load() {
  error.value = ''; loading.value = true
  try {
    const r = await api.get<Task[]>(API.tasks.list())
    tasks.value = Array.isArray(r) ? r : []
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
onMounted(load)

function isLive(t: Task | null) { return !!t && (t.state === 'running' || t.state === 'queued') }

function stopPoll() { if (poll) { clearInterval(poll); poll = undefined } }

/** 运行中任务每 2s 轮询单体详情刷新进度，结束态自动停止并刷新列表 */
function startPoll() {
  stopPoll()
  if (!isLive(sel.value)) return
  poll = window.setInterval(async () => {
    if (!sel.value) { stopPoll(); return }
    try {
      const d = await api.get<Task>(API.tasks.get(sel.value.id))
      sel.value = d
      if (!isLive(d)) { stopPoll(); load() }
    } catch { /* 瞬时错误忽略，下一轮重试 */ }
  }, 2000)
}

async function open(t: Task) {
  stopPoll()
  sel.value = { ...t }; outLoading.value = true; output.value = ''
  // 详情（拿派生字段 duration_secs 等）；失败则退回列表行数据
  try { sel.value = await api.get<Task>(API.tasks.get(t.id)) }
  catch { /* 列表行兜底 */ }
  // 输出：后端返回 {id, lines[]}（不是 output 字符串——旧代码在这里永远显示"无输出"）
  try {
    const r = await api.get<{ id: number; lines: string[] }>(API.tasks.output(t.id))
    output.value = r.lines?.length ? r.lines.join('\n') : '(无输出)'
  } catch (e) { output.value = errorText(e) }
  finally { outLoading.value = false }
  startPoll()
}

async function cancel(t: Task) {
  try {
    await api.post(API.tasks.cancel(t.id))
    load()
    if (sel.value?.id === t.id) open(t)
  } catch (e) { error.value = errorText(e) }
}

// 状态徽标/文案统一走共享词表（src/api/types.ts）：此前只认 'ok'，
// 且把英文 state 直接甩给用户；服务页判的却是 'done'——同一任务两处颜色不同
function stateClass(s: string) { return taskStateBadge(s) }
const stateText = taskStateLabel
function fmtTime(t?: number | null) { return fmtDateTime(t) }
onUnmounted(stopPoll)
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <div v-if="loading" class="skeleton box" />
    <template v-else>
      <div class="card flush">
        <table>
          <thead><tr><th>#</th><th>任务</th><th>状态</th><th class="num">进度</th><th>开始时间</th><th /></tr></thead>
          <tbody>
            <!-- 键盘可达（审计 P10）：行可 Tab 聚焦，Enter/Space 打开详情 -->
            <tr v-for="t in tasks" :key="t.id" :class="{ active: sel?.id === t.id }" @click="open(t)"
                tabindex="0" role="button" :aria-label="`查看任务 #${t.id} 详情`"
                @keydown.enter="open(t)" @keydown.space.prevent="open(t)" style="cursor:pointer">
              <td class="mono">{{ t.id }}</td>
              <td class="mono dim">{{ t.key || t.kind }}</td>
              <td>
                <span class="badge" :class="stateClass(t.state)">{{ stateText(t.state) }}</span>
                <span v-if="t.needs_human" class="badge badge-danger" title="任务被中断，需人工确认后续影响">需人工</span>
              </td>
              <td class="num">
                <div class="mini">
                  <div class="progress"><i :style="{ width: (t.progress ?? 0) + '%' }" /></div>
                  <span>{{ t.progress ?? 0 }}%</span>
                </div>
              </td>
              <td class="muted nowrap">{{ fmtTime(t.started_at) }}</td>
              <td class="nowrap">
                <button class="btn-sm" @click.stop="open(t)"><Icon name="terminal" :size="14" /> 输出</button>
                <button v-if="isLive(t)" class="btn-ghost btn-sm danger" @click.stop="cancel(t)">取消</button>
              </td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="6"><EmptyState title="暂无任务" /></td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="sel" class="card">
        <div class="sec-head">
          <Icon name="terminal" :size="16" /><span>任务 #{{ sel.id }} · {{ sel.key || sel.kind }}</span>
          <span class="badge" :class="stateClass(sel.state)">{{ stateText(sel.state) }}</span>
          <span class="spacer" /><button class="btn-sm" @click="stopPoll(); sel = null">关闭</button>
        </div>
        <p class="meta">
          类型 <span class="mono">{{ sel.kind }}</span>
          · 开始 {{ fmtTime(sel.started_at) }}
          · 结束 {{ fmtTime(sel.finished_at) }}
          · 耗时 <span class="mono">{{ sel.duration_secs != null ? sel.duration_secs + 's' : '—' }}</span>
          <template v-if="sel.exit_code != null"> · 退出码 <span class="mono">{{ sel.exit_code }}</span></template>
        </p>
        <pre v-if="outLoading" class="skeleton" style="height:120px" />
        <pre v-else class="out">{{ output }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.meta { margin: 0 0 10px; font-size: 12.5px; color: var(--c-text-dim); }
.box { height: 320px; border-radius: var(--radius); }
.mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.mini .progress { flex: 1; }
.mini span { font-size: 12px; color: var(--c-text-dim); font-variant-numeric: tabular-nums; }
tr.active { background: var(--c-active) !important; }
.out { margin: 0; padding: 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12.5px;
       white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
</style>

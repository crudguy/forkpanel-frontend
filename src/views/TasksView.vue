<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { fmtDateTime, taskStateBadge, taskStateLabel } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { useAsync } from '@/composables/useAsync'
import { usePolling } from '@/composables/usePolling'

/** 与后端 task_runs 实态对齐（契约 Task schema） */
interface Task {
  id: number; key: string; kind: string; state: string; progress: number
  started_at: number | null; finished_at: number | null; exit_code: number | null
  output_path?: string | null; duration_secs?: number | null; needs_human?: boolean
}

const auth = useAuthStore()
// 准入与取消动作分别对应后端 tasks.rs 的 TASK_VIEW / TASK_MANAGE（无能力位门控）。
const canView = computed(() => auth.can('task.view'))
const canCancel = computed(() => auth.can('task.manage'))

const tasks = ref<Task[]>([])
// 列表的 loading/error 生命周期交给 useAsync（与其余 12 个视图同一套）；
// 本页只保留 `output` 自己的加载态——任务输出是另一路请求，与服务端无关。
const { loading, error, run } = useAsync(true)
const sel = ref<Task | null>(null)
const output = ref('')
const outLoading = ref(false)

function load() {
  return run(async () => {
    const r = await api.get<Task[]>(API.tasks.list())
    tasks.value = Array.isArray(r) ? r : []
  })
}
onMounted(() => { if (canView.value) load() })

function isLive(t: Task | null) { return !!t && (t.state === 'running' || t.state === 'queued') }

/** 运行中任务每 2s 轮询单体详情刷新进度。
 *
 *  「是否在轮」由 enabled 表达（sel 是运行中任务），任务结束时 enabled 变假、
 * 链空转——不再需要手写 stopPoll 清理句柄；只有"用户主动关闭详情"才永久停。
 *  换看另一个任务时 restart() 解除永久停（上一个任务跑完时停过）。 */
const taskPoll = usePolling({
  ms: 2000,
  enabled: () => canView.value && isLive(sel.value),
  fn: async () => {
    if (!sel.value) return
    try {
      const d = await api.get<Task>(API.tasks.get(sel.value.id))
      sel.value = d
      if (!isLive(d)) { taskPoll.stop(); load() }
    } catch { /* 瞬时错误忽略，下一轮重试 */ }
  },
})

async function open(t: Task) {
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
  taskPoll.restart()
}

async function cancel(t: Task) {
  if (!canCancel.value) return
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
</script>

<template>
  <div>
    <p v-if="error" class="err">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
    <EmptyState v-if="!canView" title="无任务查看权限" reason="需要 task.view" />
    <div v-else-if="loading" class="skeleton box" />
    <template v-else>
      <!-- 动作收进卡片顶栏（同 ProcessesView 范式）：去掉只放一个「刷新」的页面级
           page-head 横条，工具条紧贴它操作的表；横滚交给内部 .t-scroll。 -->
      <div class="card flush toolbar-card">
        <div class="card-toolbar">
          <Icon name="clock" :size="16" />
          <span class="count">共 {{ tasks.length }} 个任务</span>
          <span class="spacer" />
          <RefreshBtn :disabled="loading" sm @click="load" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <colgroup>
            <col class="w-tid" /><col class="w-tname" /><col class="w-tstate" /><col class="w-tprog" /><col class="w-tstart" /><col class="w-tacts" />
          </colgroup>
          <thead><tr><th>#</th><th>任务</th><th>状态</th><th class="num">进度</th><th>开始时间</th><th /></tr></thead>
          <tbody>
            <!-- 键盘可达（审计 P10）：行可 Tab 聚焦，Enter/Space 打开详情 -->
            <tr v-for="t in tasks" :key="t.id" :class="{ active: sel?.id === t.id }" @click="open(t)"
                tabindex="0" role="button" :aria-label="`查看任务 #${t.id} 详情`"
                @keydown.enter="open(t)" @keydown.space.prevent="open(t)" style="cursor:pointer">
              <td class="mono">{{ t.id }}</td>
              <td class="mono dim ellipsis" :title="t.key || t.kind">{{ t.key || t.kind }}</td>
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
              <td class="muted nowrap">{{ fmtDateTime(t.started_at) }}</td>
              <td class="nowrap">
                <button class="btn-sm" @click.stop="open(t)"><Icon name="terminal" :size="14" /> 输出</button>
                <button v-if="isLive(t) && canCancel" class="btn-ghost btn-sm danger" title="取消任务" @click.stop="cancel(t)">取消</button>
              </td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="6"><EmptyState title="暂无任务" /></td></tr>
          </tbody>
        </table>
        </div>
      </div>

      <div v-if="sel" class="card">
        <div class="sec-head">
          <Icon name="terminal" :size="16" /><span>任务 #{{ sel.id }} · {{ sel.key || sel.kind }}</span>
          <span class="badge" :class="stateClass(sel.state)">{{ stateText(sel.state) }}</span>
          <span class="spacer" /><button class="btn-sm" @click="taskPoll.stop(); sel = null">关闭</button>
        </div>
        <p class="meta">
          类型 <span class="mono">{{ sel.kind }}</span>
          · 开始 {{ fmtDateTime(sel.started_at) }}
          · 结束 {{ fmtDateTime(sel.finished_at) }}
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
.meta { margin: 0 0 10px; font-size: var(--fs-12-5); color: var(--c-text-dim); }
.box { height: 320px; border-radius: var(--radius); }
.mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.mini .progress { flex: 1; }
.mini span { font-size: var(--fs-12); color: var(--c-text-dim); font-variant-numeric: tabular-nums; }
tr.active { background: var(--c-active) !important; }
.out { margin: 0; padding: 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: var(--fs-12-5);
       white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
/* 任务表显式列宽（与站点/进程页统一范式：table-layout:fixed + colgroup）。
   任务标识（kind/key）为唯一弹性列，可能较长，ellipsis 截断、完整值走 title。 */
.w-tid { width: 6%; }
.w-tname { width: auto; }     /* 弹性列 */
.w-tstate { width: 12%; }
.w-tprog { width: 13%; }      /* 含迷你进度条（min-width 120px） */
.w-tstart { width: 16%; }
.w-tacts { width: 160px; }    /* 输出 + 取消两个带文字按钮 */

</style>

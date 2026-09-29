<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface Task { id: number; kind: string; state: string; percent?: number; created_at?: number }

const tasks = ref<Task[]>([])
const error = ref('')
const loading = ref(true)
const sel = ref<Task | null>(null)
const output = ref('')
const outLoading = ref(false)

async function load() {
  error.value = ''; loading.value = true
  try {
    const r = await api.get<any>('/api/v1/tasks')
    tasks.value = Array.isArray(r) ? r : (r.tasks ?? [])
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
onMounted(load)

async function open(t: Task) {
  sel.value = t; outLoading.value = true; output.value = ''
  try {
    const r = await api.get<{ output?: string }>(API.tasks.output(t.id))
    output.value = r.output || '(无输出)'
  } catch (e) { output.value = errorText(e) }
  finally { outLoading.value = false }
}

async function cancel(t: Task) {
  try {
    await api.post(API.tasks.cancel(t.id))
    load()
  } catch (e) { error.value = errorText(e) }
}

function stateClass(s: string) {
  return s === 'running' ? 'badge-primary'
    : s === 'done' ? 'badge-ok'
    : s === 'failed' || s === 'cancelled' ? 'badge-danger' : 'badge-warn'
}
function fmtTime(t?: number) { return t ? new Date(t * 1000).toLocaleString() : '—' }
</script>

<template>
  <div>
    <div class="page-head">
      <div><h2 class="page-title">任务中心</h2><p class="page-sub">后台任务与执行进度</p></div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <div v-if="loading" class="skeleton box" />
    <template v-else>
      <div class="card flush">
        <table>
          <thead><tr><th>#</th><th>类型</th><th>状态</th><th class="num">进度</th><th>创建时间</th><th /></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id" :class="{ active: sel?.id === t.id }" @click="open(t)" style="cursor:pointer">
              <td class="mono">{{ t.id }}</td>
              <td>{{ t.kind }}</td>
              <td><span class="badge" :class="stateClass(t.state)">{{ t.state }}</span></td>
              <td class="num">
                <div class="mini">
                  <div class="progress"><i :style="{ width: (t.percent ?? 0) + '%' }" /></div>
                  <span>{{ t.percent ?? 0 }}%</span>
                </div>
              </td>
              <td class="muted nowrap">{{ fmtTime(t.created_at) }}</td>
              <td class="nowrap">
                <button class="btn-sm" @click.stop="open(t)"><Icon name="terminal" :size="14" /> 输出</button>
                <button v-if="t.state === 'running'" class="btn-danger btn-sm" @click.stop="cancel(t)">取消</button>
              </td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="6"><EmptyState title="暂无任务" /></td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="sel" class="card">
        <div class="sec-head">
          <Icon name="terminal" :size="16" /><span>任务 #{{ sel.id }} 输出</span>
          <span class="spacer" /><button class="btn-sm" @click="sel = null">关闭</button>
        </div>
        <pre v-if="outLoading" class="skeleton" style="height:120px" />
        <pre v-else class="out">{{ output }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.page-sub { margin: 2px 0 0; color: var(--c-text-dim); font-size: 13px; }
.box { height: 320px; border-radius: var(--radius); }
.mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.mini .progress { flex: 1; }
.mini span { font-size: 12px; color: var(--c-text-dim); font-variant-numeric: tabular-nums; }
tr.active { background: var(--c-active) !important; }
.out { margin: 0; padding: 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12.5px;
       white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
</style>

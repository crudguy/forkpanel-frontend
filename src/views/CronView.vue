<script setup lang="ts">
/**
 * 计划任务（用户 cron，不是面板内部任务）。
 *
 * 刻意说清一件事：表达式是**平台本地语义**。Linux 是 cron 五段，
 * Windows/macOS 完全不同。所以 UI 只负责收集字符串，校验交给后端，
 * 并把后端返回的校验错误原样展示 —— 前端绝不自作聪明地"帮你解析"。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Job {
  id: string; expr: string; command: string; user: string
  enabled: boolean; timeout_sec: number
  last_run_at: number | null; last_status: string | null; next: number[]
}

const auth = useAuthStore()
const jobs = ref<Job[]>([])
const error = ref('')
const form = ref({ name: '', expr: '', command: '', user: 'root' })
const del = ref<Job | null>(null)

async function load() {
  error.value = ''
  try { jobs.value = await api.get<Job[]>(API.cron.jobs()) }
  catch (e) { error.value = errorText(e); jobs.value = [] }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.SCHEDULER_MANAGE, 'cron.manage'))

async function create() {
  error.value = ''
  try {
    await api.post(API.cron.jobs(), {
      name: form.value.name, expr: form.value.expr,
      command: form.value.command, user: form.value.user,
    })
    form.value = { name: '', expr: '', command: '', user: 'root' }
    load()
  } catch (e) { error.value = errorText(e) }
}

async function doDelete() {
  if (!del.value) return
  try { await api.del(API.cron.job(del.value.id)); del.value = null; load() }
  catch (e) { error.value = errorText(e) }
}

function fmt(ts: number | null) { return ts ? new Date(ts * 1000).toLocaleString() : '—' }
</script>

<template>
  <div>
    <header class="bar"><h2>计划任务</h2><span class="sp" /><button @click="load">刷新</button></header>

    <EmptyState v-if="!auth.supported(CAP.SCHEDULER_MANAGE)"
      title="当前环境不支持计划任务"
      :reason="auth.capabilities[CAP.SCHEDULER_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section class="form">
        <strong>新建任务</strong>
        <div class="row">
          <label>名称<input v-model="form.name" placeholder="backup-db" /></label>
          <label>表达式<input v-model="form.expr" placeholder="0 3 * * *" /></label>
          <label>执行用户<input v-model="form.user" placeholder="root" /></label>
        </div>
        <label>命令<input v-model="form.command" placeholder="/usr/local/bin/backup.sh" /></label>
        <button :disabled="!canManage || !form.name || !form.expr || !form.command" @click="create">创建</button>
        <p class="tip">表达式格式由当前平台决定，校验错误将原样返回。</p>
      </section>

      <table v-if="jobs.length">
        <thead><tr><th>名称</th><th>表达式</th><th>命令</th><th>用户</th><th>上次执行</th><th>下次预览</th><th /></tr></thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id">
            <td>{{ j.id }}</td>
            <td class="mono">{{ j.expr }}</td>
            <td class="mono dim">{{ j.command }}</td>
            <td>{{ j.user }}</td>
            <td>{{ fmt(j.last_run_at) }}</td>
            <td class="dim">
              <span v-for="(t, i) in j.next.slice(0, 2)" :key="i">{{ fmt(t) }}<br /></span>
            </td>
            <td><button class="danger" :disabled="!canManage" @click="del = j">删除</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="暂无计划任务" />
    </template>

    <ConfirmDialog :open="!!del" danger title="删除计划任务"
      :detail="`将删除 ${del?.id}，该任务的后续执行会一并取消。`"
      @confirm="doDelete" @cancel="del = null" />
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
.sp { flex: 1; }
.err { color: var(--c-danger); font-size: 13px; }
.form { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 12px;
        display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.tip { margin: 0; font-size: 12px; color: var(--c-text-dim); }
.mono { font-family: var(--mono); }
.dim { color: var(--c-text-dim); }
.danger { color: var(--c-danger); }
</style>

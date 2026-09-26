<script setup lang="ts">
/**
 * 软件与服务。
 *
 * 关键交互：安装走任务队列（返回 task_id），不是同步等待。
 * UI 必须明确告诉用户"去任务面板看进度"，否则用户会一直盯着转圈，
 * 然后刷新页面、重复提交 —— 这正是幂等键要防的场景。
 *
 * sshd 的 stop 按钮刻意禁用：把自己锁在门外是自建面板最经典的事故。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'

interface Svc { name: string; state: string; enabled: boolean; description: string | null; managed: boolean }
const auth = useAuthStore()
const svcs = ref<Svc[]>([])
const init = ref('')
const busy = ref('')
const error = ref('')
const installing = ref('')
const taskId = ref<number | null>(null)

const packages = ['nginx', 'caddy', 'mysql-server', 'postgresql', 'redis', 'certbot']

async function load() {
  error.value = ''
  try {
    const r = await api.get<{ init_system: string; services: Svc[] }>('/api/v1/services')
    init.value = r.init_system
    svcs.value = r.services
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.SERVICE_MANAGE, 'service.manage'))

async function act(name: string, action: string) {
  busy.value = name + action
  error.value = ''
  try {
    await api.post(`/api/v1/services/${encodeURIComponent(name)}/action`, { action })
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = '' }
}

async function install(pkg: string) {
  installing.value = pkg; error.value = ''
  try {
    const r = await api.post<{ task_id: number; created: boolean }>(API.packages.install(), { name: pkg })
    taskId.value = r.task_id
    if (!r.created) error.value = '该安装任务已在进行中（已复用已有任务）'
  } catch (e) { error.value = errorText(e) }
  finally { installing.value = '' }
}

function stateClass(s: string) {
  return s === 'active' ? 'ok' : s === 'failed' ? 'bad' : 'dim'
}
/** sshd 不允许 stop：防失联 */
function stopDisabled(s: Svc) {
  return s.name === 'sshd' || s.name === 'ssh'
}
</script>

<template>
  <div>
    <header class="bar">
      <h2>软件与服务</h2>
      <span class="init">init: {{ init || '—' }}</span>
      <span class="sp" />
      <button :disabled="!canManage" @click="load">刷新</button>
    </header>

    <EmptyState v-if="!auth.supported(CAP.SERVICE_MANAGE)"
      title="当前环境不支持服务管理"
      :reason="auth.capabilities[CAP.SERVICE_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section class="install">
        <strong>安装软件</strong>
        <div class="pkgs">
          <button v-for="p in packages" :key="p" :disabled="!canManage || !!installing"
                  @click="install(p)">
            {{ installing === p ? '提交中…' : p }}
          </button>
        </div>
        <p v-if="taskId !== null" class="tip">
          已提交任务 #{{ taskId }}，请在右下角任务面板查看进度。
        </p>
        <p class="tip dim">仅允许白名单内的软件包：面板以 root 运行，任意安装等同任意代码执行。</p>
      </section>

      <table>
        <thead><tr><th>服务</th><th>状态</th><th>开机自启</th><th>说明</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in svcs" :key="s.name">
            <td>
              {{ s.name }}
              <span v-if="!s.managed" class="tag" title="面板未托管，操作需谨慎">未托管</span>
            </td>
            <td :class="stateClass(s.state)">{{ s.state }}</td>
            <td>{{ s.enabled ? '是' : '否' }}</td>
            <td class="dim">{{ s.description ?? '—' }}</td>
            <td class="acts">
              <button :disabled="!canManage || busy === s.name + 'start'" @click="act(s.name, 'start')">启动</button>
              <button :disabled="!canManage || stopDisabled(s)"
                      :title="stopDisabled(s) ? '禁止停止 SSH 服务以防失联' : ''"
                      @click="act(s.name, 'stop')">停止</button>
              <button :disabled="!canManage || busy === s.name + 'restart'" @click="act(s.name, 'restart')">重启</button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="!svcs.length" title="未发现服务" />
    </template>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
.init { font-size: 12px; color: var(--c-text-dim); font-family: var(--mono); }
.sp { flex: 1; }
.err { color: var(--c-danger); font-size: 13px; }
.install { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 12px;
           display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.pkgs { display: flex; gap: 8px; flex-wrap: wrap; }
.tip { margin: 0; font-size: 12px; color: var(--c-primary); }
.tip.dim, .dim { color: var(--c-text-dim); }
.ok { color: var(--c-ok); }
.bad { color: var(--c-danger); }
.tag { font-size: 11px; color: var(--c-warn); margin-left: 6px; }
.acts { white-space: nowrap; }
</style>

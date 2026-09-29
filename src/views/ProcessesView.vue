<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Proc { pid: number; name: string; cpu_pct: number; rss_kib: number; user: string }

const auth = useAuthStore()
const procs = ref<Proc[]>([])
const error = ref('')
const pending = ref('')
const loading = ref(true)
const busy = ref<number | null>(null)

async function load() {
  error.value = ''; pending.value = ''; loading.value = true
  try {
    const r = await api.get<any>(API.processes.list())
    procs.value = Array.isArray(r) ? r : (r.processes ?? [])
  } catch (e) {
    if (isUnsupported(e)) pending.value = '进程管理功能即将推出（进程快照尚未接入）'
    else error.value = errorText(e)
  }
  finally { loading.value = false }
}
onMounted(load)

const killTarget = ref<Proc | null>(null)
// 默认发 SIGTERM（进程能正常收尾）；只有卡死不响应才用 SIGKILL 强制。
const force = ref(false)
function askKill(p: Proc, f = false) { killTarget.value = p; force.value = f }
async function doKill() {
  const p = killTarget.value
  if (!p) return
  busy.value = p.pid
  try {
    await api.post(API.processes.kill(String(p.pid)), { signal: force.value ? 'kill' : 'term' })
    killTarget.value = null
    await load()
  }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = null }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">进程</h2>
        <p class="page-sub">实时进程与资源占用</p>
      </div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.PROCESS_LIST)"
      title="当前环境不支持进程管理" :reason="auth.capabilities[CAP.PROCESS_LIST]?.reason ?? undefined" />

    <template v-else>
      <p v-if="pending" class="note">{{ pending }}</p>
      <p v-if="error" class="err">{{ error }}</p>
      <div v-if="loading" class="skeleton box" />
      <div v-else class="card flush">
        <table>
          <thead>
            <tr><th>PID</th><th>进程</th><th>用户</th><th class="num">CPU</th><th class="num">内存</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="p in procs" :key="p.pid">
              <td class="mono">{{ p.pid }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.user }}</td>
              <td class="num">{{ (p.cpu_pct ?? 0).toFixed(1) }}%</td>
              <td class="num">{{ (p.rss_kib / 1024).toFixed(0) }} MB</td>
              <td class="nowrap">
                <button class="btn-danger btn-sm" :disabled="busy === p.pid || p.pid <= 1" @click="askKill(p)">
                  <Icon name="stop" :size="14" /> 结束
                </button>
                <button class="btn-ghost btn-sm" :disabled="busy === p.pid || p.pid <= 1"
                  title="发送 SIGKILL：进程不会有任何收尾机会，仅在卡死不响应时使用"
                  @click="askKill(p, true)">强制</button>
              </td>
            </tr>
            <tr v-if="!procs.length"><td colspan="6"><EmptyState title="无进程数据" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <ConfirmDialog :open="!!killTarget" danger :title="force ? '强制结束进程' : '结束进程'"
      :detail="killTarget
        ? (force
          ? `将向 ${killTarget.name}（PID ${killTarget.pid}）发送 SIGKILL。进程会被立即终止，没有保存现场、关闭连接的机会——仅在它已卡死、不响应 SIGTERM 时使用。`
          : `将向 ${killTarget.name}（PID ${killTarget.pid}）发送 SIGTERM，允许其正常退出。系统关键进程（PID ≤ 1）已被禁止。`)
        : ''"
      @confirm="doKill" @cancel="killTarget = null" />
  </div>
</template>

<style scoped>
.box { height: 320px; border-radius: var(--radius); }
</style>

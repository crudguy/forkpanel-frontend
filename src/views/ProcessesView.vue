<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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
    // 显式 limit（审计 P4）：后端默认 20 会静默截断，用户误以为看全了
    const r = await api.get<any>(API.processes.list(), { params: { limit: 200, sort: 'cpu' } })
    procs.value = Array.isArray(r) ? r : (r.processes ?? [])
  } catch (e) {
    if (isUnsupported(e)) pending.value = '进程管理功能即将推出（进程快照尚未接入）'
    else error.value = errorText(e)
  }
  finally { loading.value = false }
}
onMounted(load)

// ── 表头排序（纯前端，数据已全量拉回，点击即时排序，不回源）──
type SortKey = 'pid' | 'name' | 'user' | 'cpu' | 'mem'
const sortKey = ref<SortKey>('cpu')
const sortDir = ref<'asc' | 'desc'>('desc')
const sorted = computed(() => {
  const arr = procs.value.slice()
  const dir = sortDir.value === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    switch (sortKey.value) {
      case 'pid': return (a.pid - b.pid) * dir
      case 'cpu': return ((a.cpu_pct ?? 0) - (b.cpu_pct ?? 0)) * dir
      case 'mem': return (a.rss_kib - b.rss_kib) * dir
      case 'name': return (a.name ?? '').localeCompare(b.name ?? '') * dir
      case 'user': return (a.user ?? '').localeCompare(b.user ?? '') * dir
    }
  })
  return arr
})
function toggleSort(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = k
    // 数值列默认降序（高占用在前），文本列默认升序（A→Z）
    sortDir.value = (k === 'pid' || k === 'cpu' || k === 'mem') ? 'desc' : 'asc'
  }
}
function sortInd(k: SortKey): string {
  if (sortKey.value !== k) return ''
  return sortDir.value === 'asc' ? ' ▲' : ' ▼'
}

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
            <tr>
              <th class="sortable" :class="{ active: sortKey === 'pid' }" @click="toggleSort('pid')">PID{{ sortInd('pid') }}</th>
              <th class="sortable" :class="{ active: sortKey === 'name' }" @click="toggleSort('name')">进程{{ sortInd('name') }}</th>
              <th class="sortable" :class="{ active: sortKey === 'user' }" @click="toggleSort('user')">用户{{ sortInd('user') }}</th>
              <th class="num sortable" :class="{ active: sortKey === 'cpu' }" @click="toggleSort('cpu')">CPU{{ sortInd('cpu') }}</th>
              <th class="num sortable" :class="{ active: sortKey === 'mem' }" @click="toggleSort('mem')">内存{{ sortInd('mem') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in sorted" :key="p.pid">
              <td class="mono">{{ p.pid }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.user ?? '-' }}</td>
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
            <tr v-if="!sorted.length"><td colspan="6"><EmptyState title="无进程数据" /></td></tr>
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
table { width: 100%; border-collapse: collapse; }
th, td { padding: 9px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--c-border); }
th { color: var(--c-text-mute); font-weight: 600; }
td.num, th.num { text-align: right; }
tbody tr:hover { background: var(--c-hover); }
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--c-text); }
.sortable.active { color: var(--c-primary); }
</style>

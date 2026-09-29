<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const rows = ref<any[]>([])
const error = ref('')
const loading = ref(true)

async function load() {
  error.value = ''; loading.value = true
  try {
    const r = await api.get<any>(API.audit())
    rows.value = Array.isArray(r) ? r : (r.logs ?? r.entries ?? [])
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
onMounted(load)

function fmt(ts?: number) { return ts ? new Date(ts * 1000).toLocaleString() : '—' }
function resClass(r: string) {
  return r === 'ok' ? 'badge-ok' : r === 'fail' ? 'badge-danger' : 'badge-warn'
}
</script>

<template>
  <div>
    <div class="page-head">
      <div><h2 class="page-title">审计日志</h2><p class="page-sub">关键操作追踪</p></div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.enabled(CAP.LOGS_READ, 'audit.view')"
      title="无审计查看权限" reason="需要 audit.view" />

    <template v-else>
      <p v-if="error" class="err">{{ error }}</p>
      <div v-if="loading" class="skeleton box" />
      <div v-else class="card flush">
        <table>
          <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="(a, i) in rows" :key="i">
              <td class="muted nowrap">{{ fmt(a.ts) }}</td>
              <td>{{ a.actor }}</td>
              <td class="mono">{{ a.action }}</td>
              <td class="muted">{{ a.target }}</td>
              <td><span class="badge" :class="resClass(a.result)">{{ a.result }}</span></td>
            </tr>
            <tr v-if="!rows.length"><td colspan="5"><EmptyState title="暂无审计记录" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.page-sub { margin: 2px 0 0; color: var(--c-text-dim); font-size: 13px; }
.box { height: 300px; border-radius: var(--radius); }
</style>

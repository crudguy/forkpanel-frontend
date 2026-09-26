<script setup lang="ts">
/**
 * 数据库管理。
 *
 * 范围克制：MVP 只做列表与备份。刻意在 UI 上说明**不提供 Web SQL 终端**，
 * 否则用户会一直找"在哪执行 SQL"。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'

interface Conn {
  id: number; name: string; engine: string; host: string | null
  port: number | null; database: string | null; available: boolean; has_password: boolean
}
const auth = useAuthStore()
const conns = ref<Conn[]>([])
const error = ref('')
const busy = ref(false)
const form = ref({ name: '', engine: 'mysql', host: '127.0.0.1', database: '' })

async function load() {
  error.value = ''
  try { conns.value = await api.get<Conn[]>(API.db.connections()) }
  catch (e) { error.value = errorText(e); conns.value = [] }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.DBMS_MANAGE, 'db.manage'))

async function create() {
  busy.value = true; error.value = ''
  try {
    await api.post(API.db.connections(), {
      name: form.value.name, engine: form.value.engine,
      host: form.value.host || undefined, database: form.value.database || undefined,
    })
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

async function backup(c: Conn) {
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ task_id: number }>(API.db.backup(c.id), {
      id: c.id, out: `backup-${c.name}-${Date.now()}.sql`,
    })
    error.value = `已提交备份任务 #${r.task_id}（请在任务面板查看）`
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <header class="bar"><h2>数据库</h2><span class="sp" /><button @click="load">刷新</button></header>

    <EmptyState v-if="!auth.supported(CAP.DBMS_MANAGE)"
      title="未检测到可用的数据库客户端"
      hint="备份/恢复需要 mysqldump / pg_dump 等外部工具"
      :reason="auth.capabilities[CAP.DBMS_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="note">{{ error }}</p>

      <section class="form">
        <strong>新增连接</strong>
        <div class="row">
          <label>名称<input v-model="form.name" placeholder="myapp" /></label>
          <label>引擎
            <select v-model="form.engine">
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
              <option value="sqlite">SQLite</option>
            </select>
          </label>
          <label>主机<input v-model="form.host" /></label>
          <label>库名<input v-model="form.database" /></label>
          <button :disabled="!canManage || busy || !form.name" @click="create">添加</button>
        </div>
        <p class="tip">MVP 仅提供列表与备份，不提供 Web SQL 终端（安全与资源隔离考虑）。</p>
      </section>

      <table v-if="conns.length">
        <thead><tr><th>名称</th><th>引擎</th><th>主机</th><th>库名</th><th>可用性</th><th /></tr></thead>
        <tbody>
          <tr v-for="c in conns" :key="c.id">
            <td>{{ c.name }}</td>
            <td>{{ c.engine }}</td>
            <td class="mono">{{ c.host ?? '—' }}{{ c.port ? ':' + c.port : '' }}</td>
            <td class="dim">{{ c.database ?? '—' }}</td>
            <td :class="c.available ? 'ok' : 'bad'">{{ c.available ? '可用' : '不可用' }}</td>
            <td><button :disabled="!c.available || !canManage || busy" @click="backup(c)">备份</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="暂无连接" />
    </template>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
.sp { flex: 1; }
.note { font-size: 13px; color: var(--c-primary); }
.form { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 12px;
        display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.tip { margin: 0; font-size: 12px; color: var(--c-text-dim); }
.mono { font-family: var(--mono); }
.dim { color: var(--c-text-dim); }
.ok { color: var(--c-ok); }
.bad { color: var(--c-danger); }
</style>

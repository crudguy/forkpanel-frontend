<script setup lang="ts">
/**
 * 防火墙。
 *
 * 三个刻意的安全设计：
 * 1. 表单只允许 Allow（放行端口）。封禁端口是"把自己锁在门外"的主因，
 *    需要单独的高危流程 + 输入端口确认词，MVP 不提供图形入口。
 * 2. 提交前展示"本次将放行哪些端口"，让用户看清再点。
 * 3. 后端在 apply 前会无条件做快照并在失败时回滚，UI 明确告知这一点。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'

interface Rule {
  id: string; ports: string; protocol: string; action: string
  direction: string; source: string | null; comment: string | null; panel_managed: boolean
}

const auth = useAuthStore()
const rules = ref<Rule[]>([])
const backend = ref('')
const active = ref(false)
const error = ref('')
const busy = ref(false)
const ports = ref('80,443')
const source = ref('')
const comment = ref('')

async function load() {
  error.value = ''
  try {
    const r = await api.get<{ backend: string; active: boolean; rules: Rule[] }>('/api/v1/firewall/rules')
    backend.value = r.backend; active.value = r.active; rules.value = r.rules
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.FIREWALL_MANAGE, 'firewall.manage'))

async function apply() {
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ added: number; removed: number; unchanged: number; warnings: string[] }>(
      API.firewall.rules(),
      { rules: [{ ports: ports.value, protocol: 'tcp', action: 'allow',
                  source: source.value || undefined, comment: comment.value || undefined }] })
    if (r.warnings?.length) error.value = r.warnings.join('；')
    ports.value = ''; source.value = ''; comment.value = ''
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

async function toggleActive() {
  busy.value = true
  try { await api.put(API.firewall.setEnabled(), { enabled: !active.value }); load() }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <header class="bar">
      <h2>防火墙与安全</h2>
      <span class="meta">{{ backend || '—' }}</span>
      <span class="sp" />
      <span :class="active ? 'ok' : 'bad'">{{ active ? '已启用' : '未启用' }}</span>
      <button :disabled="busy || !canManage" @click="toggleActive">
        {{ active ? '关闭' : '启用' }}
      </button>
    </header>

    <EmptyState v-if="!auth.supported(CAP.FIREWALL_MANAGE)"
      title="未检测到受支持的防火墙后端"
      hint="面板不会自行创建防火墙规则"
      :reason="auth.capabilities[CAP.FIREWALL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section class="form">
        <strong>放行端口</strong>
        <div class="row">
          <label>端口
            <input v-model="ports" placeholder="80,443 或 8000-8100" />
          </label>
          <label>来源（可选）
            <input v-model="source" placeholder="0.0.0.0/0 或留空" />
          </label>
          <label>备注
            <input v-model="comment" placeholder="web" />
          </label>
          <button :disabled="busy || !ports" @click="apply">应用</button>
        </div>
        <p class="tip">
          仅支持放行（allow）。封禁端口可能导致 SSH 失联，需通过命令行操作。
          后端会在变更前自动快照，失败时回滚。
        </p>
      </section>

      <table v-if="rules.length">
        <thead><tr><th>端口</th><th>协议</th><th>动作</th><th>方向</th><th>来源</th><th>备注</th><th /></tr></thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id">
            <td class="mono">{{ r.ports }}</td>
            <td>{{ r.protocol }}</td>
            <td :class="r.action === 'allow' ? 'ok' : 'bad'">{{ r.action }}</td>
            <td>{{ r.direction === 'in' ? '入站' : '出站' }}</td>
            <td class="mono">{{ r.source ?? '任意' }}</td>
            <td class="dim">{{ r.comment ?? '—' }}</td>
            <td>
              <span v-if="r.panel_managed" class="tag ok">面板管理</span>
              <span v-else class="tag" title="面板不会删除用户自建规则">用户自建</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="暂无规则" />
    </template>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
.meta { font-size: 12px; color: var(--c-text-dim); font-family: var(--mono); }
.sp { flex: 1; }
.err { color: var(--c-danger); font-size: 13px; }
.form { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 12px;
        display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
label input { width: auto; min-width: 140px; }
.tip { margin: 0; font-size: 12px; color: var(--c-text-dim); }
.mono { font-family: var(--mono); }
.dim { color: var(--c-text-dim); }
.ok { color: var(--c-ok); }
.bad { color: var(--c-danger); }
.tag { font-size: 11px; }
</style>

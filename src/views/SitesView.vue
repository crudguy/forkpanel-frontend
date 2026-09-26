<script setup lang="ts">
/**
 * 站点与 SSL。
 *
 * 核心流程在后端（render → validate → deploy → reload → 落库），
 * 这里要传达的是：**校验失败时旧配置原封不动**。
 * UI 措辞必须说清这一点，否则用户会以为"点了应用就改了"。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'

interface Site { id: number; name: string; domains: string[]; root: string; kind: string; enabled: boolean; tls: boolean }
interface Cert { id: number; domain: string; issuer: string | null; not_after: number | null; days_left: number | null; auto_renew: boolean }

const auth = useAuthStore()
const sites = ref<Site[]>([])
const certs = ref<Cert[]>([])
const error = ref('')
const busy = ref(false)
const form = ref({ name: '', domains: '', root: '' })

async function load() {
  error.value = ''
  try {
    sites.value = await api.get<Site[]>('/api/v1/sites')
    certs.value = await api.get<Cert[]>(API.certs.list())
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.WEBSERVER_MANAGE, 'site.manage'))

async function apply() {
  busy.value = true; error.value = ''
  try {
    await api.post(API.sites.apply(), {
      name: form.value.name,
      domains: form.value.domains.split(/[,\s]+/).filter(Boolean),
      root: form.value.root || form.value.name,
      force_https: true,
    })
    form.value = { name: '', domains: '', root: '' }
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

function certLevel(d: number | null) {
  if (d === null) return 'dim'
  if (d > 30) return 'ok'
  if (d >= 7) return 'warn'
  return 'bad'
}
</script>

<template>
  <div>
    <header class="bar"><h2>网站与 SSL</h2><span class="sp" /><button @click="load">刷新</button></header>

    <EmptyState v-if="!auth.supported(CAP.WEBSERVER_MANAGE)"
      title="未检测到受支持的 Web 服务器"
      hint="支持 nginx / caddy"
      :reason="auth.capabilities[CAP.WEBSERVER_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section class="form">
        <strong>应用站点配置</strong>
        <div class="row">
          <label>名称<input v-model="form.name" placeholder="my-site" /></label>
          <label>域名（逗号分隔）<input v-model="form.domains" placeholder="example.com, www.example.com" /></label>
          <label>根目录<input v-model="form.root" placeholder="留空则用站点名" /></label>
          <button :disabled="!canManage || busy || !form.name || !form.domains" @click="apply">
            {{ busy ? '应用中…' : '应用' }}
          </button>
        </div>
        <p class="tip">流程：渲染 → 语法校验 → 原子替换 → reload → 入库。校验失败时旧配置不受影响。</p>
      </section>

      <h3>站点</h3>
      <table v-if="sites.length">
        <thead><tr><th>名称</th><th>域名</th><th>根目录</th><th>类型</th><th>状态</th><th>TLS</th></tr></thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ s.domains.join(', ') }}</td>
            <td class="mono dim">{{ s.root }}</td>
            <td>{{ s.kind === 'proxy' ? '反向代理' : '静态' }}</td>
            <td :class="s.enabled ? 'ok' : 'dim'">{{ s.enabled ? '启用' : '停用' }}</td>
            <td :class="s.tls ? 'ok' : 'dim'">{{ s.tls ? '已配置' : '无' }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="暂无站点" />

      <h3>证书</h3>
      <table v-if="certs.length">
        <thead><tr><th>域名</th><th>签发者</th><th>到期</th><th>剩余</th><th>自动续期</th></tr></thead>
        <tbody>
          <tr v-for="c in certs" :key="c.id">
            <td>{{ c.domain }}</td>
            <td class="dim">{{ c.issuer ?? '—' }}</td>
            <td>{{ c.not_after ? new Date(c.not_after * 1000).toLocaleDateString() : '—' }}</td>
            <td :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</td>
            <td>{{ c.auto_renew ? '是' : '否' }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="暂无证书" />
    </template>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
h3 { margin: 16px 0 8px; font-size: 14px; }
.sp { flex: 1; }
.err { color: var(--c-danger); font-size: 13px; }
.form { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 12px;
        display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.tip { margin: 0; font-size: 12px; color: var(--c-text-dim); }
.mono { font-family: var(--mono); }
.dim { color: var(--c-text-dim); }
.ok { color: var(--c-ok); }
.warn { color: var(--c-warn); }
.bad { color: var(--c-danger); }
</style>

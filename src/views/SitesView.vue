<script setup lang="ts">
/**
 * 站点与 SSL。
 *
 * 设计边界（与后端一致）：
 * - 站点的「定义」(sites 表) 与「下发到 Web 服务器的配置」是两件事。
 *   列表 / 新建 / 编辑 / 删除 只读写数据模型，无需 Web 服务器在场，始终可用。
 * - 「应用配置」/「重载」需要 webserver.manage 能力（本机装了 nginx/caddy 才行）；
 *   未检测到时按钮置灰并给出原因，绝不伪造成功。
 * - SSL 的 ACME 签发/续期同理受 ssl.acme 能力门禁；证书「删除」是纯数据操作，随时可用。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Site { id: number; name: string; domains: string[]; root: string; kind: string; enabled: boolean; tls: boolean; created_at?: number }
interface Cert { id: number; domain: string; issuer: string | null; not_after: number | null; days_left: number | null; auto_renew: boolean; renew_state?: string }

const auth = useAuthStore()
const sites = ref<Site[]>([])
const certs = ref<Cert[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

// 数据模型 CRUD 仅看 RBAC 权限点（角色维度，与平台能力无关，owner/admin 恒有）
const canManage = computed(() => auth.can('site.manage'))
const canSsl = computed(() => auth.can('ssl.manage'))
// 配置下发 / SSL 受平台能力位约束
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
const sslSupported = computed(() => auth.supported(CAP.SSL_ACME))
const selfSignedSupported = computed(() => auth.supported(CAP.SSL_SELFSIGNED))
// SSL 任一渠道可用即可点（自签离线可用；ACME 需公网+客户端）
const sslReady = computed(() => (sslSupported.value || selfSignedSupported.value) && canSsl.value)
const sslHint = computed(() => (sslReady.value ? '' : (canSsl.value ? '需 openssl 或 ACME' : '无 ssl.manage 权限')))
const canApply = computed(() => webSupported.value && canManage.value)
const canReload = computed(() => webSupported.value && canManage.value)

async function load() {
  error.value = ''; notice.value = ''
  try {
    sites.value = await api.get<Site[]>('/api/v1/sites')
    certs.value = await api.get<Cert[]>(API.certs.list())
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)

function certLevel(d: number | null) {
  if (d === null) return 'dim'
  if (d > 30) return 'ok'
  if (d >= 7) return 'warn'
  return 'bad'
}

// ── 新建 / 编辑弹窗 ──
const modalOpen = ref(false)
const editing = ref<Site | null>(null)
const form = ref({ name: '', domains: '', root: '', enabled: true })

function openCreate() {
  editing.value = null
  form.value = { name: '', domains: '', root: '', enabled: true }
  modalOpen.value = true
}
function openEdit(s: Site) {
  editing.value = s
  form.value = { name: s.name, domains: s.domains.join(', '), root: s.root, enabled: s.enabled }
}
function closeModal() { modalOpen.value = false; editing.value = null }

async function save() {
  busy.value = true; error.value = ''; notice.value = ''
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  const root = form.value.root.trim() || undefined
  try {
    if (editing.value) {
      await api.patch(API.sites.patch(editing.value.id), { domains, root, enabled: form.value.enabled })
      notice.value = `已更新站点 ${name}`
    } else {
      if (!name) throw new Error('name required')
      if (!domains.length) throw new Error('domains required')
      await api.post(API.sites.create(), { name, domains, root })
      notice.value = `已创建站点 ${name}`
    }
    closeModal(); await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// ── 删除站点 ──
const delTarget = ref<Site | null>(null)
async function doDelete() {
  if (!delTarget.value) return
  busy.value = true; error.value = ''
  try { await api.del(API.sites.remove(delTarget.value.id)); delTarget.value = null; await load() }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// 把站点配置渲染并下发到 Web 服务器（受 webserver 能力门禁）
async function applyConfig() {
  busy.value = true; error.value = ''; notice.value = ''
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  try {
    await api.post(API.sites.apply(), {
      name,
      domains,
      root: form.value.root.trim() || name,
      force_https: true,
    })
    notice.value = `已应用配置 ${name}`
    form.value = { name: '', domains: '', root: '', enabled: true }
    await load()
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入 Web 服务器，无法应用配置'
    else error.value = errorText(e)
  } finally { busy.value = false }
}

// ── 重载（受 webserver 能力门禁）──
async function reloadSite(s: Site) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.post(API.sites.reload(s.id), {})
    notice.value = `已重载 ${s.name}`
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入 Web 服务器，无法重载配置'
    else error.value = errorText(e)
  } finally { busy.value = false; await load() }
}

// ── 申请 SSL（自签优先，否则走 ACME；受对应能力门禁）──
async function applySsl(s: Site) {
  busy.value = true; error.value = ''; notice.value = ''

  // 两种方式都可用时让用户选；只有一种则直接用它（不给"选了必然失败"的余地）
  let method = 'self-signed'
  if (selfSignedSupported.value && sslSupported.value) {
    const pick = window.prompt(
      "选择签发方式：\n\n" +
      "1 = 面板自签（离线可用、立即可得，但浏览器会提示不受信任）\n" +
      "2 = ACME http-01（可信证书，需公网 80 端口可达 + certbot）\n\n" +
      "请输入 1 或 2：", '1')
    if (pick === null) { busy.value = false; return }
    method = pick.trim() === '2' ? 'http-01' : 'self-signed'
  } else {
    method = selfSignedSupported.value ? 'self-signed' : 'http-01'
  }

  // ACME 必须有账户邮箱：CA 靠它发到期/异常通知，缺了就明确报错，不代填假地址
  let email: string | undefined
  if (method === 'http-01') {
    const v = window.prompt('ACME 账户邮箱（必填，用于到期与异常通知）：')
    if (v === null) { busy.value = false; return }
    email = v.trim()
    if (!email) { error.value = 'ACME 签发需要账户邮箱'; busy.value = false; return }
  }

  try {
    const r = await api.post<{ task_id?: string }>(
      API.sites.sslApply(s.id), { domains: s.domains, method, email })
    notice.value = method === 'self-signed'
      ? `已为 ${s.name} 签发面板自签证书（记得「重载」使配置生效）`
      : `已提交 ${s.name} 的 ACME 签发任务${r?.task_id ? `（${r.task_id}）` : ''}，可在任务中心查看进度`
    if (method === 'self-signed') await load()
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入证书签发能力（需 openssl 或 ACME）'
    else error.value = errorText(e)
  } finally { busy.value = false }
}

// ── 证书续期（自签同步 / ACME 任务化）/ 删除（纯数据操作）──
const delCert = ref<Cert | null>(null)
async function renewCert(c: Cert) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.post(API.certs.renew(c.id), {})
    notice.value = `已续期 ${c.domain} 的证书`
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入证书续期能力'
    else error.value = errorText(e)
  } finally { busy.value = false; await load() }
}
async function doDeleteCert() {
  if (!delCert.value) return
  busy.value = true; error.value = ''
  try { await api.del(API.certs.remove(delCert.value.id)); delCert.value = null; await load() }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">网站与 SSL</h2>
        <p class="page-sub">虚拟主机站点与证书管理</p>
      </div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="busy" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
      <button class="btn-primary" :disabled="!canManage || busy" @click="openCreate">
        <Icon name="plus" :size="15" /> 新建站点
      </button>
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="notice">{{ notice }}</p>

    <div v-if="!webSupported" class="tip warn">
      未检测到受支持的 Web 服务器（nginx / caddy）：站点「定义」可正常管理，但「应用配置 / 重载」暂不可用。
    </div>

    <!-- 应用站点配置（受 webserver 能力门禁） -->
    <section class="card" :class="{ disabled: !webSupported }">
      <div class="sec-head"><Icon name="globe" :size="16" /> 应用站点配置</div>
      <div class="row">
        <label>名称<input v-model="form.name" :disabled="!canApply" placeholder="my-site" /></label>
        <label>域名（逗号分隔）<input v-model="form.domains" :disabled="!canApply" placeholder="example.com, www.example.com" /></label>
        <label>根目录<input v-model="form.root" :disabled="!canApply" placeholder="留空则用站点名" /></label>
        <button class="btn-primary" :disabled="!canApply || busy || !form.name || !form.domains"
          @click="applyConfig">
          {{ busy ? '应用中…' : '应用' }}
        </button>
      </div>
      <p class="tip">流程：渲染 → 语法校验 → 原子替换 → reload → 入库。校验失败时旧配置不受影响。</p>
    </section>

    <!-- 站点列表 -->
    <div class="sec-head"><Icon name="globe" :size="16" /> 站点</div>
    <div v-if="sites.length" class="card flush">
      <table>
        <thead><tr><th>名称</th><th>域名</th><th>根目录</th><th>类型</th><th>状态</th><th>TLS</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ s.domains.join(', ') }}</td>
            <td class="mono dim">{{ s.root }}</td>
            <td>{{ s.kind === 'proxy' ? '反向代理' : '静态' }}</td>
            <td><span class="badge" :class="s.enabled ? 'badge-ok' : 'badge-warn'">{{ s.enabled ? '启用' : '停用' }}</span></td>
            <td><span class="badge" :class="s.tls ? 'badge-ok' : 'badge-danger'">{{ s.tls ? '已配置' : '无' }}</span></td>
            <td class="actions">
              <button class="btn-ghost btn-sm" :disabled="!canManage" @click="openEdit(s)"><Icon name="edit" :size="13" /> 编辑</button>
              <button class="btn-ghost btn-sm" :disabled="!canReload" :title="canReload ? '' : '需 Web 服务器'" @click="reloadSite(s)"><Icon name="refresh" :size="13" /> 重载</button>
              <button class="btn-ghost btn-sm" :disabled="!sslReady" :title="sslHint" @click="applySsl(s)"><Icon name="lock" :size="13" /> SSL</button>
              <button class="btn-ghost btn-sm danger" :disabled="!canManage" @click="delTarget = s"><Icon name="trash" :size="13" /> 删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState v-else title="暂无站点" hint="点击右上角「新建站点」添加虚拟主机" />

    <!-- 证书列表 -->
    <div class="sec-head"><Icon name="lock" :size="16" /> 证书</div>
    <div v-if="certs.length" class="card flush">
      <table>
        <thead><tr><th>域名</th><th>签发者</th><th>到期</th><th>剩余</th><th>自动续期</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in certs" :key="c.id">
            <td>{{ c.domain }}</td>
            <td class="dim">{{ c.issuer ?? '—' }}</td>
            <td>{{ c.not_after ? new Date(c.not_after * 1000).toLocaleDateString() : '—' }}</td>
            <td :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</td>
            <td>{{ c.auto_renew ? '是' : '否' }}</td>
            <td><span class="badge" :class="(c.renew_state === 'failed') ? 'badge-danger' : (c.renew_state === 'ok' ? 'badge-ok' : 'badge-warn')">{{ c.renew_state ?? 'idle' }}</span></td>
            <td class="actions">
              <button class="btn-ghost btn-sm" :disabled="!sslReady" :title="sslHint" @click="renewCert(c)"><Icon name="refresh" :size="13" /> 续期</button>
              <button class="btn-ghost btn-sm danger" :disabled="!canSsl" @click="delCert = c"><Icon name="trash" :size="13" /> 删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState v-else title="暂无证书" hint="在站点行点击「SSL」申请证书（需 ACME 支持）" />

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="modalOpen" class="mask" @click.self="closeModal">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>{{ editing ? '编辑站点' : '新建站点' }}</h3>
        <label class="blk">名称
          <input v-model="form.name" :disabled="!!editing" placeholder="my-site" />
        </label>
        <label class="blk">域名（逗号分隔）
          <input v-model="form.domains" placeholder="example.com, www.example.com" />
        </label>
        <label class="blk">根目录（留空用站点名，须落在站点根目录内）
          <input v-model="form.root" placeholder="留空则用站点名" />
        </label>
        <label class="blk row-inline">
          <input type="checkbox" v-model="form.enabled" /> 启用（纳入 Web 服务器配置）
        </label>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeModal">取消</button>
          <button class="btn-primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <ConfirmDialog :open="!!delTarget" danger title="删除站点"
      :detail="delTarget ? `将删除站点「${delTarget.name}」及其关联证书，且无法恢复。` : ''"
      confirm-word="删除" @confirm="doDelete" @cancel="delTarget = null" />

    <ConfirmDialog :open="!!delCert" danger title="删除证书"
      :detail="delCert ? `将删除证书「${delCert.domain}」。` : ''"
      confirm-word="删除" @confirm="doDeleteCert" @cancel="delCert = null" />
  </div>
</template>

<style scoped>
.notice { color: var(--c-ok, #3fb950); background: rgba(63,185,80,.12); border: 1px solid rgba(63,185,80,.3);
  padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.tip.warn { color: #d29922; background: rgba(210,153,34,.12); border-color: rgba(210,153,34,.3); }
.card.disabled { opacity: .6; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.badge-danger { background: rgba(248,81,73,.18); color: #ff7b72; }
.blk { display: block; margin-bottom: 12px; font-size: 13px; color: var(--c-dim, #9da7b3); }
.blk input { width: 100%; margin-top: 4px; }
.row-inline { display: flex; align-items: center; gap: 6px; }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(460px, 92vw); background: var(--c-card, #1c2128); border: 1px solid var(--c-border, #30363d);
  border-radius: 12px; padding: 20px; }
.modal h3 { margin: 0 0 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.btn-sm.danger { color: #ff7b72; }
</style>

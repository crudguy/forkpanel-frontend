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
 * - 站点 WAF 与站点配置**同一次 apply** 下发（它本来就是 nginx 配置的一部分）。
 *   两条与后端严格对齐的语义：`waf` 缺省 = 保留库中现值（不是关闭）、
 *   `rate_per_sec: 0` = 不限速。
 *
 * ⚠️ 已知边界（如实写在界面上，不藏着）：`upstreams` / `fpm` 不落库，
 * 所以「编辑」一个反代 / PHP 站时那两个输入框是空的，**必须重填**才能再应用
 * （后端会以 400 拒绝空值，不会静默把站点改成静态）。
 */
import { ref, onMounted, computed } from 'vue'
import { useModal } from '@/composables/useModal'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, certRenewStateLabel, certSourceLabel, fmtDate, fmtDateTime, type Site } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DirectoryPickerDialog from '@/components/DirectoryPickerDialog.vue'

// Site 已移入 src/api/types.ts（WafView 此前另存一份删减副本，必然漂移）
interface Cert { id: number; domain: string; issuer: string | null; not_after: number | null; days_left: number | null; auto_renew: boolean; renew_state?: string | null; source: string }

const auth = useAuthStore()
const sites = ref<Site[]>([])
const certs = ref<Cert[]>([])
interface RenewSweep { last_at: number; last_queued: number; next_at: number }
const sweep = ref<RenewSweep>({ last_at: 0, last_queued: 0, next_at: 0 })
const error = ref('')
const notice = ref('')
const busy = ref(false)
const loading = ref(false)
/** 站点托管根目录（后端只读下发）。目录选择器的初始定位——不可硬编码，config 可覆盖。 */
const siteRoot = ref('')

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

async function load(silent = false) {
  if (!silent) { loading.value = true; error.value = ''; notice.value = '' }
  try {
    sites.value = await api.get<Site[]>(API.sites.list())
    certs.value = await api.get<Cert[]>(API.certs.list())
    try { sweep.value = await api.get<RenewSweep>(API.certs.renewSweep()) }
    catch { /* 扫描状态缺失不阻断证书列表 */ }
    try { siteRoot.value = (await api.get<{ site_root: string }>(API.sites.root())).site_root }
    catch { /* 旧后端无此端点：选择器降级为默认起始目录，不阻断站点功能 */ }
    if (silent) error.value = '' // 自愈：轮询成功清旧错（站点页不轮询，保留一致语义）
  } catch (e) {
    if (!silent) error.value = errorText(e)
  } finally {
    if (!silent) loading.value = false
  }
}
onMounted(load)

function certLevel(d: number | null) {
  if (d === null) return 'dim'
  if (d > 30) return 'ok'
  if (d >= 7) return 'warn'
  return 'bad'
}

// 自动续期扫描状态摘要：供证书区表头展示"上次/下次扫描"
function sweepSummary(): string {
  const s = sweep.value
  if (!s.last_at) return '尚未运行 · 每日约 04:05 自动扫描'
  const fmt = (t: number) => fmtDateTime(t)
  const queued = s.last_queued > 0 ? ` · 上次入队 ${s.last_queued} 张` : ''
  return `上次 ${fmt(s.last_at)} · 下次约 ${fmt(s.next_at)}${queued}`
}

// ── 新建 / 编辑弹窗 ──
const modalOpen = ref(false)
/** 根目录选择器（复用 /files/list 在服务器浏览目录树）。 */
const pickerOpen = ref(false)
function onPickRoot(p: string) {
  form.value.root = p
  pickerOpen.value = false
}
// 站点编辑弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const modalBox = ref<HTMLElement | null>(null)
useModal(() => modalOpen.value, modalBox, closeModal)
const editing = ref<Site | null>(null)
/** 空表单。`wafRate: 0` / `wafBurst: 0` 与后端的"不限速 / 自动"语义一一对应。 */
function emptyForm() {
  return {
    name: '', domains: '', root: '', enabled: true,
    kind: 'static', upstreams: '', fpm: '',
    wafOn: false, wafProfile: 'basic', wafRate: 0, wafBurst: 0,
  }
}
const form = ref(emptyForm())

function openCreate() {
  editing.value = null
  form.value = emptyForm()
  modalOpen.value = true
}
function openEdit(s: Site) {
  editing.value = s
  form.value = {
    ...emptyForm(),
    name: s.name, domains: s.domains.join(', '), root: s.root, enabled: s.enabled,
    // 类型**从站点真实值预填**。此前写死 'static'，于是「编辑反代站 → 应用」
    // 会把它静默改写成静态站（后端当时也没存真实类型，两侧一起错）。
    kind: s.kind === 'proxy' || s.kind === 'php' ? s.kind : 'static',
    // 后端已把 upstreams/fpm 落库（migration 009），编辑时回填真实值：
    // 否则编辑反代/PHP 站再应用，后端配置会被静默清空。
    upstreams: (s.upstreams ?? []).join(', '),
    fpm: s.fpm ?? '',
    wafOn: s.waf_enabled,
    wafProfile: s.waf_profile ?? 'basic',
    wafRate: s.waf_rate_per_sec ?? 0,
    wafBurst: s.waf_burst ?? 0,
  }
  // 此前漏了这一行：只回填了表单却不开弹窗，点「编辑」毫无反应
  modalOpen.value = true
}

/** 站点类型的中文名（列表与提示共用一份）。 */
function kindLabel(k: string) {
  if (k === 'proxy') return '反向代理'
  if (k === 'php') return 'PHP'
  return '静态'
}

/** 组装 apply 的 waf 段。 */
function wafPayload() {
  if (!form.value.wafOn) return { enabled: false }
  const p: Record<string, unknown> = {
    enabled: true,
    profile: form.value.wafProfile,
    rate_per_sec: form.value.wafRate,   // 0 = 不限速（后端语义）
  }
  // burst 只在限速且有值时下发：不限速却带 burst 会被后端 400（"配了但没生效"
  // 属于静默失败，后端刻意拒绝）；缺省时让后端按 rate×2 计算。
  if (form.value.wafRate > 0 && form.value.wafBurst > 0) p.burst = form.value.wafBurst
  return p
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
      await api.post(API.sites.create(), { name, domains, root, enabled: form.value.enabled })
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
    // 站点类型。proxy/php 的目标值会**直接进 nginx 配置文本**，注入校验在后端；
    // 这里只做"别把空值递上去"的提示，不做安全判断（前端判断等于没有判断）。
    const kind = form.value.kind
    if (kind === 'proxy' && !form.value.upstreams.trim()) throw new Error('反代需要至少一个后端')
    if (kind === 'php' && !form.value.fpm.trim()) throw new Error('PHP 站点需要 php-fpm 目标')
    const r = await api.post<{ deployed?: boolean }>(API.sites.apply(), {
      name,
      domains,
      root: form.value.root.trim() || name,
      force_https: true,
      kind,
      upstreams: kind === 'proxy'
        ? form.value.upstreams.split(/[,\s]+/).filter(Boolean)
        : undefined,
      fpm: kind === 'php' ? form.value.fpm.trim() : undefined,
      waf: wafPayload(),
    })
    // 后端对停用态站点只存配置不下发：按返回的 deployed 标志给不同提示，不伪造成功。
    if (r && r.deployed === false) {
      notice.value = `站点 ${name} 处于停用状态：配置已保存但未下发，启用后才会生效`
    } else {
      notice.value = `已应用配置 ${name}${form.value.wafOn ? `（WAF ${form.value.wafProfile}）` : ''}`
    }
    form.value = emptyForm()
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
/** SSL 签发弹窗（审计 U6：替代 window.prompt 选方式/填邮箱）。 */
const sslModal = ref<{ site: Site; method: 'self-signed' | 'http-01'; email: string } | null>(null)

function applySsl(s: Site) {
  error.value = ''; notice.value = ''
  // 只有**一种**渠道可用时直接执行，不给"选了必然失败"的余地
  if (!(selfSignedSupported.value && sslSupported.value)) {
    execSsl(s, selfSignedSupported.value ? 'self-signed' : 'http-01', '')
    return
  }
  sslModal.value = { site: s, method: 'self-signed', email: '' }
}

async function execSsl(s: Site, method: 'self-signed' | 'http-01', email: string) {
  busy.value = true; error.value = ''; notice.value = ''
  // ACME 必须有账户邮箱：CA 靠它发到期/异常通知，缺了就明确报错，不代填假地址
  if (method === 'http-01' && !email.trim()) {
    error.value = 'ACME 签发需要账户邮箱'
    busy.value = false
    return
  }
  try {
    const r = await api.post<{ task_id?: string }>(
      API.sites.sslApply(s.id), { domains: s.domains, method, email: method === 'http-01' ? email.trim() : undefined })
    notice.value = method === 'self-signed'
      ? `已为 ${s.name} 签发面板自签证书（记得「重载」使配置生效）`
      : `已提交 ${s.name} 的 ACME 签发任务${r?.task_id ? `（${r.task_id}）` : ''}，可在任务中心查看进度`
    sslModal.value = null
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
async function setAutoRenew(c: Cert, val: boolean) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.patch(API.certs.autoRenew(c.id), { enabled: val })
    c.auto_renew = val
    notice.value = `${c.domain} 自动续期已${val ? '开启' : '关闭'}`
  } catch (e) {
    if (isUnsupported(e)) error.value = '当前环境未接入 ACME，无法自动续期'
    else error.value = errorText(e)
  } finally { busy.value = false }
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
      <span class="spacer" />
      <!-- 刷新是通用工具动作，不是本页目的：与 FilesView / AuditView 一致用 ghost，
           把唯一的橙色实心留给「新建站点」。此前两个 btn-primary 并排，两块发光渐变
           把主次拉平了，页面没有视觉焦点。 -->
      <button class="btn-ghost" :disabled="busy" @click="load()"><Icon name="refresh" :size="15" /> 刷新</button>
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
        <label>类型
          <select v-model="form.kind" :disabled="!canApply">
            <option value="static">静态</option>
            <option value="proxy">反向代理 / 负载均衡</option>
            <option value="php">PHP (php-fpm)</option>
          </select>
        </label>
        <label v-if="form.kind === 'proxy'">后端（逗号分隔）
          <input v-model="form.upstreams" :disabled="!canApply" placeholder="http://127.0.0.1:3000, http://127.0.0.1:3001" />
        </label>
        <label v-if="form.kind === 'php'">php-fpm
          <input v-model="form.fpm" :disabled="!canApply" placeholder="unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000" />
        </label>
        <button class="btn-primary" :disabled="!canApply || busy || !form.name || !form.domains"
          @click="applyConfig">
          {{ busy ? '应用中…' : '应用' }}
        </button>
      </div>

      <div class="waf">
        <label class="inline" title="在被管理站点前生成拦截规则；规则集由系统内置，此处只能选档位与数值">
          <input type="checkbox" v-model="form.wafOn" :disabled="!canApply" /> 启用 WAF
        </label>
        <template v-if="form.wafOn">
          <label>档位
            <select v-model="form.wafProfile" :disabled="!canApply">
              <option value="basic">基础（SQLi / XSS / 穿越 / 敏感文件 / 恶意 UA）</option>
              <option value="strict">严格（+ 空 UA、非白名单方法，误杀率更高）</option>
            </select>
          </label>
          <label>CC 限速（次/秒，0 = 不限）
            <input v-model.number="form.wafRate" type="number" min="0" max="1000" :disabled="!canApply" />
          </label>
          <label :title="form.wafRate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速，否则后端会拒绝'">
            突发桶（0 = 自动）
            <input v-model.number="form.wafBurst" type="number" min="0" max="10000"
              :disabled="!canApply || !form.wafRate" />
          </label>
        </template>
      </div>

      <p class="tip">
        流程：渲染 → 语法校验 → 原子替换 → reload → 入库。校验失败时旧配置不受影响。
        多个后端由 nginx <code>upstream</code>（least_conn）轮询；后端只接受
        <code>http(s)://host:port</code>，不接受路径或查询串。
      </p>
      <p class="tip">
        WAF 与站点配置<b>同一次下发</b>（它本来就是 nginx 配置的一部分）。
        超限返回 <code>429</code>；<code>/.well-known</code> 始终放行——ACME 挑战文件在那里，
        一刀切会把证书续期打死。
        <b>「编辑」不会回填后端 / php-fpm 地址</b>（后端未持久化它们），
        它会以 400 要求重填，而<b>不会</b>把站点悄悄改成静态。
      </p>
    </section>

    <!-- 站点列表 -->
    <div class="sec-head block"><Icon name="globe" :size="16" /> 站点</div>
    <div v-if="loading && !sites.length" class="skeleton box" />
    <div v-else-if="sites.length" class="card flush">
      <table class="fixed">
        <colgroup>
          <col class="w-name" /><col class="w-dom" /><col class="w-root" /><col class="w-kind" /><col class="w-waf" /><col class="w-st" /><col class="w-tls" /><col class="w-acts" />
        </colgroup>
        <thead><tr><th>名称</th><th>域名</th><th>根目录</th><th>类型</th><th>WAF</th><th>状态</th><th>TLS</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td class="ellipsis" :title="s.name">{{ s.name }}</td>
            <td class="ellipsis" :title="s.domains.join(', ')">{{ s.domains.join(', ') }}</td>
            <td class="mono dim ellipsis" :title="s.root">{{ s.root }}</td>
            <td>{{ kindLabel(s.kind) }}</td>
            <td>
              <template v-if="s.waf_enabled">
                <span class="badge badge-ok">{{ s.waf_profile ?? 'basic' }}</span>
                <span v-if="s.waf_rate_per_sec" class="dim tiny">· {{ s.waf_rate_per_sec }}/s</span>
              </template>
              <span v-else class="dim">—</span>
            </td>
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
    <div class="sec-head block"><Icon name="lock" :size="16" /> 证书</div>
    <p class="cert-sweep dim tiny">自动续期扫描：{{ sweepSummary() }}</p>
    <div v-if="loading && !certs.length" class="skeleton box" />
    <div v-else-if="certs.length" class="card flush">
      <table class="fixed">
        <colgroup>
          <col class="w-dom" /><col class="w-iss" /><col class="w-src" /><col class="w-exp" /><col class="w-left" /><col class="w-auto" /><col class="w-st" /><col class="w-acts" />
        </colgroup>
        <thead><tr><th>域名</th><th>签发者</th><th>来源</th><th>到期</th><th>剩余</th><th>自动续期</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in certs" :key="c.id">
            <td class="ellipsis" :title="c.domain">{{ c.domain }}</td>
            <td class="dim ellipsis" :title="c.issuer ?? ''">{{ c.issuer ?? '—' }}</td>
            <!-- 列序必须与表头「域名|签发者|来源|到期|剩余」一致。此前来源与到期/剩余
                 错位：「来源」列显示到期日、「剩余」列显示来源，证书到期日被看错。 -->
            <td class="dim">{{ certSourceLabel(c.source) }}</td>
            <td>{{ fmtDate(c.not_after) }}</td>
            <td :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</td>
            <td>
              <span v-if="c.source === 'acme'" class="switch" :title="sslSupported ? '到期前 30 天内自动续期' : '需 ACME 支持'">
                <input type="checkbox" :checked="c.auto_renew" :disabled="!sslSupported || busy"
                       @change="setAutoRenew(c, ($event.target as HTMLInputElement).checked)" /><i />
              </span>
              <span v-else class="dim tiny">仅 ACME</span>
            </td>
            <td><span class="badge" :class="(c.renew_state === 'failed') ? 'badge-danger' : (c.renew_state === 'ok' ? 'badge-ok' : 'badge-warn')">{{ certRenewStateLabel(c.renew_state) }}</span></td>
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
      <div ref="modalBox" class="modal" role="dialog" aria-modal="true">
        <h3>{{ editing ? '编辑站点' : '新建站点' }}</h3>
        <label class="blk">名称
          <input v-model="form.name" :disabled="!!editing" placeholder="my-site" />
        </label>
        <label class="blk">域名（逗号分隔）
          <input v-model="form.domains" placeholder="example.com, www.example.com" />
        </label>
        <label class="blk">根目录（留空用站点名，须落在站点根目录内）
          <div class="dir-row">
            <input v-model="form.root" placeholder="留空则用站点名" />
            <button type="button" class="btn-ghost btn-sm" @click="pickerOpen = true">
              <Icon name="folder" :size="13" /> 浏览…
            </button>
          </div>
        </label>
        <label class="blk row-inline">
          <input type="checkbox" v-model="form.enabled" />
          <span>启用（纳入 Web 服务器配置）</span>
        </label>
        <div class="hint-note" :class="{ 'is-warn': !!editing }">
          <Icon name="info" :size="15" class="ic" />
          <span>{{ editing
            ? '保存后立即生效：取消勾选会从 Web 服务器移除该站点配置并重载，站点随即停止对外服务；重新勾选则按当前设置重新下发。'
            : '新建时仅记录初始状态——站点要在列表里点「应用」后才会真正对外服务。' }}</span>
        </div>
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

    <DirectoryPickerDialog :open="pickerOpen" :initial-path="form.root || siteRoot"
      @select="onPickRoot" @cancel="pickerOpen = false" />

    <!-- SSL 签发弹窗（审计 U6）：替代 window.prompt 选方式/填邮箱 -->
    <div v-if="sslModal" class="mask" @click.self="sslModal = null">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>为「{{ sslModal.site.name }}」申请证书</h3>
        <label class="ssl-opt">
          <input type="radio" value="self-signed" v-model="sslModal.method" />
          <span><b>面板自签</b><br /><span class="dim">离线可用、立即可得，但浏览器会提示不受信任</span></span>
        </label>
        <label class="ssl-opt">
          <input type="radio" value="http-01" v-model="sslModal.method" />
          <span><b>ACME http-01</b><br /><span class="dim">可信证书，需公网 80 端口可达 + certbot</span></span>
        </label>
        <label v-if="sslModal.method === 'http-01'" class="blk">
          ACME 账户邮箱（必填，用于到期与异常通知）
          <input v-model="sslModal.email" type="email" placeholder="ops@example.com" autocomplete="email" />
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="sslModal = null">取消</button>
          <button class="btn-primary" :disabled="busy || (sslModal.method === 'http-01' && !sslModal.email.trim())"
            @click="execSsl(sslModal.site, sslModal.method, sslModal.email)">
            {{ busy ? '提交中…' : '申请' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* WAF 区块：与 .row 同一套排布，用虚线分隔以表明它是站点配置的一部分而非并列项 */
.waf { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; margin-top: 10px;
  border-top: 1px dashed var(--c-border); padding-top: 10px; }
.waf label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--c-text-dim); }
.waf label.inline { flex-direction: row; align-items: center; cursor: help; }
.waf label.inline input { width: auto; }
.tiny { font-size: 11.5px; }
.cert-sweep { margin: 0 0 10px; padding-left: 2px; }
/* 「横幅」语言（与 WafView / LoginView 的 .notice / .warn 同一套）：
   内边距 + 圆角 + 描边，颜色一律走主题变量。
   此前 .notice 硬编码绿色、.tip.warn 硬编码暗琥珀，亮色主题下不随 --c-ok / --c-warn
   切换；.tip.warn 更只覆写了 color/background/border-color 三项，而 .tip 自身
   padding/border-width/border-radius 全为 0，于是「警示条」实测渲染成
   padding:0 / border:0 / radius:0、高仅 19px 的一条裸色带，且 margin:0 导致它
   与下方卡片严丝合缝贴合（实测 0px），文字还顶到内容区左边缘。 */
.notice { color: var(--c-ok); background: var(--c-ok-soft);
  border: 1px solid color-mix(in srgb, var(--c-ok) 35%, transparent);
  padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.tip.warn { color: var(--c-warn); background: var(--c-warn-bg);
  border: 1px solid color-mix(in srgb, var(--c-warn) 35%, transparent);
  padding: 9px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6;
  margin: 0 0 14px; }
.card.disabled { opacity: .6; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.badge-danger { background: rgba(248,81,73,.18); color: #ff7b72; }
.blk { display: block; margin-bottom: 12px; font-size: 13px; color: var(--c-text-dim); }
.blk input { width: 100%; margin-top: 4px; }
.dir-row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.dir-row input { flex: 1; margin-top: 0; }
.dir-row .btn-sm { flex: none; white-space: nowrap; }
.row-inline { display: flex; align-items: flex-start; gap: 7px; }
/* 文字可能折行，勾选框对齐首行而非整体垂直居中；并复位 width——
   全局 `input{width:100%}` 会把原生勾选框拉成宽盒子，勾选框与文字之间出现大段空隙、
   文字被挤到右侧折行（与 .waf label.inline input / .chk input 同一处坑，故同样复位）。 */
.row-inline input[type="checkbox"] { width: auto; margin: 4px 0 0; }
/* 「启用」开关的后果说明：停用是**真停用**（摘配置 + reload），必须让用户看见代价。
   原 .hint-line（12px + --c-text-mute）太小太淡、又用负 margin 紧贴勾选框，读起来像
   "被禁用的残留文字"；改为带 info 图标的信息条：13px + --c-text-dim，柔和底 +
   左侧主色描边，与勾选框拉开间距。编辑态（真停用后果）转琥珀色强调。 */
.hint-note { display: flex; gap: 8px; align-items: flex-start;
  margin: 0 0 14px; padding: 9px 11px; border-radius: 8px;
  font-size: 13px; line-height: 1.6; color: var(--c-text-dim);
  background: var(--c-hover); border: 1px solid var(--c-border);
  border-left: 3px solid var(--c-primary); }
.hint-note .ic { flex: none; color: var(--c-primary); margin-top: 2px; }
.hint-note.is-warn { border-left-color: var(--c-warn); }
.hint-note.is-warn .ic { color: var(--c-warn); }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(460px, 92vw); background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-radius: 12px; padding: 20px; }
.modal h3 { margin: 0 0 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.ssl-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border: 1px solid var(--c-border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 13px; line-height: 1.5; }
.ssl-opt:has(input:checked) { border-color: var(--c-primary); background: var(--c-primary-soft); }
.ssl-opt input { width: auto; margin-top: 2px; }
.btn-sm.danger { color: #ff7b72; }
/* 自动续期开关（与 CronView 的 .switch 视觉保持一致） */
.switch { position: relative; width: 34px; height: 19px; display: inline-block; vertical-align: middle; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch i { position: absolute; inset: 0; border-radius: 999px; background: var(--c-hover); border: 1px solid var(--c-border); transition: background .15s; }
.switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--c-text-dim); transition: all .15s; }
.switch input:checked + i { background: var(--c-primary-soft); border-color: var(--c-primary); }
.switch input:checked + i::after { left: 17px; background: var(--c-primary); }
.switch input:disabled + i { opacity: .45; cursor: not-allowed; }

/* 显式列宽（与服务/进程页统一范式）：table-layout:fixed + colgroup 宽度，
   长域名/根目录/签发者 ellipsis 截断、完整值走 title 悬停。 */
table.fixed { table-layout: fixed; width: 100%; }
table.fixed th, table.fixed td { overflow: hidden; }
.ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 站点表 */
col.w-name { width: 14%; }
col.w-dom { width: 24%; }
col.w-root { width: 20%; }
col.w-kind { width: 10%; }
col.w-waf { width: 12%; }
col.w-st { width: 8%; }
col.w-tls { width: 8%; }
col.w-acts { width: 12%; }
/* 证书表 */
col.w-iss { width: 14%; }
col.w-src { width: 10%; }
col.w-exp { width: 12%; }
col.w-left { width: 9%; }
col.w-auto { width: 12%; }
/* 骨架（观感与列表页统一；keyframes 独立命名避免全局冲突） */
.skeleton { background: linear-gradient(90deg, var(--c-hover) 25%, var(--c-glass) 37%, var(--c-hover) 63%); background-size: 400% 100%; animation: site-sk 1.4s ease infinite; border-radius: var(--radius); }
.box { height: 300px; }
@keyframes site-sk { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
</style>

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
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Site {
  id: number; name: string; domains: string[]; root: string
  /** API 口径：static | proxy | php */
  kind: string
  enabled: boolean; tls: boolean; created_at?: number
  waf_enabled: boolean
  waf_profile: string | null
  /** CC 限速（次/秒）；null = 不限速 */
  waf_rate_per_sec: number | null
  waf_burst: number | null
  /** 反代后端列表（kind=proxy 时存在）；static/php 为 null */
  upstreams: string[] | null
  /** php-fpm 目标（kind=php 时存在）；其余为 null */
  fpm: string | null
}
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
    sites.value = await api.get<Site[]>(API.sites.list())
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
    // 站点类型。proxy/php 的目标值会**直接进 nginx 配置文本**，注入校验在后端；
    // 这里只做"别把空值递上去"的提示，不做安全判断（前端判断等于没有判断）。
    const kind = form.value.kind
    if (kind === 'proxy' && !form.value.upstreams.trim()) throw new Error('反代需要至少一个后端')
    if (kind === 'php' && !form.value.fpm.trim()) throw new Error('PHP 站点需要 php-fpm 目标')
    await api.post(API.sites.apply(), {
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
    notice.value = `已应用配置 ${name}${form.value.wafOn ? `（WAF ${form.value.wafProfile}）` : ''}`
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
        <label class="inline" title="在被管理站点前生成拦截规则；规则集是后端编译期常量，此处只能选档位与数值">
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
        WAF 与站点配置**同一次下发**（它本来就是 nginx 配置的一部分）。
        超限返回 <code>429</code>；<code>/.well-known</code> 始终放行——ACME 挑战文件在那里，
        一刀切会把证书续期打死。
        <b>「编辑」不会回填后端 / php-fpm 地址</b>（后端未持久化它们），
        它会以 400 要求重填，而<b>不会</b>把站点悄悄改成静态。
      </p>
    </section>

    <!-- 站点列表 -->
    <div class="sec-head"><Icon name="globe" :size="16" /> 站点</div>
    <div v-if="sites.length" class="card flush">
      <table>
        <thead><tr><th>名称</th><th>域名</th><th>根目录</th><th>类型</th><th>WAF</th><th>状态</th><th>TLS</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ s.domains.join(', ') }}</td>
            <td class="mono dim">{{ s.root }}</td>
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
      <div ref="modalBox" class="modal" role="dialog" aria-modal="true">
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
.notice { color: var(--c-ok, #3fb950); background: rgba(63,185,80,.12); border: 1px solid rgba(63,185,80,.3);
  padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.tip.warn { color: #d29922; background: rgba(210,153,34,.12); border-color: rgba(210,153,34,.3); }
.card.disabled { opacity: .6; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.badge-danger { background: rgba(248,81,73,.18); color: #ff7b72; }
.blk { display: block; margin-bottom: 12px; font-size: 13px; color: var(--c-text-dim); }
.blk input { width: 100%; margin-top: 4px; }
.row-inline { display: flex; align-items: center; gap: 6px; }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(460px, 92vw); background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-radius: 12px; padding: 20px; }
.modal h3 { margin: 0 0 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.ssl-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border: 1px solid var(--c-border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 13px; line-height: 1.5; }
.ssl-opt:has(input:checked) { border-color: var(--c-primary); background: var(--c-primary-soft); }
.ssl-opt input { width: auto; margin-top: 2px; }
.btn-sm.danger { color: #ff7b72; }
</style>

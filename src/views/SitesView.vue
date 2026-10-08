<script setup lang="ts">
/**
 * 站点与 SSL。
 *
 * 设计边界（与后端一致）：
 * - 站点的「定义」(sites 表) 与「下发到 Web 服务器的配置」是两件事。
 * - **建站需要 Web 服务器底座**：未检测到 nginx 时「新建站点」置灰，后端 create
 *   同样返回 501（webserver.manage）——否则只会造出「建好了但永远打不开」的
 *   空中楼阁。列表 / 编辑 / 删除 仍只读写数据模型，不依赖底座。
 * - 「应用配置」/「重载」需要 webserver.manage 能力；未检测到时按钮置灰并给出
 *   原因，绝不伪造成功。
 * - 列表「状态」的判据是 `deployed`（配置是否真下发）而非 `enabled`（期望状态）：
 *   新建后 enabled 即为 true，但此刻 Web 服务器里并无此站点，显示「运行中」就是撒谎。
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
// SSL 需基础设施齐备：① 底座（nginx）能加载证书 ② 签发渠道（自签/ACME）③ 权限
const sslReady = computed(() => webSupported.value && (sslSupported.value || selfSignedSupported.value) && canSsl.value)
const sslHint = computed(() => {
  if (!canSsl.value) return '无 ssl.manage 权限'
  if (!webSupported.value) return '需先安装并启动 Web 服务器（nginx）——证书没有进程可加载'
  return '需 openssl 或 ACME'
})
const canReload = computed(() => webSupported.value && canManage.value)
// 建站与配置下发同源：没有底座就不许建（后端 create 亦 501，前端只是提前挡住并说明原因）
const canCreate = computed(() => webSupported.value && canManage.value)
const createHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  return webSupported.value ? '' : '需先安装并启动 Web 服务器（nginx）——否则站点建了也无法访问'
})

/**
 * 站点状态三态。判据是 `deployed`（配置是否真下发）而不是 `enabled`（期望状态）：
 * 后者在新建后即为 true，但此刻 Web 服务器里根本没有这个站点。
 */
function siteState(s: Site): { label: string; cls: string; title: string } {
  if (!s.enabled) {
    return { label: '已停用', cls: '', title: '已从 Web 服务器摘除配置（或从未启用）' }
  }
  if (!s.deployed) {
    return { label: '未下发', cls: 'badge-warn', title: '已登记，但配置尚未下发到 Web 服务器；点「应用」后才会对外服务' }
  }
  return { label: '运行中', cls: 'badge-ok', title: '配置已下发到 Web 服务器并已 reload' }
}

/**
 * TLS 徽章三态。判据是"证书存在 **且** 配置已下发"——只看 `ssl_certs` 有无记录，
 * 会把"签了但没生效"显示成"已配置"，与同行的站点状态自相矛盾。
 */
function tlsState(s: Site): { label: string; cls: string; title: string } {
  if (!s.tls) {
    return { label: '无', cls: '', title: '尚未为该站点签发证书（点本行「SSL」申请）' }
  }
  if (!s.deployed) {
    return { label: '已签发·未生效', cls: 'badge-warn', title: '证书已生成并落盘，但站点配置尚未下发到 Web 服务器，HTTPS 还没生效' }
  }
  return { label: '已启用', cls: 'badge-ok', title: '证书已随站点配置在 Web 服务器生效' }
}

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

/**
 * 保存站点 = ① 写数据模型 ② 下发配置（环境支持时）。
 *
 * 这两步与后端的职责划分一一对应：`create`/`patch` 管 `sites` 表（`patch` 还负责
 * `enabled` 的**真同步**：停用=摘配置+reload），`apply` 管渲染下发。
 * 此前它们被拆成页面上两个卡片（顶部「应用站点配置」+ 本弹窗），字段重复、
 * 同一份信息要填两遍，且「新建」按钮建出来的站点还得再去顶部点一次应用才能访问
 * ——现在合并为：**保存即下发**。
 */
async function save() {
  busy.value = true; error.value = ''; notice.value = ''
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  const root = form.value.root.trim() || undefined
  try {
    // 目标值的必填校验。proxy/php 的目标会**直接进 nginx 配置文本**，注入校验在后端；
    // 这里只做"别把空值递上去"的提示，不做安全判断（前端判断等于没有判断）。
    if (webSupported.value) {
      if (form.value.kind === 'proxy' && !form.value.upstreams.trim()) throw new Error('反代需要至少一个后端')
      if (form.value.kind === 'php' && !form.value.fpm.trim()) throw new Error('PHP 站点需要 php-fpm 目标')
    }
    // ① 数据模型。新建走 create（它能确立初始 enabled），编辑走 patch（它负责启停真同步）。
    if (editing.value) {
      await api.patch(API.sites.patch(editing.value.id), { domains, root, enabled: form.value.enabled })
    } else {
      if (!name) throw new Error('name required')
      if (!domains.length) throw new Error('domains required')
      await api.post(API.sites.create(), { name, domains, root, enabled: form.value.enabled })
    }
    // ② 下发。**停用态也照样调 apply**——它只落库不下发（与后端「停用守恒」一致），
    //    但类型 / 反代后端 / php-fpm / WAF 只有 apply 才会写进库。
    if (webSupported.value) {
      const r = await deploy(name, domains)
      notice.value = r && r.deployed === false
        ? `已保存站点 ${name}：当前为停用状态，配置已登记但未下发`
        : `已保存站点 ${name} 并下发配置`
    } else {
      notice.value = `已保存站点 ${name}（未接入 Web 服务器：仅登记，未下发）`
    }
    closeModal(); await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

/** 站点类型 → apply 载荷里的目标值（proxy / php 的目标会直接进 nginx 配置文本）。 */
function kindTargets() {
  const kind = form.value.kind
  if (kind === 'proxy') return { upstreams: form.value.upstreams.split(/[,\s]+/).filter(Boolean) }
  if (kind === 'php') return { fpm: form.value.fpm.trim() }
  return {}
}

/**
 * 渲染并下发站点配置（「保存站点」的第二步；受 webserver 能力门禁）。
 *
 * 与列表行「重载」的区别：重载只是让 nginx 重读**磁盘上已有的**配置，不会重新渲染；
 * 改了域名 / 类型 / WAF 后必须走这里才会生效。
 */
async function deploy(name: string, domains: string[]) {
  return api.post<{ deployed?: boolean }>(API.sites.apply(), {
    name,
    domains,
    root: form.value.root.trim() || name,
    force_https: true,
    kind: form.value.kind,
    ...kindTargets(),
    waf: wafPayload(),
  })
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

/** 根证书安装指引弹窗。自签证书能被浏览器信任的**唯一**前提是把根 CA 装进信任库。 */
const caHelp = ref(false)
/**
 * 下载面板根证书（ca.crt）。
 *
 * 用 location 直下而非 fetch——与 FilesView 下载同范式：GET + cookie 认证即可，
 * 不需要（也不能）带 CSRF 头，响应流交给浏览器原生处理（自动落到下载目录）。
 */
function downloadCa() {
  window.location.href = API.certs.ca()
}

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
      <button class="btn-primary" :disabled="!canCreate || busy" :title="createHint" @click="openCreate">
        <Icon name="plus" :size="15" /> 新建站点
      </button>
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="notice">{{ notice }}</p>

    <div v-if="!webSupported" class="tip warn">
      未检测到 Web 服务器（nginx）：<b>无法新建站点</b>。没有底座时建站只会得到一个打不开的站点，
      请先在主机上安装并启动 nginx，再回到此页刷新。
    </div>

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
            <td><span class="badge" :class="siteState(s).cls" :title="siteState(s).title">{{ siteState(s).label }}</span></td>
            <td><span class="badge" :class="tlsState(s).cls" :title="tlsState(s).title">{{ tlsState(s).label }}</span></td>
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
    <div class="sec-head block">
      <Icon name="lock" :size="16" /> 证书
      <!-- 自签 leaf 由面板本地根 CA 签发；不把根证书装进信任库，浏览器必然报不可信 -->
      <button class="btn-ghost btn-sm ca-btn" title="导入根证书后，全部本地 HTTPS 站点不再报「非私密连接」" @click="caHelp = true">
        <Icon name="lock" :size="13" /> 信任根证书
      </button>
    </div>
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
      <div ref="modalBox" class="modal wide" role="dialog" aria-modal="true">
        <h3>{{ editing ? '编辑站点' : '新建站点' }}</h3>
        <!-- 未接入底座时：站点仍可登记，但配置下发不了。如实说明，不装作能开 -->
        <div v-if="!webSupported" class="hint-note is-warn">
          <Icon name="alert" :size="15" class="ic" />
          <span>未接入 Web 服务器（nginx）：<b>只能保存站点登记信息，无法下发配置</b>；
            下方的类型 / 反代 / PHP / WAF 也需底座才能生效。</span>
        </div>
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
        <label class="blk">类型
          <select v-model="form.kind" :disabled="!webSupported">
            <option value="static">静态</option>
            <option value="proxy">反向代理 / 负载均衡</option>
            <option value="php">PHP (php-fpm)</option>
          </select>
        </label>
        <label v-if="form.kind === 'proxy'" class="blk">后端（逗号分隔）
          <input v-model="form.upstreams" :disabled="!webSupported"
            placeholder="http://127.0.0.1:3000, http://127.0.0.1:3001" />
        </label>
        <label v-if="form.kind === 'php'" class="blk">php-fpm
          <input v-model="form.fpm" :disabled="!webSupported"
            placeholder="unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000" />
        </label>

        <!-- WAF：站点配置的一部分，与其它字段**同一次下发**，故同处一个表单 -->
        <div class="waf">
          <label class="inline" title="在被管理站点前生成拦截规则；规则集由系统内置，此处只能选档位与数值">
            <input type="checkbox" v-model="form.wafOn" :disabled="!webSupported" /> 启用 WAF
          </label>
          <template v-if="form.wafOn">
            <label>档位
              <select v-model="form.wafProfile" :disabled="!webSupported">
                <option value="basic">基础（SQLi / XSS / 穿越 / 敏感文件 / 恶意 UA）</option>
                <option value="strict">严格（+ 空 UA、非白名单方法，误杀率更高）</option>
              </select>
            </label>
            <label>CC 限速（次/秒，0 = 不限）
              <input v-model.number="form.wafRate" type="number" min="0" max="1000" :disabled="!webSupported" />
            </label>
            <label :title="form.wafRate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速，否则后端会拒绝'">
              突发桶（0 = 自动）
              <input v-model.number="form.wafBurst" type="number" min="0" max="10000"
                :disabled="!webSupported || !form.wafRate" />
            </label>
          </template>
        </div>

        <label class="blk row-inline">
          <input type="checkbox" v-model="form.enabled" />
          <span>启用（纳入 Web 服务器配置）</span>
        </label>
        <div class="hint-note" :class="{ 'is-warn': !!editing }">
          <Icon name="info" :size="15" class="ic" />
          <span>{{ editing
            ? '保存后立即生效：取消勾选会从 Web 服务器移除该站点配置并重载，站点随即停止对外服务；重新勾选则按当前设置重新下发。'
            : '保存即下发：站点会立即对外服务。取消勾选则只登记站点、不下发配置。' }}</span>
        </div>
        <p class="tip">
          流程：渲染 → 语法校验 → 原子替换 → reload → 入库；校验失败时旧配置不受影响。
          反代后端由 nginx <code>upstream</code>（least_conn）轮询，只接受
          <code>http(s)://host:port</code>；WAF 与站点配置同一次下发。
        </p>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeModal">取消</button>
          <button class="btn-primary" :disabled="busy" @click="save">
            {{ busy ? '保存中…' : (editing ? '保存并应用' : '创建并应用') }}</button>
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

    <!-- 根证书安装指引：自签 leaf 由面板本地根 CA 签发，不把根装进信任库浏览器必然报不可信。
         这是「自签证书没法在本地用」的正解——不是换证书，而是装根。 -->
    <div v-if="caHelp" class="mask" @click.self="caHelp = false">
      <div class="modal wide" role="dialog" aria-modal="true">
        <h3>安装面板根证书</h3>
        <p class="ca-lede">
          面板自签的站点证书，全部由<b>本机这一张根 CA</b> 签发。浏览器只信任「已装进信任库的根 CA」，
          所以直接访问会提示「不受信任 / 非私密连接」——这是证书链原理，不是面板坏了。
          <b>导入一次</b>即可：这张 CA 签发的全部本地站点（含以后新建的）都直接受信，无需再点「继续前往」。
        </p>
        <p class="ca-warn">
          <Icon name="alert" :size="14" />
          <span>根证书仅用于本机开发。<b>不要</b>把它装到不受你控制的机器上——装上等于信任该 CA 签发的任何证书。</span>
        </p>

        <div class="ca-actions">
          <button class="btn-primary" @click="downloadCa()"><Icon name="download" :size="14" /> 下载根证书（ca.crt）</button>
        </div>

        <div class="ca-steps">
          <div class="ca-step">
            <div class="ca-step-h">① 下载</div>
            <p class="dim">点上方按钮，浏览器会保存 <code>forkpanel-local-ca.crt</code>（PEM 格式的 X.509 证书）。</p>
          </div>
          <div class="ca-step">
            <div class="ca-step-h">② 装入信任库</div>
            <p class="dim"><b>Debian / Ubuntu 系统级</b>（curl、wget 与部分 Chromium 读系统库）：</p>
            <pre class="ca-code">sudo cp forkpanel-local-ca.crt /usr/local/share/ca-certificates/forkpanel-local-ca.crt
sudo update-ca-certificates</pre>
            <p class="dim"><b>Firefox</b> 用的是自带信任库，系统级导入对它无效：设置 → 隐私与安全 → 证书 →
              查看证书 → 证书颁发机构 → 导入，选中该文件并勾选<b>「信任由此 CA 标识的网站」</b>。</p>
            <p class="dim"><b>Chrome / Chromium</b>：设置 → 隐私和安全 → 安全 → 管理证书 →
              受信任的根证书颁发机构 → 导入（Linux 上通常装完系统级后重启浏览器即可）。</p>
          </div>
          <div class="ca-step">
            <div class="ca-step-h">③ 验证</div>
            <pre class="ca-code">curl --cacert forkpanel-local-ca.crt -I https://127.0.0.1</pre>
            <p class="dim">返回 <code>HTTP/2 200</code> 且无证书告警即导入成功。浏览器需<b>完全退出后重开</b>才会重读信任库。</p>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-ghost" @click="caHelp = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- SSL 签发弹窗（审计 U6）：替代 window.prompt 选方式/填邮箱 -->
    <div v-if="sslModal" class="mask" @click.self="sslModal = null">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>为「{{ sslModal.site.name }}」申请证书</h3>
        <label class="ssl-opt">
          <input type="radio" value="self-signed" v-model="sslModal.method" />
          <span><b>面板自签</b><br /><span class="dim">离线可用、立即可得；需先导入面板根证书浏览器才受信（见上方「信任根证书」）</span></span>
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
/* WAF 区块：位于站点编辑弹窗内，用虚线分隔以表明它是站点配置的一部分而非并列项 */
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
/* 根证书入口：证书区标题右侧（.sec-head 是 flex，margin-left:auto 把它推到最右） */
.ca-btn { margin-left: auto; }
/* 根证书引导弹窗：比普通弹窗宽——内含分步说明与命令块，窄了命令会折行难读 */
.modal.wide { width: min(620px, 94vw); max-height: 86vh; overflow: auto; padding-bottom: 0; }
/* 吸底操作条：弹窗比视口高时按钮会随内容一起滚走，矮窗口下看不见也点不到。
   .modal.wide 自身即滚动容器，sticky 相对它的 padding box 生效；弹窗下内边距改由
   操作条自己承担（故 .modal.wide 的 padding-bottom 归零），负左右外边距让操作条通栏。 */
.modal.wide .modal-actions { position: sticky; bottom: 0; margin: 14px -20px 0;
  padding: 12px 20px; background: var(--c-surface-2); border-top: 1px solid var(--c-border); }
.ca-lede { margin: 0 0 12px; font-size: 13px; line-height: 1.7; color: var(--c-text-dim); }
.ca-warn { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 14px; padding: 9px 11px;
  border-radius: 8px; font-size: 12.5px; line-height: 1.6; color: var(--c-text-dim);
  background: var(--c-hover); border: 1px solid var(--c-border); border-left: 3px solid var(--c-warn); }
.ca-warn .icon { color: var(--c-warn); margin-top: 2px; }
.ca-actions { display: flex; gap: 10px; margin: 0 0 18px; }
.ca-steps { display: flex; flex-direction: column; gap: 14px; }
.ca-step-h { font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--c-primary); }
.ca-step p { margin: 0 0 6px; font-size: 12.5px; line-height: 1.65; }
.ca-code { margin: 6px 0; padding: 9px 11px; border-radius: 8px; font-size: 12px; line-height: 1.6;
  overflow-x: auto; background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text); }
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

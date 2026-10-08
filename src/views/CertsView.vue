<script setup lang="ts">
/**
 * 证书总览（全局统一管理入口）。
 *
 * 与 WAF 同构：单站 SSL 配置入口在「网站 → 编辑站点」弹窗里，本页把全部站点的
 * 证书收到一屏——可就地续期 / 删除 / 开关自动续期，并提供全局「申请证书」（选站点 + 方式）
 * 与「信任根证书」入口（全局动作，零站点也能进，修复此前根 CA 被埋进站点弹窗的短板）。
 *
 * 能力门控（与 SitesView 一致，请求前判定）：
 * - 菜单可见用 `site.view`（证书归属站点，恒可达）；页内动作按 `ssl.manage` 置灰。
 * - SSL 真正可用需 ① 底座 nginx ② 签发渠道(openssl/ACME) ③ ssl.manage 权限。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, certSourceLabel, fmtDate, type Cert, type Site } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface RenewSweep { last_at: number; last_queued: number; next_at: number }

const auth = useAuthStore()
const certs = ref<Cert[]>([])
const sites = ref<Site[]>([])
const sweep = ref<RenewSweep>({ last_at: 0, last_queued: 0, next_at: 0 })
const error = ref('')
const notice = ref('')
const busy = ref(false)
const loading = ref(false)

const canSsl = computed(() => auth.can('ssl.manage'))
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
const sslSupported = computed(() => auth.supported(CAP.SSL_ACME))
const selfSignedSupported = computed(() => auth.supported(CAP.SSL_SELFSIGNED))
// SSL 真正可用需 底座 nginx + 签发渠道(openssl/ACME) + ssl.manage 权限
const sslReady = computed(() =>
  webSupported.value && (sslSupported.value || selfSignedSupported.value) && canSsl.value)
const sslHint = computed(() => {
  if (!canSsl.value) return '无 ssl.manage 权限'
  if (!webSupported.value) return '需先安装并启动 Web 服务器（nginx）——证书没有进程可加载'
  return '需 openssl 或 ACME'
})

async function load(silent = false) {
  if (!silent) { loading.value = true; error.value = ''; notice.value = '' }
  try {
    const [cs, ss] = await Promise.all([
      api.get<Cert[]>(API.certs.list()),
      api.get<Site[]>(API.sites.list()),
    ])
    certs.value = cs
    sites.value = ss
    try { sweep.value = await api.get<RenewSweep>(API.certs.renewSweep()) }
    catch { /* 扫描状态缺失不阻断证书列表 */ }
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
/** 反查域名所属站点名（一个域名一行，多域名站点会重复出现）。 */
function siteOf(domain: string): string {
  const s = sites.value.find(s => s.domains.includes(domain))
  return s ? s.name : '—'
}

// 根证书（全局动作，始终可达——零站点也能进）
function downloadCa() { window.location.href = API.certs.ca() }

// 续期 / 自动续期 / 删除
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

// 申请证书（选站点 + 方式 + email）。证书绑定 domain，故须先选站点。
const sslModal = ref<{ siteId: number; method: 'self-signed' | 'http-01'; email: string } | null>(null)
function openApply() {
  const first = sites.value[0]
  sslModal.value = {
    siteId: first ? first.id : 0,
    method: selfSignedSupported.value ? 'self-signed' : 'http-01',
    email: '',
  }
}
async function execSsl() {
  const m = sslModal.value
  if (!m || !m.siteId) return
  const site = sites.value.find(s => s.id === m.siteId)
  if (!site) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.post(API.sites.sslApply(site.id),
      { domains: site.domains, method: m.method, email: m.method === 'http-01' ? m.email.trim() : undefined })
    notice.value = m.method === 'self-signed'
      ? `已为 ${site.name} 签发面板自签证书`
      : `已提交 ${site.name} 的 ACME 签发任务`
    sslModal.value = null
    if (m.method === 'self-signed') await load()
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入证书签发能力（需 openssl 或 ACME）'
    else error.value = errorText(e)
  } finally { busy.value = false }
}
</script>

<template>
  <div class="view">
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="sec-head">
      <Icon name="lock" :size="16" /> 站点证书
      <span class="spacer" />
      <!-- 信任根证书：全局动作，始终可达（零站点也能进） -->
      <button class="btn-ghost" title="导入根证书后，全部本地 HTTPS 站点不再报「非私密连接」" @click="downloadCa">
        <Icon name="shield" :size="15" /> 信任根证书
      </button>
      <button class="btn-ghost" :disabled="busy" @click="load()">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
      <button class="btn-primary" :disabled="!sslReady" :title="sslReady ? '为某站点申请证书' : sslHint" @click="openApply">
        <Icon name="plus" :size="15" /> 申请证书
      </button>
    </div>

    <!-- 自动续期扫描状态（全局，非单站） -->
    <p v-if="sweep.last_at || sweep.next_at" class="sweep">
      <Icon name="clock" :size="14" />
      自动续期扫描：{{ sweep.last_at ? `上次 ${fmtDate(sweep.last_at)}` : '尚未运行' }} ·
      下次约 {{ sweep.next_at ? fmtDate(sweep.next_at) : '每日约 04:05' }}
      <span v-if="sweep.last_queued > 0"> · 上次入队 {{ sweep.last_queued }} 张</span>
    </p>

    <div v-if="loading && !certs.length" class="skeleton box" />
    <EmptyState v-else-if="!certs.length && !error" title="暂无证书"
      desc="先在「网站」建站并申请证书，或点上方「申请证书」" />

    <div v-else-if="certs.length" class="card flush">
      <table class="fixed">
        <!-- 证书表列宽独立一套（与站点表互不干扰）：域名弹性吸收剩余，其余固定。 -->
        <colgroup>
          <col class="cert-dom" /><col class="cert-site" /><col class="cert-src" /><col class="cert-exp" /><col class="cert-left" /><col class="cert-auto" /><col class="cert-acts" />
        </colgroup>
        <thead>
          <tr><th>域名</th><th>站点</th><th>来源</th><th>到期</th><th>剩余</th><th>自动续期</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in certs" :key="c.id">
            <td class="mono ellipsis" :title="c.domain">{{ c.domain }}</td>
            <td class="ellipsis" :title="siteOf(c.domain)">{{ siteOf(c.domain) }}</td>
            <td>{{ certSourceLabel(c.source) }}</td>
            <td class="mono dim">{{ fmtDate(c.not_after) }}</td>
            <td :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</td>
            <td>
              <label class="switch" :title="sslSupported ? '到期前 30 天内自动续期' : '需 ACME 支持'">
                <input type="checkbox" :checked="c.auto_renew" :disabled="!sslReady || busy"
                  @change="setAutoRenew(c, ($event.target as HTMLInputElement).checked)" />
                <i />
              </label>
            </td>
            <td>
              <button class="btn-ghost btn-sm" :disabled="!sslReady || busy" :title="sslReady ? '' : sslHint" @click="renewCert(c)">
                <Icon name="refresh" :size="13" /> 续期
              </button>
              <button class="btn-ghost btn-sm danger" :disabled="!canSsl || busy" :title="canSsl ? '' : '无 ssl.manage 权限'" @click="delCert = c">
                <Icon name="trash" :size="13" /> 删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="tip">
      证书是<b>站点维度</b>的资源：单站申请 / 查看在「网站 → 编辑站点」弹窗里；
      本页把<b>全部站点</b>的证书汇总到一屏，便于统一巡检到期与续期。「信任根证书」是
      一次性全局动作——导入面板本地根 CA 后，所有自签 HTTPS 站点不再报「非私密连接」，
      首次部署、尚未建站时也应先完成这步。
    </p>

    <!-- 申请证书弹窗 -->
    <div v-if="sslModal" class="mask" @click.self="sslModal = null">
      <div class="modal">
        <h3>申请证书</h3>
        <label class="blk">站点
          <select v-model.number="sslModal.siteId" :disabled="!sites.length">
            <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}（{{ s.domains.join(', ') }}）</option>
          </select>
        </label>
        <div class="radios">
          <label :class="{ on: sslModal.method === 'self-signed' }">
            <input type="radio" value="self-signed" v-model="sslModal.method" :disabled="!selfSignedSupported" />
            <span><b>面板自签</b><br /><span class="dim">本地根 CA 签发，导入根证书即可信任，无需公网</span></span>
          </label>
          <label :class="{ on: sslModal.method === 'http-01' }">
            <input type="radio" value="http-01" v-model="sslModal.method" :disabled="!sslSupported" />
            <span><b>ACME http-01</b><br /><span class="dim">可信证书，需公网 80 端口可达 + certbot</span></span>
          </label>
        </div>
        <label v-if="sslModal.method === 'http-01'" class="blk">邮箱（ACME 注册）
          <input v-model="sslModal.email" type="email" placeholder="ops@example.com" autocomplete="email" />
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="sslModal = null">取消</button>
          <button class="btn-primary" :disabled="busy || !sslModal.siteId || (sslModal.method === 'http-01' && !sslModal.email.trim())"
            @click="execSsl">申请</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="delCert" class="mask" @click.self="delCert = null">
      <div class="modal">
        <h3>删除证书</h3>
        <p>将删除证书「<b>{{ delCert.domain }}</b>」。删除后该域名 HTTPS 将不可用，直至重新申请。</p>
        <div class="modal-actions">
          <button class="btn-ghost" @click="delCert = null">取消</button>
          <button class="btn-primary danger" :disabled="busy" @click="doDeleteCert">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 14px; }
.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.spacer { flex: 1; }
.sweep { display: flex; align-items: center; gap: 6px; color: var(--c-text-dim); font-size: 12.5px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dim { color: var(--c-text-dim); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }

/* 表基础 + 列宽（独立一套，与站点表互不干扰） */
table.fixed { table-layout: fixed; width: 100%; }
.cert-dom { width: auto; }   /* 弹性列，吸收剩余 */
.cert-site { width: 130px; }
.cert-src { width: 96px; }
.cert-exp { width: 112px; }
.cert-left { width: 78px; }
.cert-auto { width: 112px; }
.cert-acts { width: 168px; }

.ok { color: var(--c-ok); }
.warn { color: var(--c-warn); }
.bad { color: var(--c-danger); }

.btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: 8px; background: transparent; color: var(--c-text-dim); cursor: pointer; font-size: 13px; font-family: inherit; }
.btn-ghost:hover:not(:disabled) { background: var(--c-hover); color: var(--c-text); }
.btn-ghost:disabled { opacity: .5; cursor: not-allowed; }
.btn-ghost.danger:hover:not(:disabled) { color: var(--c-danger); border-color: color-mix(in srgb, var(--c-danger) 40%, transparent); }
.btn-sm { padding: 5px 9px; font-size: 12.5px; }
.btn-primary { padding: 6px 14px; border: none; border-radius: 8px; cursor: pointer; background: var(--gradient); color: #fff; font-size: 13px; font-family: inherit; font-weight: 600; }
.btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.btn-primary.danger { background: var(--c-danger); }
.err { color: var(--c-danger); font-size: 13px; }
.notice { color: var(--c-ok); background: var(--c-ok-soft); border: 1px solid color-mix(in srgb, var(--c-ok) 35%, transparent); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.tip { color: var(--c-text-dim); font-size: 12.5px; line-height: 1.7; }

/* switch（与 SitesView 同款 42×24 实心主色） */
.switch { position: relative; width: 42px; height: 24px; display: inline-block; vertical-align: middle; flex: none; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch i { position: absolute; inset: 0; border-radius: 999px; background: var(--c-hover); border: 1px solid var(--c-border); transition: background .15s, border-color .15s; }
.switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--c-text); box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: all .15s; }
.switch input:checked + i { background: var(--c-primary); border-color: var(--c-primary); }
.switch input:checked + i::after { left: 21px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.switch input:disabled + i { opacity: .5; cursor: not-allowed; }

/* 弹窗（复用 SitesView 的 .mask/.modal 结构） */
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 50; }
.modal { width: 440px; max-width: calc(100vw - 32px); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.modal h3 { margin: 0 0 14px; font-size: 16px; }
.modal .blk { display: block; font-size: 13px; color: var(--c-text-dim); margin: 12px 0; }
.modal .blk select, .modal .blk input { width: 100%; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-surface); color: var(--c-text); font-size: 14px; font-family: inherit; }
.radios { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.radios label { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--c-border); border-radius: 10px; cursor: pointer; font-size: 13px; }
.radios label.on { border-color: var(--c-primary); background: var(--c-active); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.skeleton.box { height: 160px; }
</style>

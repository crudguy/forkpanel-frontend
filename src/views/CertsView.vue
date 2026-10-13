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
import HelpDrawer from '@/components/HelpDrawer.vue'
import { toast } from '@/composables/useToast'
import { useModal } from '@/composables/useModal'

interface RenewSweep { last_at: number; last_queued: number; next_at: number }

const auth = useAuthStore()
const certs = ref<Cert[]>([])
const sites = ref<Site[]>([])
const sweep = ref<RenewSweep>({ last_at: 0, last_queued: 0, next_at: 0 })
const error = ref('')
const busy = ref(false)
const loading = ref(false)
/** 帮助抽屉（A6）：页面头部「?」打开，承载证书与根 CA 的完整说明 */
const helpOpen = ref(false)

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
  if (!silent) { loading.value = true; error.value = '' }
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
const delBox = ref<HTMLElement | null>(null)
async function renewCert(c: Cert) {
  busy.value = true; error.value = ''
  try {
    await api.post(API.certs.renew(c.id), {})
    toast(`已续期 ${c.domain} 的证书`)
  } catch (e) {
    if (isUnsupported(e)) toast('当前环境未接入证书续期能力', 'warn')
    else error.value = errorText(e)
  } finally { busy.value = false; await load() }
}
async function setAutoRenew(c: Cert, val: boolean) {
  busy.value = true; error.value = ''
  try {
    await api.patch(API.certs.autoRenew(c.id), { enabled: val })
    c.auto_renew = val
    toast(`${c.domain} 自动续期已${val ? '开启' : '关闭'}`)
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
const sslBox = ref<HTMLElement | null>(null)
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
  busy.value = true; error.value = ''
  try {
    await api.post(API.sites.sslApply(site.id),
      { domains: site.domains, method: m.method, email: m.method === 'http-01' ? m.email.trim() : undefined })
    toast(m.method === 'self-signed'
      ? `已为 ${site.name} 签发面板自签证书`
      : `已提交 ${site.name} 的 ACME 签发任务`)
    sslModal.value = null
    if (m.method === 'self-signed') await load()
  } catch (e) {
    if (isUnsupported(e)) toast('当前环境未接入证书签发能力（需 openssl 或 ACME）', 'warn')
    else error.value = errorText(e)
  } finally { busy.value = false }
}

// 两个弹窗统一行为：Esc 关闭 + Tab 焦点陷阱 + 打开自动聚焦（与 SitesView 同款，审计 U1）。
// 证书页此前是裸 `v-if` + `@click.self`，键盘用户可 Tab 穿透且只能点「取消」关闭。
// 返回的 close 是**统一关闭出口**（离场动画 + 焦点返还）：X / 点遮罩 / 取消按钮都走它
const { close: closeSslModal } = useModal(() => !!sslModal.value, sslBox, () => (sslModal.value = null))
const { close: closeDelCert } = useModal(() => !!delCert.value, delBox, () => (delCert.value = null))
</script>

<template>
  <div class="view">
    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button></p>

    <div class="page-head">
      <button class="btn-icon ghost" type="button" title="证书说明" @click="helpOpen = true">
        <Icon name="help" :size="16" />
      </button>
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
      hint="先在「网站」建站并申请证书，或点上方「申请证书」">
      <template #cta>
        <RouterLink v-if="!sites.length" class="btn-primary btn-sm" to="/sites">去建站</RouterLink>
        <button v-else class="btn-primary btn-sm" :disabled="!sslReady" :title="sslHint" @click="openApply">申请证书</button>
      </template>
    </EmptyState>

    <div v-else-if="certs.length" class="card flush">
      <table class="fixed" aria-label="证书列表" v-table-nav>
        <!-- 证书表列宽独立一套（与站点表互不干扰）：域名弹性吸收剩余，其余固定。 -->
        <colgroup>
          <col class="cert-dom" /><col class="cert-site" /><col class="cert-src" /><col class="cert-exp" /><col class="cert-left" /><col class="cert-auto" /><col class="cert-acts" />
        </colgroup>
        <!-- scope="col"（审计 A3）；.col-opt 标记次要列，窄屏由公共规则隐藏 -->
        <thead>
          <tr>
            <th scope="col">域名</th><th scope="col" class="col-opt">站点</th><th scope="col" class="col-opt">来源</th>
            <th scope="col">到期</th><th scope="col">剩余</th><th scope="col">自动续期</th><th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in certs" :key="c.id">
            <td class="mono ellipsis" :title="c.domain">{{ c.domain }}</td>
            <td class="ellipsis col-opt" :title="siteOf(c.domain)">{{ siteOf(c.domain) }}</td>
            <td class="col-opt">{{ certSourceLabel(c.source) }}</td>
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
              <button class="btn-ghost btn-sm" :disabled="!sslReady || busy" :title="sslReady ? '续期' : sslHint" @click="renewCert(c)">
                <Icon name="refresh" :size="13" /><span class="btn-label">续期</span>
              </button>
              <button class="btn-ghost btn-sm danger" :disabled="!canSsl || busy" :title="canSsl ? '删除' : '无 ssl.manage 权限'" @click="delCert = c">
                <Icon name="trash" :size="13" /><span class="btn-label">删除</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 完整说明收进帮助抽屉（A6）：页面流里不再铺长文；「?」在页面头部 -->
    <HelpDrawer :open="helpOpen" title="证书说明" @close="helpOpen = false">
      <p>证书是<b>站点维度</b>的资源：单站申请 / 查看在「网站 → 编辑站点」弹窗里；本页把<b>全部站点</b>的证书汇总到一屏，便于统一巡检到期与续期。</p>
      <h4>信任根证书</h4>
      <p>一次性全局动作——导入面板本地根 CA 后，所有自签 HTTPS 站点不再报「非私密连接」。<b>首次部署、尚未建站时也应先完成这步</b>。</p>
      <h4>自动续期</h4>
      <p>到期前 30 天内由后台扫描自动续期（仅 ACME 渠道）；自签证书可手动「续期」重新签发。</p>
    </HelpDrawer>

    <!-- 申请证书弹窗 -->
    <div v-if="sslModal" class="mask" @click.self="closeSslModal">
      <div ref="sslBox" class="modal" role="dialog" aria-modal="true" aria-label="申请证书">
        <div class="modal-head">
          <h3 class="modal-title">申请证书</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeSslModal">
            <Icon name="close" :size="16" />
          </button>
        </div>
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
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeSslModal">取消</button>
            <button class="btn-primary" :disabled="busy || !sslModal.siteId || (sslModal.method === 'http-01' && !sslModal.email.trim())"
              @click="execSsl">申请</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="delCert" class="mask" @click.self="closeDelCert">
      <div ref="delBox" class="modal" role="dialog" aria-modal="true" aria-label="删除证书">
        <div class="modal-head">
          <h3 class="modal-title">删除证书</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeDelCert">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p class="modal-lead">将删除证书「<b>{{ delCert.domain }}</b>」。删除后该域名 HTTPS 将不可用，直至重新申请。</p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeDelCert">取消</button>
            <!-- 危险主操作 → 实心 .btn-danger（此前 btn-primary danger 是第三套长相） -->
            <button class="btn-danger" :disabled="busy" @click="doDeleteCert">删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 14px; }
.sweep { display: flex; align-items: center; gap: 6px; color: var(--c-text-dim); font-size: var(--fs-12-5); }
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

/* 按钮 / 文字色 / 区块标题 / 弹窗 / 骨架屏 一律复用 main.css 公共类，
   不再私有重定义（审计 V1：证书页自造按钮样式曾与全局漂移）。
   状态色 .ok/.warn/.bad 取公共工具类；.skeleton 取公共基础，仅补高度。 */
.radios { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.radios label { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--c-border); border-radius: 10px; cursor: pointer; font-size: var(--fs-13); }
.radios label.on { border-color: var(--c-primary); background: var(--c-active); }
.skeleton.box { height: 160px; }
</style>

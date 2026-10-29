<script setup lang="ts">
/**
 * WAF 控制台（统一管理入口）。
 *
 * 站点 WAF 本来就是 nginx/caddy 配置的一部分——与站点配置**同一次 apply** 下发，
 * 真正的配置项入口也在「网站 → 编辑站点」弹窗里。本页把各站的 WAF 状态与
 * **IP 访问控制**收到一屏：顶部总览 + 逐站就地编辑 + 应用；下方再有**策略模板**区，
 * 把一套 WAF + 访问控制预设存成可复用单元，批量套用到站点。
 *
 * 与后端严格对齐的语义（与 SitesView 一致，勿改）：
 * - `waf` 缺省 = 保留库中现值（不是关闭）→ 本页**总是显式下发** `waf` 段；
 * - `rate_per_sec: 0` = 不限速；`burst` 仅在限速时才有意义（不限速却带 burst
 *   会被后端 400 —— 那属于"配了但没生效"的静默失败，后端刻意拒绝）；
 * - `ip_allow` / `ip_deny`：逗号/空格分隔的 IPv4 或 CIDR；**白名单非空即白名单
 *   模式**（只放行名单内、其余拒绝），此时黑名单被忽略——UI 对二者互斥置灰；
 * - **caddy 后端不支持限速**（标准 caddy 无 rate_limit 指令，渲染时刻意忽略）：
 *   `auth.webBackend === 'caddy'` 时限速/突发输入置灰并说明，避免"配了没生效"。
 *   （IP 访问控制在 nginx 与 caddy 双端均已实装，不受此后端限制。）
 *
 * 策略模板（026）：模板 CRUD 走后端 `/api/v1/waf/templates`；**套用不做成后端端点**，
 * 由本页读取模板后经既有 `POST /sites/apply` 逐站编排（不在前端重复站点部署管线）。
 * ⚠ TplReq 的 PATCH 是**全量替换**（缺省=默认、非保留），故模板表单每次都送全字段。
 *
 * ⚠️ 已知副作用（如实写在界面上，不藏着）：后端 apply 的 upsert 会把站点
 *    `enabled` 置 1，所以**已停用的站点**在逐站表里禁用「应用」、套用弹窗里标注
 *    "会一并启用"，避免用户只想改 WAF 却被静默启用站点。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, wafProfileLabel, type Site, type WafTemplate, type BlockEvent } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import MetricCard from '@/components/MetricCard.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { toast } from '@/composables/useToast'
import { useAsync } from '@/composables/useAsync'
// WAF 段 / apply 体 / 草稿比对的纯逻辑在 .ts 里（SFC 内 vitest 收不到）
import {
  normIp, showIps, toDraft, draftDirty, siteBase, draftWafSeg, templateWafSeg,
  applyBody, applyTemplateBody, kindLabel, type Draft,
} from '@/composables/siteWaf'


const auth = useAuthStore()
const sites = ref<Site[]>([])
const drafts = ref<Record<number, Draft>>({})
const templates = ref<WafTemplate[]>([])
const { error, loading, run } = useAsync()
const busyId = ref<number | null>(null)
/** 帮助抽屉（A6）：页面头部「?」打开，承载 WAF 完整约束说明 */
const helpOpen = ref(false)

const canManage = computed(() => auth.can('site.manage'))
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
// 下发 WAF 就是下发 Web 服务器配置 → 与 SitesView 的 canApply 同款门控
const canApply = computed(() => webSupported.value && canManage.value)
/** caddy 后端：IP 名单双端都实装，但**限速被有意忽略**（标准 caddy 无 rate_limit） */
const isCaddy = computed(() => auth.webBackend === 'caddy')

// normIp（提交口径）/ toDraft 已抽到 composables/siteWaf.ts。
// ⚠ 站点表单 useSiteForm.ts 与本页面共用同一个 normIp——两页提交的是同一个后端
//   ip_allow/ip_deny 字段，各写一份必然漂移（改了口径会有一处漏改）。

async function load(silent = false) {
  await run(async () => {
    // 站点与模板一并加载：模板 CRUD/套用都在本页，统一 error/loading 通道
    const [s, t] = await Promise.all([
      api.get<Site[]>(API.sites.list()),
      api.get<WafTemplate[]>(API.waf.templates.list()),
    ])
    sites.value = s ?? []
    templates.value = t ?? []
    // 每次加载都重置草稿：下拉/输入是"当前生效值"的镜像，不留上次未应用的脏值
    drafts.value = Object.fromEntries((s ?? []).map(x => [x.id, toDraft(x)]))
  }, undefined, { silent })
}

/** 是否有未应用的改动（含 IP 访问控制）。
 *  三条判定语义——IP 比较前先归一、关闭时不比 profile/rate/burst、草稿缺失判不脏——
 *  都在 composables/siteWaf.ts 的 draftDirty 里（那里才有测试盯着）；
 *  本函数只负责**取该站的草稿**（读 reactive 状态属于视图职责）。 */
function dirty(s: Site): boolean {
  return draftDirty(s, drafts.value[s.id])
}

/**
 * 顶部总览指标（与 SecurityView 的 summaryCards 同范式：computed 出卡片 props 数组）。
 * 数字全部由 sites 现值算出，不额外请求——WAF/IP 状态本就在站点列表里。
 */
const summaryCards = computed(() => {
  const total = sites.value.length
  const on = sites.value.filter(s => s.waf_enabled)
  const strict = on.filter(s => s.waf_profile === 'strict').length
  const basic = on.length - strict
  const rated = on.filter(s => (s.waf_rate_per_sec ?? 0) > 0).length
  const acl = sites.value.filter(s => (s.ip_allow ?? []).length || (s.ip_deny ?? []).length).length
  return [
    { label: 'WAF 开启', value: String(on.length), unit: `/ ${total} 站`,
      sub: total - on.length ? `${total - on.length} 站未开启` : '全部站点已开启',
      icon: 'shield', tone: 'ok' as const,
      progress: total ? (on.length / total) * 100 : 0 },
    { label: '严格档', value: String(strict), unit: '站',
      sub: `基础 ${basic} · 严格 ${strict}`, icon: 'firewall', tone: 'warn' as const },
    { label: 'CC 限速', value: String(rated), unit: '站限速',
      sub: isCaddy.value ? 'caddy 后端暂不支持限速' : `开启 WAF 的 ${on.length} 站中`,
      icon: 'gauge', tone: isCaddy.value ? ('warn' as const) : ('cyan' as const) },
    { label: '访问控制', value: String(acl), unit: '站设 IP 名单',
      sub: 'IP 白 / 黑名单（IPv4 / CIDR）', icon: 'lock', tone: 'primary' as const },
  ]
})

// siteBase / applyBody / applyTemplateBody / draftWafSeg / templateWafSeg 已抽到
// composables/siteWaf.ts：逐站应用与模板套用**共用同一出处**，才不会漏传
// upstreams / fpm（漏传会把反代或 PHP 站的后端地址清空）。

async function applyWaf(s: Site) {
  const d = drafts.value[s.id]; if (!d) return
  busyId.value = s.id; error.value = ''
  try {
    await api.post(API.sites.apply(), applyBody(s, d))
    toast(d.on ? `已为 ${s.name} 应用 WAF（${wafProfileLabel(d.profile)}）` : `已关闭 ${s.name} 的 WAF`)
    await load()
  } catch (e) {
    if (isUnsupported(e)) toast('当前环境未接入 Web 服务器，无法应用配置', 'warn')
    else error.value = errorText(e)
  } finally { busyId.value = null }
}

/** 「应用全部」的目标：已启用站点中确有改动、且当前环境可下发的那些。 */
const pending = computed(() =>
  sites.value.filter((s) => s.enabled && canApply.value && dirty(s)))
/** 有改动但**不能**下发的（站点已停用）——如实计数并说明，不静默跳过。 */
const blockedPending = computed(() =>
  sites.value.filter((s) => s.enabled === false && dirty(s)).length)
const batchBusy = ref(false)

/**
 * 逐个下发。刻意**不**复用 applyWaf：它每次成功都 `await load()`，而 load 会把
 * 草稿重置成刚落库的值——循环到第二个站点时 drafts 已被换掉，后面的改动会丢失。
 * 故批量走一条不重置草稿的路径，全部跑完再统一 load 一次。
 */
async function applyAll() {
  const targets = pending.value.slice()
  if (!targets.length) return
  batchBusy.value = true; error.value = ''
  let ok = 0
  try {
    for (const s of targets) {
      const d = drafts.value[s.id]; if (!d) continue
      try {
        await api.post(API.sites.apply(), applyBody(s, d))
        ok++
      } catch (e) {
        // 一个失败即停：多半是环境/权限类问题，继续跑只会把后面站点也刷成同样的错
        if (isUnsupported(e)) toast('当前环境未接入 Web 服务器，无法应用配置', 'warn')
        // 写失败必须留在页面上：随后的静默刷新会把 error 清掉
        else toast(`${s.name} 下发失败：${errorText(e)}`, 'err')
        break
      }
    }
    if (ok) toast(`已应用 ${ok} 个站点的 WAF 配置`)
  } finally { batchBusy.value = false; await load(true) }
}


/** 停用站点不可应用的原因（后端 apply 会把它置为启用） */
function blockedReason(s: Site): string {
  if (!canApply.value) return webSupported.value ? '无 site.manage 权限' : '当前环境未接入 Web 服务器'
  if (!s.enabled) return '站点已停用；应用配置会一并启用它，请先启用站点'
  return ''
}

// ─────────────────────────── 策略模板（026） ───────────────────────────
interface TplForm { name: string; profile: string; rate: number; burst: number; ipAllow: string; ipDeny: string }

const tplModalOpen = ref(false)
const editingTplId = ref<number | null>(null)
const tplForm = ref<TplForm>({ name: '', profile: 'basic', rate: 0, burst: 0, ipAllow: '', ipDeny: '' })
const tplSaving = ref(false)
const tplError = ref('')

function openCreateTpl() {
  editingTplId.value = null
  tplForm.value = { name: '', profile: 'basic', rate: 0, burst: 0, ipAllow: '', ipDeny: '' }
  tplError.value = ''
  tplModalOpen.value = true
}
function openEditTpl(t: WafTemplate) {
  editingTplId.value = t.id
  tplForm.value = {
    name: t.name, profile: t.waf_profile, rate: t.rate_per_sec, burst: t.burst,
    ipAllow: showIps(t.ip_allow ?? []), ipDeny: showIps(t.ip_deny ?? []),
  }
  tplError.value = ''
  tplModalOpen.value = true
}

/** 保存模板。PATCH 是**全量替换**语义，故每次都送全字段（缺省会被后端清成默认）。 */
async function saveTpl() {
  if (!tplForm.value.name.trim()) { tplError.value = '模板名不能为空'; return }
  const body = {
    name: tplForm.value.name.trim(),
    profile: tplForm.value.profile,
    rate_per_sec: tplForm.value.rate || 0,
    burst: tplForm.value.burst || 0,
    ip_allow: tplForm.value.ipAllow,
    ip_deny: tplForm.value.ipDeny,
  }
  tplSaving.value = true; tplError.value = ''
  try {
    if (editingTplId.value == null) await api.post(API.waf.templates.create(), body)
    else await api.patch(API.waf.templates.update(editingTplId.value), body)
    tplModalOpen.value = false
    await load()
    toast(editingTplId.value == null ? '已新建模板' : '已保存模板')
  } catch (e) {
    tplError.value = errorText(e)
  } finally { tplSaving.value = false }
}

const delTpl = ref<WafTemplate | null>(null)
async function doDelTpl() {
  const t = delTpl.value
  delTpl.value = null
  if (!t) return
  try {
    await api.del(API.waf.templates.remove(t.id))
    await load()
    toast(`已删除模板 ${t.name}`)
  } catch (e) { error.value = errorText(e) }
}

// 套用模板到站点
const applyTpl = ref<WafTemplate | null>(null)
const applyPicks = ref<Set<number>>(new Set())
const applyBusy = ref(false)
/** 勾选中含已停用站点 → 套用会一并启用它（后端 upsert 副作用），如实提示 */
const applyHasDisabled = computed(() =>
  sites.value.some(s => applyPicks.value.has(s.id) && !s.enabled))

function openApplyTpl(t: WafTemplate) {
  applyTpl.value = t
  // 默认勾选全部「启用中」的站点——停用站点不默认勾（套用会顺带启用它）
  applyPicks.value = new Set(sites.value.filter(s => s.enabled).map(s => s.id))
}
function togglePick(id: number) {
  const next = new Set(applyPicks.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  applyPicks.value = next
}
async function doApplyTpl() {
  const t = applyTpl.value; if (!t) return
  // 只读账号：按钮已置灰，这里再兜一道，防止程序化调用绕过
  if (!canApply.value) return
  const targets = sites.value.filter(s => applyPicks.value.has(s.id))
  applyBusy.value = true
  let ok = 0; let failMsg = ''
  try {
    for (const s of targets) {
      try { await api.post(API.sites.apply(), applyTemplateBody(s, t)); ok++ }
      catch (e) { failMsg = `${s.name}：${errorText(e)}`; break }  // 一个失败即停
    }
    if (ok) { toast(`已将「${t.name}」套用到 ${ok} 个站点`); applyTpl.value = null; await load() }
    if (failMsg) error.value = `套用失败于 ${failMsg}`
  } finally { applyBusy.value = false }
}

// ─────────────────────────── 威胁日志 / 拦截事件（027） ───────────────────────────
const events = ref<BlockEvent[]>([])
const evtFilters = ref<{ site: string; status: string }>({ site: '', status: '' })
const evtLoading = ref(false)
const evtError = ref('')
const evtHasMore = ref(false)
const EVT_PAGE = 200
/** 未开独立 access log 的站点数——采集不到，如实提示 */
const sitesWithoutLog = computed(() => sites.value.filter(s => !s.log_access).length)

function evtStatusLabel(st: number): string {
  if (st === 403) return '拦截'
  if (st === 405) return '方法拒绝'
  if (st === 429) return '限速'
  return String(st)
}

/** 加载拦截事件（append=true 时翻页续接）。筛选：站点 / 状态码。 */
async function loadEvents(append = false) {
  evtLoading.value = true; evtError.value = ''
  try {
    const p = new URLSearchParams()
    if (evtFilters.value.site) p.set('site', evtFilters.value.site)
    if (evtFilters.value.status) p.set('status', evtFilters.value.status)
    p.set('limit', String(EVT_PAGE))
    p.set('offset', append ? String(events.value.length) : '0')
    const list = await api.get<BlockEvent[]>(`${API.waf.events.list()}?${p.toString()}`)
    events.value = append ? events.value.concat(list) : list
    evtHasMore.value = list.length >= EVT_PAGE
  } catch (e) {
    evtError.value = errorText(e)
  } finally { evtLoading.value = false }
}

// ─────────────────────────── 拦截告警配置（028） ───────────────────────────
interface AlertCfg { enabled: boolean; threshold: number; window_min: number }
const alertCfg = ref<AlertCfg>({ enabled: true, threshold: 50, window_min: 5 })
const alertLoading = ref(false)
const alertSaving = ref(false)
const alertError = ref('')

async function loadAlert() {
  alertLoading.value = true; alertError.value = ''
  try {
    alertCfg.value = await api.get<AlertCfg>(API.waf.alert.get())
  } catch (e) { alertError.value = errorText(e) }
  finally { alertLoading.value = false }
}

async function saveAlert() {
  alertSaving.value = true; alertError.value = ''
  try {
    await api.put(API.waf.alert.put(), {
      enabled: alertCfg.value.enabled,
      threshold: alertCfg.value.threshold,
      window_min: alertCfg.value.window_min,
    })
    toast('告警配置已保存')
  } catch (e) { alertError.value = errorText(e) }
  finally { alertSaving.value = false }
}

onMounted(() => { void load(); void loadEvents(); void loadAlert() })
</script>

<template>
  <div class="view">
    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button></p>

    <!-- 首屏必须先给骨架：请求还在飞就渲染「暂无…」会让"没有"和"没加载出来"长得一样 -->
    <div v-if="loading && !sites.length" class="skeleton box" />
    <EmptyState v-else-if="!sites.length && !error" title="暂无站点"
      hint="先在「网站」建站，再回来统一配置 WAF 与访问控制">
      <template #cta>
        <RouterLink class="btn-primary btn-sm" to="/sites">去建站</RouterLink>
      </template>
    </EmptyState>

    <template v-else-if="sites.length">
      <!-- 总览指标：WAF 覆盖 / 档位 / 限速 / 访问控制，一屏看清全站防护态势 -->
      <div class="grid cols-4">
        <MetricCard v-for="c in summaryCards" :key="c.label" v-bind="c" />
      </div>

      <div class="card flush toolbar-card">
        <div class="card-toolbar">
          <span class="count">共 {{ sites.length }} 个站点</span>
          <span class="spacer" />
          <HelpBtn title="WAF 说明" aria-label="WAF 说明" :expanded="helpOpen" @click="helpOpen = true" />
          <!-- 有改动但因站点停用而下发不了的，如实计数：不然用户会以为「都改完了」 -->
          <span v-if="blockedPending" class="dim tiny"
            :title="`${blockedPending} 个站点已停用，改动无法下发；应用配置会一并启用该站点`">
            · {{ blockedPending }} 项不可下发
          </span>
          <RefreshBtn :disabled="batchBusy" sm @click="load()" />
          <!-- 批量下发：改了多个站点时省去逐个点「应用」 -->
          <button class="btn-primary btn-sm" :disabled="!pending.length || batchBusy" @click="applyAll"
            :title="pending.length ? `一次下发这 ${pending.length} 个站点的改动` : '暂无待下发的改动'">
            <Icon name="check" :size="15" /> 应用全部{{ pending.length ? `（${pending.length}）` : '' }}
          </button>
        </div>
        <!-- 横滚只发生在表格上：卡片已改 overflow:hidden，否则窄屏横滚会把工具条一起带走 -->
        <div class="t-scroll">
        <table class="fixed" aria-label="站点 WAF 与访问控制配置" v-table-nav>
          <colgroup>
            <col class="w-wfname" /><col class="w-wfdom" /><col class="w-wfkind" /><col class="w-wfon" /><col class="w-wfprof" /><col class="w-wfrate" /><col class="w-wfburst" /><col class="w-wfip" /><col class="w-wfacts" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">站点</th><th scope="col">域名</th><th scope="col" class="col-opt">类型</th><th scope="col">WAF</th>
              <th scope="col">档位</th><th scope="col">CC 限速</th><th scope="col" class="col-opt">突发桶</th>
              <th scope="col" class="col-opt">访问控制</th><th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sites" :key="s.id">
              <td class="ellipsis" :title="s.name">{{ s.name }}</td>
              <td class="mono dim ellipsis" :title="s.domains.join(', ')">{{ s.domains.join(', ') }}</td>
              <td class="col-opt">{{ kindLabel(s.kind) }}</td>
              <td>
                <input type="checkbox" v-model="drafts[s.id].on" :aria-label="`${s.name} 启用 WAF`"
                  :disabled="!canApply || !s.enabled" :title="blockedReason(s)" />
              </td>
              <td>
                <select v-if="drafts[s.id].on" v-model="drafts[s.id].profile" :aria-label="`${s.name} 防护档位`"
                  :disabled="!canApply || !s.enabled">
                  <option value="basic">基础</option>
                  <option value="strict">严格</option>
                </select>
                <span v-else class="dim">—</span>
              </td>
              <td>
                <input v-if="drafts[s.id].on && !isCaddy" v-model.number="drafts[s.id].rate"
                  type="number" min="0" max="1000" class="num" :aria-label="`${s.name} CC 限速（每秒请求数）`"
                  :disabled="!canApply || !s.enabled" />
                <span v-else-if="drafts[s.id].on && isCaddy" class="dim tiny" title="标准 caddy 无 rate_limit 指令，限速在 caddy 后端被忽略">不支持</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="col-opt">
                <input v-if="drafts[s.id].on && !isCaddy" v-model.number="drafts[s.id].burst"
                  type="number" min="0" max="10000" class="num" :aria-label="`${s.name} 突发桶`"
                  :disabled="!canApply || !s.enabled || !drafts[s.id].rate"
                  :title="drafts[s.id].rate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速'" />
                <span v-else-if="drafts[s.id].on && isCaddy" class="dim">—</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="col-opt ip-cell">
                <input class="ip" v-model="drafts[s.id].ipAllow" placeholder="白名单" spellcheck="false"
                  :aria-label="`${s.name} IP 白名单`"
                  :title="'IP 白名单（单 IP 或 CIDR，逗号/空格分隔）。非空即只放行名单内、其余拒绝'"
                  :disabled="!canApply || !s.enabled || !!drafts[s.id].ipDeny.trim()" />
                <input class="ip" v-model="drafts[s.id].ipDeny" placeholder="黑名单" spellcheck="false"
                  :class="{ dim: !!drafts[s.id].ipAllow.trim() }"
                  :aria-label="`${s.name} IP 黑名单`"
                  :title="drafts[s.id].ipAllow.trim() ? '白名单优先：已启用白名单，黑名单被忽略' : 'IP 黑名单（单 IP 或 CIDR，逗号/空格分隔）'"
                  :disabled="!canApply || !s.enabled || !!drafts[s.id].ipAllow.trim()" />
              </td>
              <td class="acts">
                <button class="btn-primary" :disabled="!canApply || !s.enabled || !dirty(s) || busyId === s.id || batchBusy"
                  :title="blockedReason(s) || (dirty(s) ? '' : '无改动')" @click="applyWaf(s)">
                  {{ busyId === s.id ? '应用中…' : '应用' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </template>

    <!-- 策略模板（026）：与站点解耦的 WAF+访问控制预设，可套用到站点。常驻（有站无站都能建模板）。 -->
    <div class="card flush toolbar-card">
      <div class="card-toolbar">
        <Icon name="list" :size="15" class="sec-ico" />
        <span class="sec-title">策略模板</span>
        <span class="count">共 {{ templates.length }} 个</span>
        <span class="spacer" />
        <RefreshBtn :disabled="loading" sm @click="load()" />
        <button v-if="canManage" class="btn-primary btn-sm" @click="openCreateTpl">
          <Icon name="plus" :size="14" /> 新建模板
        </button>
      </div>
      <div v-if="templates.length" class="t-scroll">
        <table class="fixed" aria-label="WAF 策略模板" v-table-nav>
          <colgroup>
            <col class="w-tname" /><col class="w-tprof" /><col class="w-trate" /><col class="w-tburst" /><col class="w-tipa" /><col class="w-tipd" /><col class="w-tacts" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">名称</th><th scope="col">档位</th><th scope="col">CC 限速</th>
              <th scope="col" class="col-opt">突发桶</th><th scope="col" class="col-opt">IP 白</th>
              <th scope="col" class="col-opt">IP 黑</th><th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in templates" :key="t.id">
              <td class="ellipsis" :title="t.name">{{ t.name }}</td>
              <td>{{ wafProfileLabel(t.waf_profile) }}</td>
              <td class="num">{{ t.rate_per_sec || '不限速' }}</td>
              <td class="num col-opt">{{ t.rate_per_sec ? (t.burst || 'rate×2') : '—' }}</td>
              <td class="mono dim ellipsis col-opt" :title="showIps(t.ip_allow ?? [])">
                {{ (t.ip_allow ?? []).length ? showIps(t.ip_allow ?? []) : '—' }}
              </td>
              <td class="mono dim ellipsis col-opt" :title="(t.ip_deny ?? []).join(', ')">
                {{ (t.ip_deny ?? []).length ? (t.ip_deny ?? []).join(', ') : '—' }}
              </td>
              <td class="acts">
                <button class="btn-ghost btn-sm" :disabled="!canApply || !sites.length" :title="canApply ? '套用到站点' : '无 site.manage 权限或 Web 服务器不可用'" @click="openApplyTpl(t)">套用</button>
                <button v-if="canManage" class="btn-ghost btn-sm" @click="openEditTpl(t)">编辑</button>
                <button v-if="canManage" class="btn-ghost btn-sm danger" @click="delTpl = t">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无策略模板"
        hint="把一套 WAF + 访问控制设成模板，便于批量套用到多个站点">
        <template v-if="canManage" #cta>
          <button class="btn-primary btn-sm" @click="openCreateTpl"><Icon name="plus" :size="14" /> 新建模板</button>
        </template>
      </EmptyState>
    </div>

    <!-- 威胁日志 / 拦截事件（027）：后台每分钟采集开日志站点的 403/405/429 -->
    <div class="card flush toolbar-card">
      <div class="card-toolbar">
        <Icon name="shield" :size="15" class="sec-ico" />
        <span class="sec-title">威胁日志</span>
        <span class="count">共 {{ events.length }} 条</span>
        <span class="spacer" />
        <RefreshBtn :disabled="evtLoading" sm @click="loadEvents()" />
      </div>
      <div class="evt-filters">
        <select v-model="evtFilters.site" :disabled="evtLoading" aria-label="按站点筛选">
          <option value="">全部站点</option>
          <option v-for="s in sites" :key="s.id" :value="s.name">{{ s.name }}</option>
        </select>
        <select v-model="evtFilters.status" :disabled="evtLoading" aria-label="按状态码筛选">
          <option value="">全部状态</option>
          <option value="403">403 拦截</option>
          <option value="405">405 方法拒绝</option>
          <option value="429">429 限速</option>
        </select>
        <button class="btn-ghost btn-sm" :disabled="evtLoading" @click="loadEvents()">筛选</button>
      </div>
      <p class="evt-note">
        仅采集<b>开了独立 access log</b>的站点{{ sitesWithoutLog ? `（当前 ${sitesWithoutLog} 个站点未开，不会出现在此）` : '' }}；
        且<b>无法区分是哪条规则</b>——WAF / 敏感文件 / IP 黑名单都返回 403。要开启某站日志，到「网站 → 编辑站点」打开独立日志。
      </p>
      <p v-if="evtError" class="err" role="alert">{{ evtError }}</p>
      <div v-if="events.length" class="t-scroll">
        <table class="fixed" aria-label="拦截事件" v-table-nav>
          <colgroup>
            <col class="w-ets" /><col class="w-etsite" /><col class="w-etip" /><col class="w-etm" /><col class="w-eturi" /><col class="w-etst" /><col class="w-etua" />
          </colgroup>
          <thead><tr>
            <th scope="col">时间</th><th scope="col">站点</th><th scope="col">来源 IP</th>
            <th scope="col" class="col-opt">方法</th><th scope="col">路径</th><th scope="col">状态</th><th scope="col" class="col-opt">UA</th>
          </tr></thead>
          <tbody>
            <tr v-for="e in events" :key="e.id">
              <td class="mono dim nowrap">{{ fmtDateTime(e.ts) }}</td>
              <td class="ellipsis" :title="e.site">{{ e.site }}</td>
              <td class="mono">{{ e.remote_addr }}</td>
              <td class="col-opt mono">{{ e.method }}</td>
              <td class="mono ellipsis" :title="e.uri">{{ e.uri }}</td>
              <td><span class="badge" :class="e.status === 429 ? 'badge-warn' : 'badge-danger'">{{ e.status }} {{ evtStatusLabel(e.status) }}</span></td>
              <td class="mono dim ellipsis col-opt" :title="e.user_agent">{{ e.user_agent }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else-if="!evtLoading && !evtError" title="暂无拦截事件"
        hint="开启站点的独立 access log 后，被拦截的请求（403/405/429）会在这里出现" />
      <div v-if="evtLoading" class="skeleton box" />
      <div v-if="evtHasMore" class="evt-more">
        <button class="btn-ghost btn-sm" :disabled="evtLoading" @click="loadEvents(true)">加载更多</button>
      </div>
    </div>

    <!-- 拦截告警配置（028）：命中达阈值推站内通知 -->
    <div class="card flush toolbar-card">
      <div class="card-toolbar">
        <Icon name="bell" :size="15" class="sec-ico" />
        <span class="sec-title">拦截告警</span>
        <span class="spacer" />
        <RefreshBtn :disabled="alertLoading" sm @click="loadAlert" />
      </div>
      <div class="alert-cfg">
        <p v-if="alertError" class="err" role="alert">{{ alertError }}</p>
        <label class="al-row"><input type="checkbox" v-model="alertCfg.enabled" :disabled="alertSaving" /> <span>启用拦截告警</span></label>
        <div class="al-fields">
          <label class="blk">阈值（近窗内拦截次数）<input v-model.number="alertCfg.threshold" type="number" min="1" max="100000" :disabled="alertSaving || !alertCfg.enabled" /></label>
          <label class="blk">时间窗（分钟）<input v-model.number="alertCfg.window_min" type="number" min="1" max="1440" :disabled="alertSaving || !alertCfg.enabled" /></label>
          <button class="btn-primary btn-sm" :disabled="alertSaving" @click="saveAlert">{{ alertSaving ? '保存中…' : '保存' }}</button>
        </div>
        <p class="evt-note">近「时间窗」内单站拦截数超过「阈值」即推送一条站内通知（在顶栏铃铛 / 通知中心查看）；同站每窗至多一条，不刷屏。仅采集开了独立 access log 的站点。</p>
      </div>
    </div>

    <!-- 完整说明收进帮助抽屉（A6）；「?」在站点列表卡顶栏。浮层放链尾。 -->
    <HelpDrawer :open="helpOpen" title="WAF 说明" @close="helpOpen = false">
      <p>WAF 是站点配置的一部分，与站点配置<b>同一次 apply</b> 下发。本页把各站的 WAF 与访问控制收到一屏，可就地调整并应用；也可把常用配置存成<b>策略模板</b>批量套用。</p>
      <h4>档位</h4>
      <ul>
        <li><b>基础档</b>：拦 SQL 注入 / XSS / 路径穿越 / 敏感文件探测 / 恶意 UA。</li>
        <li><b>严格档</b>：基础档之上追加空 UA 与非白名单方法拦截，<b>误杀率更高</b>，不建议作默认。</li>
      </ul>
      <h4>CC 限速</h4>
      <p><code>rate_per_sec</code> 为 0 表示不限速；设置限速时 <code>burst</code> 才有意义（不限速却带 burst 会被后端拒绝）。超限请求返回 <code>429</code>；<code>/.well-known</code> 路径始终放行——否则会把 ACME 证书续期打死。<b>caddy 后端暂不支持限速</b>（标准 caddy 无 <code>rate_limit</code> 指令），此类站点限速项置灰。</p>
      <h4>访问控制（IP 白 / 黑名单）</h4>
      <ul>
        <li>单 IP 或 CIDR（仅 IPv4），逗号 / 空格分隔；nginx 与 caddy 双端均已实装。</li>
        <li><b>白名单优先</b>：白名单非空即进入白名单模式——只放行名单内、其余全部拒绝，此时黑名单被忽略（界面对二者互斥置灰）。</li>
      </ul>
      <h4>策略模板</h4>
      <p>模板 = 一套 WAF + 访问控制预设（档位 / 限速 / 突发 / IP 名单）。「套用」会把所选站点的这些值设成模板的值（WAF 随之开启）。模板可新建 / 编辑 / 删除；删除模板不影响已套用的站点。</p>
      <h4>已知副作用</h4>
      <p>后端 apply 的 upsert 会把站点 <code>enabled</code> 置 1，因此<b>已停用的站点</b>在逐站表里禁用「应用」、套用弹窗标注"会一并启用"，避免用户只想改 WAF 却被静默启用站点。</p>
    </HelpDrawer>

    <!-- ── 以下浮层一律放链尾：不得插在 v-if / v-else 链中间，也不得嵌进别的浮层 v-if 块内 ── -->

    <!-- 模板 新建 / 编辑 -->
    <div v-if="tplModalOpen" class="mask" @click.self="tplModalOpen = false">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">{{ editingTplId == null ? '新建策略模板' : `编辑模板 ${tplForm.name}` }}</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="tplModalOpen = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p v-if="tplError" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ tplError }}</span>
        </p>
        <label class="blk">名称
          <input v-model="tplForm.name" placeholder="如：博客基础防护" :disabled="tplSaving" />
        </label>
        <label class="blk">防护档位
          <select v-model="tplForm.profile" :disabled="tplSaving">
            <option value="basic">基础（SQLi / XSS / 路径穿越 / 恶意 UA）</option>
            <option value="strict">严格（+ 空 UA、非白名单方法，误杀率更高）</option>
          </select>
        </label>
        <label class="blk">CC 限速（次/秒，0 = 不限速）
          <input v-model.number="tplForm.rate" type="number" min="0" max="1000" :disabled="tplSaving" />
        </label>
        <label class="blk">突发桶（0 = 由 rate×2 计算）
          <input v-model.number="tplForm.burst" type="number" min="0" max="10000"
            :disabled="tplSaving || !tplForm.rate" :title="tplForm.rate ? '' : '需先设限速'" />
        </label>
        <label class="blk">IP 白名单
          <input v-model="tplForm.ipAllow" class="mono" placeholder="192.168.1.10, 10.0.0.0/24" spellcheck="false"
            :disabled="tplSaving || !!tplForm.ipDeny.trim()"
            title="单 IP 或 CIDR（IPv4），逗号/空格分隔。非空即只放行名单内、其余拒绝" />
        </label>
        <label class="blk" :class="{ 'is-dim': !!tplForm.ipAllow.trim() }">IP 黑名单
          <input v-model="tplForm.ipDeny" class="mono" placeholder="1.2.3.4, 5.6.7.0/24" spellcheck="false"
            :disabled="tplSaving || !!tplForm.ipAllow.trim()"
            :title="tplForm.ipAllow.trim() ? '白名单优先：黑名单被忽略' : '单 IP 或 CIDR（IPv4），逗号/空格分隔'" />
        </label>
        <p v-if="tplForm.ipAllow.trim()" class="hint-note">
          <Icon name="info" :size="14" class="ic" />
          <span>已设白名单：黑名单将被忽略（只放行名单内，其余拒绝）。</span>
        </p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="tplModalOpen = false" :disabled="tplSaving">取消</button>
            <button class="btn-primary" :disabled="tplSaving || !tplForm.name.trim()" @click="saveTpl">
              {{ tplSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 模板套用到站点 -->
    <div v-if="applyTpl" class="mask" @click.self="applyTpl = null">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">套用模板「{{ applyTpl.name }}」</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="applyTpl = null">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p class="modal-lead">
          将把所选站点的 WAF 与访问控制设为该模板的值：档位 <b>{{ wafProfileLabel(applyTpl.waf_profile) }}</b>、
          限速 <b>{{ applyTpl.rate_per_sec || '不限速' }}</b>、IP 白 <b>{{ (applyTpl.ip_allow ?? []).length }}</b> 项 /
          黑 <b>{{ (applyTpl.ip_deny ?? []).length }}</b> 项。
        </p>
        <p v-if="isCaddy && applyTpl.rate_per_sec" class="warn">当前为 caddy 后端，暂不支持限速——该模板的限速设置不会生效。</p>
        <p class="dim tiny">勾选要套用的站点（默认已选全部启用中的站点）：</p>
        <div class="pick-list">
          <label v-for="s in sites" :key="s.id" class="pick">
            <input type="checkbox" :checked="applyPicks.has(s.id)" @change="togglePick(s.id)" :disabled="applyBusy" />
            <span class="ellipsis">{{ s.name }}</span>
            <span v-if="!s.enabled" class="dim tiny" title="套用会一并启用该站点">（已停用）</span>
          </label>
        </div>
        <p v-if="applyHasDisabled" class="warn">勾选中含已停用站点：套用会将其一并启用。</p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="applyTpl = null" :disabled="applyBusy">取消</button>
            <button class="btn-primary" :disabled="!canApply || applyBusy || !applyPicks.size" @click="doApplyTpl">
              {{ applyBusy ? '套用中…' : `套用到 ${applyPicks.size} 个站点` }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除模板确认（低危：仅移除预设，不影响已套用站点） -->
    <ConfirmDialog v-if="delTpl" :open="!!delTpl" danger title="删除策略模板"
      :detail="`将删除模板「${delTpl.name}」。已套用该模板的站点不受影响（其 WAF / 访问控制设置保留）。`"
      @confirm="doDelTpl" @cancel="delTpl = null" />
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 14px; }
/* 仅保留布局级宽度；按钮 / 文字色 / 区块标题等一律复用 main.css 公共类 */
.num { width: 92px; }
/* 模板卡小节标题 */
.sec-ico { color: var(--c-text-dim); }
.sec-title { font-weight: 600; font-size: var(--fs-13-5); }
/* 站点表：访问控制列两个 IP 输入并排；按控件实测宽定宽 */
.ip { width: 92px; }
.ip-cell { display: flex; gap: 6px; align-items: center; }
.ip-cell .ip:disabled { opacity: .55; }
.ip-cell .ip.dim { opacity: .55; }
/* 套用弹窗的站点勾选列表 */
.pick-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; margin: 4px 0 8px; }
.pick { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); }
.pick .ellipsis { min-width: 0; }
.is-dim { opacity: .55; }
/* 站点表列宽（站点表范式）：域名为唯一弹性列；控件列按实测控件宽定宽 */
col.w-wfname { width: 10%; }
col.w-wfdom { width: auto; }
col.w-wfkind { width: 7%; }
col.w-wfon { width: 64px; }
col.w-wfprof { width: 104px; }
col.w-wfrate { width: 120px; }
col.w-wfburst { width: 120px; }
col.w-wfip { width: 216px; }
col.w-wfacts { width: 130px; }
/* 模板表列宽：名称为弹性列；IP 列等宽；操作列容 3 个文字按钮 */
col.w-tname { width: auto; }
col.w-tprof { width: 80px; }
col.w-trate { width: 96px; }
col.w-tburst { width: 96px; }
col.w-tipa { width: 150px; }
col.w-tipd { width: 150px; }
col.w-tacts { width: 170px; }
/* 操作列下限（审计 U-窄屏）：auto 布局下 col 的 width 只是建议，min-width 须落在 td 上 */
.acts { white-space: nowrap; min-width: 130px; }
/* 拦截告警配置卡 */
.alert-cfg { padding: 0 14px 14px; }
.alert-cfg .err { margin: 4px 0 10px; }
.al-row { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); margin-bottom: 10px; }
.al-fields { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.al-fields .blk { margin: 0; }
.al-fields input[type=number] { width: 130px; }
/* 威胁日志：筛选条 + 说明 + 事件表列宽 */
.evt-filters { display: flex; gap: 8px; align-items: center; padding: 0 14px 10px; flex-wrap: wrap; }
.evt-note { margin: 0; padding: 0 14px 10px; font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.5; }
.evt-more { padding: 4px 14px 12px; }
col.w-ets { width: 150px; }
col.w-etsite { width: 90px; }
col.w-etip { width: 120px; }
col.w-etm { width: 60px; }
col.w-eturi { width: auto; }
col.w-etst { width: 116px; }
col.w-etua { width: 150px; }
</style>

<script setup lang="ts">
/**
 * 站点与 SSL。
 *
 * 设计边界（与后端一致）：
 * - 站点的「定义」(sites 表) 与「下发到 Web 服务器的配置」是两件事。
 * - **建站需要 Web 服务器底座**：未检测到 nginx 时「新建站点」置灰，后端 create
 *   同样返回 501（webserver.manage）——否则只会造出「建好了但永远打不开的
 *   空中楼阁。列表 / 编辑 / 删除 仍只读写数据模型，不依赖底座。
 * - 「应用配置」/「重载」需要 webserver.manage 能力；未检测到时按钮置灰并给出
 *   原因，绝不伪造成功。
 * - 列表「状态」的判据是 `deployed`（配置是否真下发）而非 `enabled`（期望状态）：
 *   新建后 enabled 即为 true，但此刻 Web 服务器里并无此站点，显示「运行中」就是撒谎。
 * - SSL 的 ACME 签发/续期同理受 ssl.acme 能力门禁；证书「删除」是纯数据操作，随时可用。
 * - 站点 WAF 与站点配置**同一次 apply** 下发（它本来就是 nginx 配置的一部分）。
 *   两条与后端严格对齐的语义：`waf` 缺省 = 保留库中现值（不是关闭）、
 *   `rate_per_sec: 0` = 不限速。
 * - SSL 证书管理已并入站点编辑弹窗（与应用站点配置同理）：证书列表 / 签发 / 续期 /
 *   删除 / 自动续期 / 信任根证书，全部在「编辑站点」弹窗内完成，不再另设独立区块。
 *
 * ⚠️ 已知边界（如实写在界面上，不藏着）：`upstreams` / `fpm` 不落库，
 * 所以「编辑」一个反代 / PHP 站时那两个输入框是空的，**必须重填**才能再应用
 * （后端会以 400 拒绝空值，不会静默把站点改成静态）。
 */
import { ref, onMounted, computed } from 'vue'
import { toast } from '@/composables/useToast'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import {
  fmtDateTime, wafProfileLabel,
  type Cert, type RenewSweep, type Site,
} from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ColumnPicker from '@/components/ColumnPicker.vue'
import SiteFormDialog from '@/components/SiteFormDialog.vue'
import SiteSslSection from '@/components/SiteSslSection.vue'
import { SITE_COLS, useSiteColumns } from '@/composables/useSiteColumns'
import { useSiteCaps } from '@/composables/useSiteCaps'
import { fmtApplied, siteState, tlsState } from '@/composables/siteState'

// 列治理抽到 @/composables/useSiteColumns：列定义、显隐的唯一出口、弹性列推导、
// 表格下限宽度与 colspan 是同一件事的五个面——判据分散过（colgroup 按 11 列算、
// CSS 只渲染 7 列 ⇒ 凭空多出 4 个空列、操作列被压到 58px）。这里只消费。
const { narrow, hiddenCols, toggleCol, resetCols, shown, elasticId, tableMinW, colCount } = useSiteColumns()

// 行展开：完整取值（等宽、不截断）
const expanded = ref<number[]>([])
const isExpanded = (id: number) => expanded.value.includes(id)
function toggleExpand(id: number) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((x) => x !== id)
    : [...expanded.value, id]
}
async function copyText(t: string, what: string) {
  try {
    await navigator.clipboard.writeText(t)
    toast(`${what}已复制`)
  } catch {
    // 非安全上下文（http 域名访问）或无剪贴板权限时 clipboard API 会抛——
    // 给一句可操作的提示，别让按钮"点了没反应"
    toast(`复制失败，请手动选中${what}后复制`, 'warn')
  }
}
/** 特性的文字化（图标列收起后仍需知道开了什么）：图标本身不带文字，读屏也读不到 */
function featText(s: Site): string {
  const out: string[] = []
  if (s.auth_basic) out.push('Basic Auth')
  if (s.log_access || s.log_error) out.push('独立日志')
  if ((s.ip_allow ?? []).length) out.push('IP 白名单')
  else if ((s.ip_deny ?? []).length) out.push('IP 黑名单')
  return out.length ? out.join(' · ') : '未启用'
}

// Site / Cert 已移入 src/api/types.ts（跨视图共享类型，避免各存删减副本而漂移）

const sites = ref<Site[]>([])
const certs = ref<Cert[]>([])
const sweep = ref<RenewSweep>({ last_at: 0, last_queued: 0, next_at: 0 })

/**
 * **页面级**错误（列表加载 / 删除站点 / 重载等操作）。
 *
 * ⚠️ 弹窗内的错误一律由 SiteFormDialog 自持（formError / fieldErrs）：此前二者共用一个
 * ref，于是"编辑站点保存失败"会同时点亮页面顶部这条 `<p class="err">`（实机确认），
 * 用户看到消息像是"跑回上级页面的顶部"去了，还得自己把它和弹窗里的红条对上。
 * 唯一的例外：列表行「证书」按钮在弹窗之外直接触发证书操作，那种情况下子组件把
 * 错误通过 `page-error` 交回这里——否则用户点列表的按钮、报错却永远看不见。
 */
const error = ref('')
/**
 * 证书区实例（`:site` 恒为 null 的那份）：列表行「证书」按钮直接调它的签发入口。
 *
 * 为什么不用弹窗里那份：弹窗内的证书区只在 `editing != null` 时渲染，弹窗没开时它
 * 根本不存在——而列表行入口恰恰在弹窗没开时被点。此前这里是一个 `formDlg` 模板 ref
 * 穿透转发给 SiteFormDialog 再转给证书区，两跳都只为了「找一块不在场的组件」。
 */
const rowSsl = ref<InstanceType<typeof SiteSslSection> | null>(null)
const busy = ref(false)
const loading = ref(false)
/** 站点托管根目录（后端只读下发）。目录选择器的初始定位——不可硬编码，config 可覆盖。 */
const siteRoot = ref('')

// 能力 / 权限判定抽到 @/composables/useSiteCaps：列表与站点编辑弹窗问的是同一批问题
// （能不能建站 / 能不能下发 / 能不能签证书 / 重载要不要灰）。两份副本迟早漂移——
// 漂移的表现是「列表里能点、弹窗里却是灰的」，最难查。这里只消费。
const {
  canManage, webSupported, sslReady, sslHint, canReload, canCreate, createHint,
  // 列表行「证书」按钮的入口实例也要这三项（它渲染的浮层要不要选 ACME / 自签）
  canSsl, sslSupported, selfSignedSupported,
} = useSiteCaps()
/**
 * 列表**非静默加载失败**（区别于「真的一个站点都没有」）。
 * 不加这个标志时 `sites` 保持空数组 → 走 EmptyState「暂无站点 · 点新建站点」，
 * 与顶部的错误红字自相矛盾（一边说加载失败、一边说没有数据）。
 */
const loadFailed = ref(false)

async function load(silent = false) {
  if (!silent) { loading.value = true; error.value = ''; loadFailed.value = false }
  try {
    sites.value = (await api.get<Site[]>(API.sites.list())) ?? []
    certs.value = (await api.get<Cert[]>(API.certs.list())) ?? []
    try { sweep.value = await api.get<RenewSweep>(API.certs.renewSweep()) }
    catch { /* 扫描状态缺失不阻断证书列表 */ }
    try { siteRoot.value = (await api.get<{ site_root: string }>(API.sites.root())).site_root }
    catch { /* 旧后端无此端点：选择器降级为默认起始目录，不阻断站点功能 */ }
    if (silent) error.value = '' // 自愈：轮询成功清旧错（站点页不轮询，保留一致语义）
  } catch (e) {
    if (!silent) { error.value = errorText(e); loadFailed.value = true }
  } finally {
    if (!silent) loading.value = false
  }
}
onMounted(load)

/**
 * 列表本地检索：按站点名 / 域名做包含匹配（不区分大小写）。
 * 纯前端过滤、不发请求——站点量级用不到服务端分页，且过滤要即时反馈。
 */
const q = ref('')
const visibleSites = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return sites.value
  return sites.value.filter(s =>
    s.name.toLowerCase().includes(k) || s.domains.some(d => d.toLowerCase().includes(k)))
})

/** 新建 / 编辑弹窗的开关。表单回填不做在这里（见 openEdit）。 */
const modalOpen = ref(false)
const editing = ref<Site | null>(null)
function openCreate() {
  editing.value = null
  modalOpen.value = true
}
/**
 * 打开编辑弹窗。
 *
 * ⚠️ 表单回填**不在这里做**：它归 SiteFormDialog 自持（`watch(() => props.open)`）。
 * 此处调子组件方法是行不通的——DOM 更新是异步的，那一刻子组件还没挂载
 * （SiteConfPanel 踩过一次，表现为第一次打开读不到配置原文）。
 */
function openEdit(s: Site) {
  editing.value = s
  modalOpen.value = true
}

/** 站点类型的中文名（列表与提示共用一份）。 */
function kindLabel(k: string) {
  if (k === 'proxy') return '反向代理'
  if (k === 'php') return 'PHP'
  if (k === 'redirect') return '整站重定向'
  if (k === 'routed') return '多路由'
  return '静态'
}

// ── 删除站点 ──
const delTarget = ref<Site | null>(null)
async function doDelete() {
  if (!delTarget.value) return
  const name = delTarget.value.name
  busy.value = true; error.value = ''
  try {
    await api.del(API.sites.remove(delTarget.value.id))
    delTarget.value = null
    await load()
    toast(`已删除站点 ${name}`)
  } catch (e) {
    // ⚠️ 失败也要关掉确认框：留着它不关、而错误写在页面级（被 .mask 挡住），
    //    用户看到的是"点了删除、对话框卡在那儿没反应"。关掉后错误条才可见。
    delTarget.value = null
    error.value = errorText(e)
  } finally { busy.value = false }
}

// ── 重载（受 webserver 能力门禁）──
/**
 * 正在重载的站点 id。
 * 行内按钮此前只按能力/权限禁用、**完全不反映进行中状态**——点「重载」后界面毫无变化，
 * 连点还会并发触发多次 reload。这里给出 per-row 忙碌态（按钮文案 + 全局 busy 兜底）。
 */
const rowBusyId = ref<number | null>(null)
async function reloadSite(s: Site) {
  busy.value = true; error.value = ''; rowBusyId.value = s.id
  try {
    await api.post(API.sites.reload(s.id), {})
    toast(`已重载 ${s.name}`)
  } catch (e) {
    if (isUnsupported(e)) toast('当前环境未接入 Web 服务器，无法重载配置', 'warn')
    // 写失败必须留在页面上：随后的静默刷新会把 error 清掉（此前失败对用户完全静默）
    else toast(`重载 ${s.name} 失败：${errorText(e)}`, 'err')
  } finally { rowBusyId.value = null; busy.value = false; await load(true) }
}

// ── 列表批量操作（评估 G3：批量启用 / 停用 / 删除）──
const selected = ref<number[]>([])
// 表头全选与当前过滤结果（visibleSites）联动；改搜索词只影响可见项
const allSelected = computed<boolean>({
  get: () => visibleSites.value.length > 0 && visibleSites.value.every(s => selected.value.includes(s.id)),
  set: (v) => { selected.value = v ? visibleSites.value.map(s => s.id) : [] },
})
function toggleSelect(id: number) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
const batchBusy = ref(false)
const batchDelOpen = ref(false)

// 逐站 PATCH {enabled}；用 allSettled 不因单个失败中断其余，最后给汇总 toast
async function batchSetEnabled(on: boolean) {
  if (!selected.value.length) return
  batchBusy.value = true
  try {
    const ids = [...selected.value]
    const res = await Promise.allSettled(ids.map(id => api.patch(API.sites.patch(id), { enabled: on })))
    const ok = res.filter(r => r.status === 'fulfilled').length
    const fail = res.length - ok
    toast(fail ? `已${on ? '启用' : '停用'} ${ok} 个站点，${fail} 个失败` : `已${on ? '启用' : '停用'} ${ok} 个站点`)
    selected.value = []
    await load()
  } catch { /* Promise.allSettled 不抛，仅作兜底层 */ }
  finally { batchBusy.value = false }
}

function askBatchDelete() { if (selected.value.length) batchDelOpen.value = true }

async function batchDelete() {
  if (!selected.value.length) return
  batchBusy.value = true
  try {
    const ids = [...selected.value]
    const res = await Promise.allSettled(ids.map(id => api.del(API.sites.remove(id))))
    const ok = res.filter(r => r.status === 'fulfilled').length
    const fail = res.length - ok
    toast(fail ? `已删除 ${ok} 个站点，${fail} 个失败` : `已删除 ${ok} 个站点`)
    batchDelOpen.value = false
    selected.value = []
    await load()
  } catch { /* 同上 */ }
  finally { batchBusy.value = false }
}
</script>

<template>
  <div>
    <!-- 页面级错误也用公共 .err-bar（红底 + 图标），不再是无图标的裸红字——
         与弹窗内的错误条保持同一长相。 -->
    <p v-if="error" class="err-bar page-err" role="alert">
      <Icon name="alert" :size="15" class="ic" /><span>{{ error }}</span>
    </p>

    <!-- 与弹窗内同类警示统一走公共 .hint-note.is-warn：此前本页私有的 .tip.warn
         是另一套长相（无圆角内边距由各处自造），同一语义两种外观。 -->
    <p v-if="!webSupported" class="hint-note is-warn">
      <Icon name="alert" :size="15" class="ic" />
      <span>未检测到 Web 服务器（nginx / caddy）：<b>无法新建站点</b>。没有底座时建站只会得到一个打不开的站点，
        请先在主机上安装并启动其一，再回到此页刷新。</span>
    </p>

    <!-- 站点列表。刷新与新建收进本区块头：它们是「对这张表」的动作，紧贴其操作对象
         （与 ProcessesView 把工具条收进卡片顶栏同范式）。此前二者悬在页面级 page-head，
         与真正作用的列表隔了一层，页面顶部还为它们白占一行。
         刷新是通用工具动作，用 ghost；橙色实心只留给本页唯一主操作「新建站点」。 -->
    <div v-if="loading && !sites.length" class="skeleton shimmer box" />
    <div v-else-if="sites.length" class="card flush toolbar-card">
      <!-- 页级筛选与动作收进卡顶栏：它们过滤 / 操作的就是这张表；原先单独占一条
           页面级横条时，横条本身比「搜索框」这个内容还重。 -->
      <div class="card-toolbar">
        <span class="count">共 {{ sites.length }} 个站点</span>
        <!-- 本地检索：站点一多就只能肉眼扫表，加一个按名称/域名过滤的框成本最低；
             count 领队、搜索框紧邻其后（"过滤这 N 个"语义自然），操作簇统一靠右 -->
        <input v-model="q" class="site-search" type="search" placeholder="搜索名称或域名…" aria-label="搜索站点" />
        <span class="spacer" />
        <!-- A3 列显隐：10 列塞不进内容区，默认收起 4 个次要列（完整取值走行展开）。
             偏好记在本机（useTableCols），不同账号/不同机器互不影响——它是"我这台设备
             怎么看"，不是面板级共享配置，故不占用后端 settings。
             进卡后 sites.length 已由卡片保证，只剩窄屏这一处不出入口：此时次要列由 JS
             统一强制隐藏（见 NARROW_HIDDEN），勾选框会呈现"勾了也不生效"的假象。 -->
        <ColumnPicker v-if="!narrow" :cols="SITE_COLS" :hidden="hiddenCols" label="站点列表"
          @toggle="toggleCol" @reset="resetCols" />
        <RefreshBtn :disabled="busy" sm @click="load()" />
        <button class="btn-primary btn-sm" :disabled="!canCreate || busy" :title="createHint" @click="openCreate">
          <Icon name="plus" :size="13" /> 新建站点
        </button>
      </div>
      <!-- 下限宽度只给 fixed 布局：窄屏（<=720px）main.css 会把 table-layout 转成 auto，
           让浏览器按内容分配；此时再压一个 908px 的下限会把 436px 的容器撑出两倍滚动条
           （实测表宽 612 → 908），故窄屏直接撤掉。 -->
      <!-- 横滚只发生在表格上：卡片已改 overflow:hidden，否则窄屏横滚会把工具条一起带走 -->
      <div class="t-scroll">
      <table class="fixed" aria-label="站点列表"
        :style="narrow ? undefined : { minWidth: tableMinW + 'px' }" v-table-nav>
        <!-- 站点表列宽独立于证书表：两表的内容分布完全不同（站点表 4 个操作按钮、
             根目录是长路径；证书表 2 个按钮、签发者是长文本），共用一套宽度必然顾此失彼。
             故两表各持一套 class——站点表 w-name/w-sdom/…/w-sacts，
             证书表 w-dom/w-iss/…/w-cst/w-acts（含同为「状态」列的 w-cst），互不影响。 -->
        <!-- A3：列可显隐。colgroup 与 SITE_COLS 同序遍历，`<col>` 只跟 shown() 同步——
             列数必须与渲染出的 th/td 完全一致，少一个就会整表错位（fixed 布局按序分发宽度）。
             宽度由 SITE_COLS 的 `w` 直接给（inline style）：**不写进 CSS**，否则同一份
             列宽在 JS 与 CSS 各存一套，改一处漏一处必然漂移。
             唯一弹性列由 elasticId 决定，取 auto 吃掉剩余宽度。 -->
        <colgroup>
          <col class="w-sel" />
          <!-- 数据列不给 class：宽度已在 inline style 里。曾经的 w-sdom/w-st/… 若留着，
               读者 grep 不到对应 CSS 会以为是死代码；而证书表恰好也有 w-dom（24%），
               同名会让"这一列到底多宽"要翻两处才能回答。 -->
          <template v-for="c in SITE_COLS" :key="c.id">
            <col v-if="shown(c.id)"
              :style="c.id === elasticId
                ? { width: 'auto' }
                : { width: c.w + 'px', ...(c.align ? { textAlign: c.align } : {}) }" />
          </template>
          <col class="w-sacts" />
        </colgroup>
        <!-- scope="col" 让读屏把列含义与单元格关联（审计 A3）；.col-opt 标记「次要列」，
             窄屏（<=720px）由 main.css 公共规则隐藏。 -->
        <thead><tr>
          <th scope="col" class="col-sel"><input type="checkbox" :checked="allSelected"
            @change="allSelected = ($event.target as HTMLInputElement).checked"
            :disabled="!visibleSites.length" aria-label="全选站点" /></th>
          <th v-if="shown('name')" scope="col">名称</th>
          <th v-if="shown('dom')" scope="col">域名</th>
          <th v-if="shown('root')" scope="col" class="col-opt">根目录</th>
          <th v-if="shown('kind')" scope="col" class="col-opt">类型</th>
          <th v-if="shown('feat')" scope="col" class="col-opt">特性</th>
          <th v-if="shown('waf')" scope="col">WAF</th>
          <th v-if="shown('state')" scope="col">状态</th>
          <th v-if="shown('applied')" scope="col" class="col-opt">上次下发</th>
          <th v-if="shown('tls')" scope="col">TLS</th>
          <th scope="col">操作</th>
        </tr></thead>
        <tbody>
          <!-- 过滤无结果 ≠ 没有站点：单列一行说明，避免落到「暂无站点」空态造成误判 -->
          <tr v-if="!visibleSites.length">
            <!-- colspan 必须按**实际渲染列数**算：用户收起列之后写死 11 会错位 -->
            <td :colspan="colCount" class="dim">没有匹配「{{ q }}」的站点</td>
          </tr>
          <!-- 用 <template v-for> 包住「主行 + 展开行」：展开行是同一站点的兄弟 <tr>，
               塞进 <tr v-for> 内部不合法（tr 里不能套 tr）。 -->
          <template v-for="s in visibleSites" :key="s.id">
          <tr>
            <td class="col-sel"><input type="checkbox" :checked="selected.includes(s.id)"
              @change="toggleSelect(s.id)" :disabled="!canManage"
              :title="canManage ? '选择此站点' : '无管理权限'" aria-label="选择站点" /></td>
            <!-- 名称列挂展开开关（A3）：被收起的次要列在这行里给出**完整不截断**的取值 -->
            <td v-if="shown('name')" class="name-cell">
              <button class="exp" type="button" :class="{ on: isExpanded(s.id) }"
                :aria-expanded="isExpanded(s.id)"
                :title="isExpanded(s.id) ? '收起详情' : '展开完整信息（根目录 / 全部域名 / 类型 / 特性 / 上次下发）'"
                @click="toggleExpand(s.id)"><Icon name="chevron" :size="12" /></button>
              <span class="nm" :title="s.name">{{ s.name }}</span>
            </td>
            <!-- 多域名：只列第一个 + 「+N」，完整列表走 title——否则 15% 列宽下
                 后半段被截掉，用户不知道到底配了几个域名。 -->
            <td v-if="shown('dom')" class="ellipsis" :title="s.domains.join(', ')">{{ s.domains[0] ?? '—' }}<span
              v-if="s.domains.length > 1" class="dim tiny"> +{{ s.domains.length - 1 }}</span></td>
            <td v-if="shown('root')" class="mono dim ellipsis col-opt" :title="s.root">{{ s.root }}</td>
            <td v-if="shown('kind')" class="col-opt">{{ kindLabel(s.kind) }}</td>
            <!-- 特性（021）：访问控制 / 独立日志此前只能逐个点开编辑才知道，列表里一眼看不到 -->
            <td v-if="shown('feat')" class="col-opt feat-cell">
              <span v-if="s.auth_basic" class="feat" title="已启用 Basic Auth（HTTP 基础认证）"><Icon name="key" :size="13" /></span>
              <span v-if="s.log_access || s.log_error" class="feat"
                :title="`已开启独立站点日志（${[s.log_access ? 'access' : '', s.log_error ? 'error' : ''].filter(Boolean).join(' / ')}）`"><Icon name="file" :size="13" /></span>
              <span v-if="(s.ip_allow ?? []).length || (s.ip_deny ?? []).length" class="feat"
                :title="(s.ip_allow ?? []).length ? '已启用 IP 白名单' : '已启用 IP 黑名单'"><Icon name="shield" :size="13" /></span>
              <span v-if="!s.auth_basic && !s.log_access && !s.log_error
                && !(s.ip_allow ?? []).length && !(s.ip_deny ?? []).length" class="dim">—</span>
            </td>
            <td v-if="shown('waf')">
              <template v-if="s.waf_enabled">
                <span class="badge badge-ok">{{ wafProfileLabel(s.waf_profile ?? 'basic') }}</span>
                <span v-if="s.waf_rate_per_sec" class="dim tiny">· {{ s.waf_rate_per_sec }}/s</span>
              </template>
              <span v-else class="dim">—</span>
            </td>
            <!-- .st-cell：单格最多 3 个徽章（状态 + 未同步 + 外部改动），6% 列宽放不下会
                 参差不齐地换行；改 flex 换行并给列加下限，行高才稳定。 -->
            <td v-if="shown('state')" class="st-cell">
              <span class="badge" :class="siteState(s).cls" :title="siteState(s).title">{{ siteState(s).label }}</span>
              <!-- 手动维护 / 未同步两态共用一个徽标：未同步（表单改了但配置没跟上）用红色——
                   「面板所见 ≠ 实际生效」必须一眼可见（as11 分叉事故的直接修复项）。 -->
              <span v-if="s.manual_conf" class="badge conf-badge" :class="s.conf_stale ? 'badge-danger' : 'badge-warn'"
                :title="s.conf_stale
                  ? '未同步：表单规格已变更，但磁盘配置没有跟着更新——面板显示 ≠ 实际生效；编辑该站点可「按表单重新生成」同步'
                  : '站点配置处于「手动维护」：表单「保存并应用」不再覆盖磁盘上的配置文件（编辑弹窗内可「按表单重新生成」）'">
                {{ s.conf_stale ? '未同步' : '手动' }}</span>
              <span v-if="s.conf_external" class="badge conf-badge badge-warn"
                title="外部修改：磁盘上的配置文件与最后一次落盘的内容不一致——文件在面板之外被改动过（脚本误写 / 人工手改）。面板不会静默覆盖它，可在编辑弹窗内「按表单重新生成」或改写为自定义片段">外部改动</span>
            </td>
            <!-- 上次下发（023）：「这个站多久没管了」此前只能翻日志。null = 从未成功
                 下发过——与 0（1970）语义相反，不能把 NULL 格式化成 1970 谎报下发。
                 单元格只到分（无年份），完整时间走 title；窄屏随 col-opt 隐藏。 -->
            <td v-if="shown('applied')" class="mono dim col-opt"
              :title="s.last_applied_at ? `上次下发：${fmtDateTime(s.last_applied_at)}` : '从未下发过：尚无「配置写入磁盘且重载成功」的记录'">{{ fmtApplied(s.last_applied_at) }}</td>
            <td v-if="shown('tls')"><span class="badge" :class="tlsState(s).cls" :title="tlsState(s).title">{{ tlsState(s).label }}</span></td>
            <!-- 操作列补常驻文字（审计 U2）：纯图标靠 hover title 才能辨认，触屏无 hover、
                 新手也分不清哪个是删除。列宽 w-sacts 19% 本就是按「4 个带文字按钮」实测的。
                 文字装在 .btn-label 里：窄屏（<=720px）由 main.css 收起只留图标，
                 否则 4 个按钮在窄列里会竖着堆成 4 行（实测行高 247px）。 -->
            <td class="actions">
              <button class="btn-ghost btn-sm" :disabled="!canManage || busy" title="编辑" @click="openEdit(s)"><Icon name="edit" :size="13" /><span class="btn-label">编辑</span></button>
              <button class="btn-ghost btn-sm" :disabled="!canReload || busy" :title="canReload ? '按磁盘上现有配置重载 Web 服务器（不重新渲染，改配置请用「编辑」）' : '需 Web 服务器'" @click="reloadSite(s)"><Icon name="refresh" :size="13" /><span class="btn-label">{{ rowBusyId === s.id ? '重载中…' : '重载' }}</span></button>
              <button class="btn-ghost btn-sm" :disabled="!sslReady || busy" :title="sslReady ? '为该站点申请 / 续签证书' : sslHint" @click="rowSsl?.applySsl(s)"><Icon name="lock" :size="13" /><span class="btn-label">证书</span></button>
              <button class="btn-ghost btn-sm danger" :disabled="!canManage || busy" title="删除" @click="delTarget = s"><Icon name="trash" :size="13" /><span class="btn-label">删除</span></button>
            </td>
          </tr>

          <!-- 行展开（A3）：收起或截断掉的取值在这里给出**完整原文**。
               根目录用等宽 + 可复制——报告点名它此前被截成 `/home/…`，而它是
               "这个站的文件到底在哪"的唯一线索，只靠 title 悬停远远不够。 -->
          <tr v-if="isExpanded(s.id)" class="detail-row">
            <td :colspan="colCount">
              <div class="detail">
                <div class="d-item">
                  <span class="d-k">根目录</span>
                  <code class="d-v mono">{{ s.root }}</code>
                  <button class="btn-ghost btn-sm" @click="copyText(s.root, '根目录')">复制</button>
                </div>
                <div class="d-item">
                  <span class="d-k">域名</span>
                  <code class="d-v mono">{{ s.domains.length ? s.domains.join('  ') : '—' }}</code>
                  <button v-if="s.domains.length" class="btn-ghost btn-sm"
                    @click="copyText(s.domains.join(','), '域名')">复制</button>
                </div>
                <div class="d-item"><span class="d-k">类型</span><span class="d-v">{{ kindLabel(s.kind) }}</span></div>
                <div class="d-item"><span class="d-k">特性</span><span class="d-v">{{ featText(s) }}</span></div>
                <div class="d-item">
                  <span class="d-k">上次下发</span>
                  <span class="d-v">{{ s.last_applied_at ? fmtDateTime(s.last_applied_at) : '从未下发过' }}</span>
                </div>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
      </div>
      <div class="batch-bar" v-if="selected.length">
        <span class="batch-count">已选 {{ selected.length }} 项</span>
        <span class="spacer" />
        <button class="btn-ghost btn-sm" :disabled="!canManage || batchBusy" @click="batchSetEnabled(true)">启用</button>
        <button class="btn-ghost btn-sm" :disabled="!canManage || batchBusy" @click="batchSetEnabled(false)">停用</button>
        <button class="btn-ghost btn-sm danger" :disabled="!canManage || batchBusy" @click="askBatchDelete">删除</button>
        <button class="btn-ghost btn-sm" :disabled="batchBusy" @click="selected = []">取消选择</button>
      </div>
    </div>
    <!-- 加载失败 ≠ 没有数据：sites 保持空数组时若一律走「暂无站点」，会与顶部错误红字
         自相矛盾（一边说失败、一边说没有）。空态文案也要跟着 canCreate 走——未接入
         底座时「新建站点」是禁用态，还让人去点它就是误导。 -->
    <!-- 「刷新 / 新建站点」已随工具条收进列表卡顶栏，而这两个空态下卡片并不渲染——
         所以空态必须自带 CTA：否则加载失败时既没有表也没有重试入口，用户被卡死。 -->
    <EmptyState v-else-if="loadFailed" title="站点列表加载失败" hint="请确认后端服务正常后重试"
      :reason="error || undefined">
      <template #cta>
        <button class="btn-primary btn-sm" :disabled="busy" @click="load()">
          <Icon name="refresh" :size="13" /> 重试
        </button>
      </template>
    </EmptyState>
    <EmptyState v-else title="暂无站点"
      :hint="canCreate ? '添加第一个虚拟主机：面板会生成站点配置并按需签发证书' : '当前未接入 Web 服务器（nginx / caddy）：需先安装并启动，才能新建站点'">
      <template #cta>
        <button v-if="canCreate" class="btn-primary btn-sm" :disabled="!canCreate || busy" @click="openCreate">
          <Icon name="plus" :size="13" /> 新建站点
        </button>
      </template>
    </EmptyState>


    <!-- 新建 / 编辑弹窗（含 SSL 证书区与站点日志区）：表单回填 / 校验 / 保存下发 /
         配置原文全部自持，父级只给「作用在哪个站点」与它不掌握的只读数据（证书列表、
         续期扫描状态、站点根目录）。 -->
    <SiteFormDialog v-model:open="modalOpen" :site="editing"
      :certs="certs" :sweep="sweep" :site-root="siteRoot"
      @reload="load" @page-error="(m: string) => error = m" />

    <!-- 列表行「证书」按钮的入口实例：与弹窗内那份**同一个组件、同一套浮层**，只是
         `:site` 恒为 null ⇒ 区块本体（`.ssl`）不渲染，留在页面上的只有它的
         <SiteSslDialog> 浮层。这样列表入口不必穿透 SiteFormDialog 转发，而弹窗那份
         也不必在 `open=false` 时替父级兜底（两种入口的错误落点本来就不同：
         列表行没有弹窗可写，只能写页面级）。
         ⚠️ 两处都用同一个 `rowSsl` ref：同一时刻列表行只点一行，不会有两张浮层。 -->
    <SiteSslSection ref="rowSsl" :site="null" :certs="certs" :sweep="sweep"
      :busy="busy" :can-ssl="canSsl" :ssl-supported="sslSupported"
      :self-signed-supported="selfSignedSupported" :ssl-ready="sslReady" :ssl-hint="sslHint"
      @reload="load" @update:busy="(v) => busy = v"
      @ssl-error="(m: string) => error = m" />
    <ConfirmDialog :open="!!delTarget" danger title="删除站点"
      :detail="delTarget ? `将删除站点「${delTarget.name}」及其关联证书，且无法恢复。\n\n站点目录 ${delTarget.root} 的文件不会被删除（如需清理请到「文件」页手动删除）。` : ''"
      confirm-word="删除" @confirm="doDelete" @cancel="delTarget = null" />

    <ConfirmDialog :open="batchDelOpen" danger title="批量删除站点"
      :detail="`将删除已选的 ${selected.length} 个站点及其关联证书，且无法恢复。此操作不可撤销。`"
      confirm-word="删除" @confirm="batchDelete" @cancel="batchDelOpen = false" />
  </div>
</template>

<style scoped>
/* 「横幅」语言（与 WafView / LoginView 的 .notice / .warn 同一套）：
   内边距 + 圆角 + 描边，颜色一律走主题变量。
   此前 .notice 硬编码绿色、.tip.warn 硬编码暗琥珀，亮色主题下不随 --c-ok / --c-warn
   切换；.tip.warn 更只覆写了 color/background/border-color 三项，而 .tip 自身
   padding/border-width/border-radius 全为 0，于是「警示条」实测渲染成
   padding:0 / border:0 / radius:0、高仅 19px 的一条裸色带，且 margin:0 导致它
   与下方卡片严丝合缝贴合（实测 0px），文字还顶到内容区左边缘。 */
/* （.tip.warn 已删除：本页那处「未检测到 nginx」警示已改用公共 .hint-note.is-warn，
   留着这套私有警告样式只会让同一语义出现两种长相。） */
.actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* 「启用」开关的后果说明：停用是**真停用**（摘配置 + reload），必须让用户看见代价。
   原 .hint-line（12px + --c-text-mute）太小太淡、又用负 margin 紧贴勾选框，读起来像
   "被禁用的残留文字"；改为带 info 图标的信息条：13px + --c-text-dim，柔和底 +
   左侧主色描边，与勾选框拉开间距。编辑态（真停用后果）转琥珀色强调。 */
/* ⚠️ .hint-note 已提到 main.css 公共规则。此前本页私有副本的特异性
   （.hint-note[data-v-*] = 0,2,0）高于公共（0,1,0）会**静默压掉**公共定义，
   导致别的视图用同一类名时拿不到样式——留着它就是埋雷，故删除。 */

/* 自动续期开关：与 ServiceDetailView 的开机自启开关同款——实心主色底 + 白滑块、42×24。
   旧版是 --c-primary-soft 浅色底 + 主色滑块，开销/关都偏「浅橙」，用户反馈看不出选中。
   CronView 同步升级，三处一套。 */

/* 站点原始配置区块：与 SSL 区块同范式（虚线分隔，同为「既有站点专属」区块）。
   原文用等宽字体承载；nginx -t 的原始输出按**原样换行**展示（pre-wrap）。 */
/* （.conf-text 已删除：该 class 落在 NginxEditor 的**根容器**上，resize 无效、
   min-height 作用在 wrapper 而非 textarea，字号行高也与组件内部重复定义。
   高度、等宽字体、滚动条槽位统一由 NginxEditor 自己负责。） */
/* 未同步警示条：.conf 是 grid（gap 管间距），归零外边距防止双重留白 */

/* 外部修改警示条：与 .conf-stale 同款（.conf 是 grid，归零外边距防双重留白） */

/* 历史版本与回滚（018）：列表行 = 元信息 + 操作两列；正文展开为 pre-wrap 等宽块，
   展开行整幅跨列（不挤在 auto 列里）。 */

/* 显式列宽（与服务/进程页统一范式）：table-layout:fixed + colgroup 宽度，
   长域名/根目录/签发者 ellipsis 截断、完整值走 title 悬停。
   两表宽度完全独立（各自一套 class），改一张绝不会波及另一张。 */
table.fixed { table-layout: fixed; width: 100%; }
table.fixed th, table.fixed td { overflow: hidden; }
/* 站点表：短内容列给「够用即止」的宽度，剩余宽度全部让给唯一弹性列「根目录」。
   若按百分比均摊，宽屏下多出的空间会平摊到每一列白占——正是「该宽的没宽、该窄的没窄」。
   下列百分比按**最长取值 + 单元格内边距 26px** 用 canvas 按真实字体实测反推
   （@1920 / 表宽 1640 / 正文 13.5px / 徽章 12px / 等宽 13.5px）：
     名称 94 ／ 域名两条 226 ／ 类型「反向代理」80 ／ WAF「basic · 10/s」112 ／
     状态 82 ／ TLS「已签发·未生效」122 ／ 操作 4 个带文字按钮 309 ／ 根目录 68 字符 465。
   合计 1490 < 1640，故 1920 下各列均不裁剪，余量（约 150px）全部落给根目录（弹性列）。 */
/* ── A3 名称列与行展开 ── */
/* 名称列：展开按钮 + 可截断的站点名。用 flex 而非让 td 直接 ellipsis——
   td 里放了按钮，纯 text-overflow 会把按钮一起算进溢出区域而挤掉图标。 */
.name-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name-cell .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exp { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; border: none; border-radius: 6px;
  background: none; color: var(--c-text-dim); cursor: pointer;
  transition: transform .15s ease, color .12s ease, background .12s ease; }
.exp:hover { color: var(--c-primary); background: var(--c-primary-soft); }
/* 展开态箭头转 90°，与「收起/展开」的语义一致（同侧边栏折叠开关的旋转约定） */
.exp.on { transform: rotate(90deg); color: var(--c-primary); }

/* 展开行：不抢主行的视觉重量——左侧一条品牌色竖线 + 更暗的底，
   表明它是"这一行的补充说明"而不是新的一行数据。 */
.detail-row > td { padding: 0 13px 10px; background: var(--bg-inset); }
.detail-row:hover > td { background: var(--bg-inset); }
.detail { display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 10px 12px 10px 36px;
  border-left: 2px solid var(--c-primary); }
.d-item { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-13); }
.d-k { flex: none; color: var(--c-text-dim); font-size: var(--fs-12); }
/* 完整取值：等宽 + 允许换行（这里就是要看全，不做截断） */
.d-v { min-width: 0; word-break: break-all; color: var(--c-text); }

/* 站点表的列宽**不在这里**：统一由脚本里的 SITE_COLS[].w 通过 <col> 的 inline style 下发
   （单一来源，见该数组的注释）。这里只留两张「响应式/固定」列：

   ⚠️ 曾经这里写的是百分比（w-name 7% / w-sdom 15% / w-waf 8% …），有两个必然的坏结果：
   ① 百分比随表宽缩放——1440（表宽 1160）下名称 7% 只有 81px，扣掉展开按钮 20 + 间距 6
      + 内边距 26 后站名只剩 29px，实测被截成「ex…」；② 用户把列全打开时，所有百分比列
      一起放大，把唯一弹性列（根目录）压到 **9px**——连表头都看不见。
   现在非弹性列一律实测 px，余量全部给弹性列；装不下就让表格横向滚动（tableMinW）。 */

col.w-sacts { width: 320px; }  /* 4 个带文字按钮并排：各 67px + 3×6 间距 = 286，加单元格左右内边距 26
                                  = 312；取 320 留 8px 余量。⚠️ 内边距要从里面扣——写 310 时内容区只有
                                  284px，仍差 2px，第 4 个按钮照样掉到第二行（实测行高 91px）。
                                  ⚠️ 320px 按 1920 表宽实测；<1800px 收纯图标见下方 @media。 */
/* 中宽屏动作列收纯图标：
   1×40(sel) + 1×320(sacts 带文字) + 其余固定列，在 <1800px 会超过表宽——动作列收成纯图标
   后只需 4×29 + 3×6 间距 + 单元格内边距 34 = 168px（与 <=720 全局规则同规格，main.css 实测值），
   省出的 152px 还给弹性列，多数窗口下就不必横向滚动了。
   ⚠️ 脚本里的 ACTS_W 常量必须与此处的 168 保持一致（它参与 tableMinW 计算）。
   按钮可辨识性由 title / aria-label 保留（<=720 本就只显图标）。 */
@media (max-width: 1799px) {
  col.w-sacts { width: 168px; }
  .actions .btn-label { display: none; }
  .actions .btn-sm { padding: 4px 7px; }
}
/* 站点表首屏占位高度：10 列表格，300px ≈ 表头 + 8 行骨架的观感
   （骨架本体走公共 .skeleton.shimmer，见 main.css） */
.box { height: 300px; }

/* ══ UX 审计整改（2026-10-11）新增样式 ══ */
/* 页头检索框：与工具按钮同高，窄屏下不跟标题抢空间 */
.site-search { width: min(220px, 40vw); padding: 5px 10px; font-size: var(--fs-13); }
/* 状态列：单格最多 3 个徽章，改可换行的 flex 行——行高稳定，不再参差 */
.st-cell { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
/* 特性列（021）：图标徽章，含义走 title 悬停 */
.feat-cell { display: flex; align-items: center; gap: 6px; }
.feat { display: inline-flex; color: var(--c-primary); }
/* 配置区读取失败条：要塞一个「重试」按钮（.err-bar 是 flex，单独排布） */
/* 只读原因条：紧贴编辑器上方，收掉 .hint-note 默认下边距避免与编辑器拉开距离 */
/* 页面级错误条也走公共 .err-bar：此前是裸红字无图标，与弹窗内的 .err-bar 两种长相 */
.page-err { margin: 0 0 12px; }
/* ── 列表批量操作（G3）── */
col.w-sel { width: 40px; }
.col-sel { text-align: center; width: 40px; padding-left: 0; padding-right: 0; }
.col-sel input { width: auto; vertical-align: middle; cursor: pointer; }
.batch-bar { display: flex; align-items: center; gap: 8px; padding: 10px 4px; border-top: 1px solid var(--c-border); margin-top: 4px; flex-wrap: wrap; }
.batch-count { font-size: var(--fs-13); color: var(--c-text-dim); }
.batch-bar .spacer { flex: 1; }
</style>

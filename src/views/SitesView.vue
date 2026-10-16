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
import { ref, onMounted, computed, nextTick, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { api, errorText, errorFieldDetail, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, certRenewStateLabel, certSourceLabel, fmtDate, fmtDateTime, wafProfileLabel, type Cert, type ConfVersion, type ConfVersionDetail, type PackageInfo, type Site, type SiteRoute } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DirectoryPickerDialog from '@/components/DirectoryPickerDialog.vue'
import NginxEditor from '@/components/NginxEditor.vue'
import ColumnPicker from '@/components/ColumnPicker.vue'
import { useNarrow, useTableCols } from '@/composables/useTablePrefs'

// ── A3 列治理：10 列挤在内容区 → 主表 6 列 + 行展开 ──
// 默认收起 4 个次要列（根目录 / 类型 / 特性 / 上次下发），主表只剩
// 「站点 / 域名 / WAF / 状态 / TLS / 操作」（外加选择列）。想要的列可在「列」里
// 勾回来（记在本机，下次仍有效）。
// ⭐收起的列**不会丢信息**：根目录此前被截成 `/home/…` 正是报告点名的痛点，
//   收起后它的完整取值在**行展开**里以等宽文本呈现并可一键复制——比
//   "在窄列里截断 + 靠 title 悬停"可靠得多。
const SITE_COLS: { id: string; label: string; w: number; locked?: boolean; align?: 'left' | 'right' | 'center' }[] = [
  // 名称是这张表的**身份列**：没有它，"站点列表"就只剩一堆域名和按钮。
  // 且它同时是弹性列的兜底（见 elasticId）——允许隐藏会让整表既无身份列、
  // 又无弹性列（余量被平摊成空转留白），故标记为不可隐藏。
  { id: 'name', label: '名称', w: 200, locked: true },
  { id: 'dom', label: '域名', w: 180 },
  { id: 'root', label: '根目录', w: 220 }, // 弹性列：这个值只是它的**下限**
  { id: 'kind', label: '类型', w: 64 },
  { id: 'feat', label: '特性', w: 84 },
  { id: 'waf', label: 'WAF', w: 116 },
  { id: 'state', label: '状态', w: 120 },
  { id: 'applied', label: '上次下发', w: 108, align: 'right' }, // 日期右对齐，便于纵向比对（B9 列类型/对齐规范：数字/日期/字节列 right，文本与徽标 left）
  { id: 'tls', label: 'TLS', w: 84 },
]
// 解构成顶层 ref：模板里 `cols.hidden` 拿到的是 Ref 对象（只有 setup 顶层的 ref
// 才会自动解包），故必须拆出来用
const { hidden: hiddenCols, shown: rawShown, toggle: toggleCol, reset: resetCols } =
  useTableCols('sites.main', ['root', 'kind', 'feat', 'applied'])

/** 锁定列（名称）不受偏好影响：本机 localStorage 里若存着脏值（手改 / 旧版本写坏），
 *  仅靠选择器把勾选框置灰挡不住——必须在这里兜住，否则渲染层会真的把它藏掉。 */
const LOCKED_IDS = SITE_COLS.filter((c) => c.locked).map((c) => c.id)

/** 窄屏隐藏的次要列：与 main.css 里 `.col-opt` 的标记一致。
 *  ⚠️ 由 JS 判而不是只交给 CSS：colgroup 列数 / 行展开的 colspan 都得跟着少这 4 列，
 *  只靠 CSS 隐藏时 JS 仍按 11 列算——实测（480px + 全列开启）表格凭空多出 4 个空列、
 *  操作列被压到 58px、展开行错位。 */
const NARROW_HIDDEN = ['root', 'kind', 'feat', 'applied']

const narrow = useNarrow()

/** 「这一列现在渲染吗」的唯一出口：锁定列恒真，其余看偏好，窄屏再砍掉次要列。 */
const shown = (id: string) =>
  LOCKED_IDS.includes(id) || (!(narrow.value && NARROW_HIDDEN.includes(id)) && rawShown(id))

/** 唯一弹性列：`table-layout:fixed` 下若所有列都有固定宽度，多出来的宽度会被**平摊
 *  到每一列**变成空转留白（此前踩过）。根目录是首选弹性列；它被隐藏时让域名吃余量，
 *  再退到名称（名称恒可见，故兜底一定成立）。
 *  ⚠️ 弹性列**不能靠 min-width 兜底**：实测 `col` 与 `th` 上的 min-width 在
 *  `table-layout:fixed` 下都被忽略（三态量出来都是 9px）。真正管用的是给 `<table>`
 *  一个下限宽度（见 tableMinW）——它小于内容时表格横向滚动，弹性列就不会被压成 0。 */
const elasticId = computed(() => ['root', 'dom', 'name'].find((id) => shown(id)) ?? null)

/** 表格下限宽度 = 勾选列宽之和 + 选择列 + 操作列。
 *  低于它就让表格横向滚动（容器 .card.flush 自带 overflow-x:auto）——
 *  11 列在 1160px 表宽里本来就不可能都可读，硬挤的结果是某列被压到 0。 */
const SEL_W = 40
/** 与 main.css `@media (max-width:1799px) { col.w-sacts }` 一致；≥1800 时容器够宽，
 *  下限根本用不上，故这里恒取窄档值即可，不必把断点也复制到 JS。 */
const ACTS_W = 168
const tableMinW = computed(
  () => SEL_W + ACTS_W + SITE_COLS.filter((c) => shown(c.id)).reduce((s, c) => s + c.w, 0),
)
/** 行展开 / 空态行的 colspan：必须等于**实际渲染的列数**（含选择列与操作列），
 *  写死 11 会在用户收起列之后错位。 */
const colCount = computed(() => 2 + SITE_COLS.filter((c) => shown(c.id)).length)

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

const auth = useAuthStore()
const sites = ref<Site[]>([])
const certs = ref<Cert[]>([])
interface RenewSweep { last_at: number; last_queued: number; next_at: number }
const sweep = ref<RenewSweep>({ last_at: 0, last_queued: 0, next_at: 0 })
/**
 * **页面级**错误（列表加载 / 删除站点 / 重载等非弹窗操作）。
 *
 * ⚠ 弹窗表单的错误**一律不走这里**，而走 formError / fieldErrs：此前二者共用一个
 * ref，于是"编辑站点保存失败"会同时点亮页面顶部那条 `<p class="err">`（实机确认），
 * 用户看到消息像是"跑回上级页面的顶部"去了，还得自己把它和弹窗里的红条对上。
 */
const error = ref('')
/** 弹窗内的**非字段**错误（网络失败 / 服务端异常等，归属不到某个输入框）。 */
const formError = ref('')
/** 弹窗内的**字段级**错误：键 = 表单字段名，值 = 给用户看的中文说明。 */
const fieldErrs = ref<Record<string, string>>({})
/**
 * 错误序号：每次保存失败自增，用作错误条的 `:key`。
 * 元素因此被重建，「抖动」动画才能**重复播放**——否则同一文案下 v-if 恒为 true、
 * 元素不重建，动画只播一次，用户连点「保存」得不到任何新反馈（正是要修的场景）。
 */
const errSeq = ref(0)
const busy = ref(false)
const loading = ref(false)
/** 站点托管根目录（后端只读下发）。目录选择器的初始定位——不可硬编码，config 可覆盖。 */
const siteRoot = ref('')

// ── 应用模板（仅反向代理） ──
//
// Node / Java / Python / .NET 在 nginx 这一层**接入方式完全相同**——都是
// `proxy_pass` 到本机端口，渲染出的配置逐字节一致（见 panel-os 的 render_nginx）。
// 它们的差异只在「装什么运行时、用什么命令把进程拉起来」，所以做成**预填模板**，
// 而不是新的 `SiteKind` 变体：加 4 个类型 = 4 份产出同一份配置的 match 分支。
// 真正够格独立成类型的只有**协议不同**者（PHP 走 fastcgi_pass、将来的 gRPC 走 grpc_pass）。
interface AppTemplate {
  key: string
  label: string
  /** 应用默认监听端口（仅作预填，用户可改） */
  port: number
  /** 面板包白名单里的运行时包名，用于「已装/未装」检测；null = 面板不托管该运行时 */
  runtimePkg: string | null
  /** 启动命令示例。**纯提示文案**，不进 nginx 配置——进程本身由 systemd / Docker 托管 */
  startCmd: string
  /** 典型框架，帮用户确认自己没选错 */
  typical: string
}
const APP_TEMPLATES: AppTemplate[] = [
  { key: 'node', label: 'Node.js', port: 3000, runtimePkg: 'nodejs',
    startCmd: 'node server.js', typical: 'Express / NestJS / Next.js' },
  { key: 'java', label: 'Java', port: 8080, runtimePkg: 'default-jdk',
    startCmd: 'java -jar app.jar', typical: 'Spring Boot（内置 Tomcat）' },
  { key: 'python', label: 'Python', port: 8000, runtimePkg: null,
    startCmd: 'gunicorn app:app -b 127.0.0.1:8000', typical: 'Django / Flask / FastAPI' },
  { key: 'dotnet', label: '.NET', port: 5000, runtimePkg: null,
    startCmd: 'dotnet App.dll --urls http://127.0.0.1:5000', typical: 'ASP.NET Core（Kestrel）' },
]

/** 当前选中的应用模板 key；空串 = 未用模板（自定义后端） */
const appTpl = ref('')
/** 上一次由模板写进 `upstreams` 的值——用于判断用户是否手改过（手改过就不再覆盖） */
const tplFilled = ref('')
/** 已安装的运行时包名集合（仅在 runtimeDetectable 为真时有意义） */
const runtimeInstalled = ref<Set<string>>(new Set())
/** 运行时检测是否可用：需 package.install 能力位 + package.manage 权限点，缺一即失败 */
const runtimeDetectable = ref(false)
/** 是否已尝试探测过（避免每次打开弹窗都发一次请求） */
const runtimeProbed = ref(false)
const curTpl = computed(() => APP_TEMPLATES.find(t => t.key === appTpl.value) ?? null)
/** 选中的模板其运行时**未安装**——用于把该 chip 与提示标成警示色 */
const tplRuntimeMissing = computed(() => {
  const t = curTpl.value
  return !!(t && t.runtimePkg && runtimeDetectable.value && !runtimeInstalled.value.has(t.runtimePkg))
})

// 数据模型 CRUD 仅看 RBAC 权限点（角色维度，与平台能力无关，owner/admin 恒有）
const canManage = computed(() => auth.can('site.manage'))
const canSsl = computed(() => auth.can('ssl.manage'))
// 配置下发 / SSL 受平台能力位约束
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
/** 当前 Web 服务器后端（`nginx` / `caddy` / null）。caddy 下**部分字段照常可填、渲染器却不产出**，
 *  必须置灰并说明原因——项目纪律：绝不提供「能填但不生效」的假控件。 */
const webBackend = computed(() => auth.backend(CAP.WEBSERVER_MANAGE))
const isCaddy = computed(() => webSupported.value && webBackend.value === 'caddy')
/** 后端名（文案用；未接入时为通称） */
const webName = computed(() => webBackend.value ?? 'Web 服务器')
/** caddy 未实装项的统一 tooltip：说清「为什么灰」，而不是让用户自己猜 */
const caddyNoop = '当前 Web 服务器为 Caddy：此项目前未实装，已置灰（填了也不会写进配置）'
const sslSupported = computed(() => auth.supported(CAP.SSL_ACME))
const selfSignedSupported = computed(() => auth.supported(CAP.SSL_SELFSIGNED))
// SSL 需基础设施齐备：① 底座（nginx）能加载证书 ② 签发渠道（自签/ACME）③ 权限
const sslReady = computed(() => webSupported.value && (sslSupported.value || selfSignedSupported.value) && canSsl.value)
const sslHint = computed(() => {
  if (!canSsl.value) return '无 ssl.manage 权限'
  if (!webSupported.value) return '需先安装并启动 Web 服务器（nginx / caddy）——证书没有进程可加载'
  return '需 openssl 或 ACME'
})
const canReload = computed(() => webSupported.value && canManage.value)
// 建站与配置下发同源：没有底座就不许建（后端 create 亦 501，前端只是提前挡住并说明原因）
const canCreate = computed(() => webSupported.value && canManage.value)
const createHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  return webSupported.value ? '' : '需先安装并启动 Web 服务器（nginx / caddy）——否则站点建了也无法访问'
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
    return { label: '无', cls: '', title: '尚未为该站点签发证书（在「编辑站点」里点「申请证书」）' }
  }
  if (!s.deployed) {
    return { label: '已签发·未生效', cls: 'badge-warn', title: '证书已生成并落盘，但站点配置尚未下发到 Web 服务器，HTTPS 还没生效' }
  }
  return { label: '已启用', cls: 'badge-ok', title: '证书已随站点配置在 Web 服务器生效' }
}

/**
 * 上次下发时间（023）列用紧凑格式：`MM-DD HH:mm`（无年份——同面板内「去年的
 * 下发」极少，完整时间走 title）。null/非法一律 `—`：0 是合法时间戳（1970），
 * 与「从未下发」语义相反，绝不能把 NULL 显示成 1970。
 */
function fmtApplied(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 列表**非静默加载失败**（区别于「真的一个站点都没有」）。
 * 不加这个标志时 `sites` 保持空数组 → 走 EmptyState「暂无站点 · 点新建站点」，
 * 与顶部的错误红字自相矛盾（一边说加载失败、一边说没有数据）。
 */
const loadFailed = ref(false)

async function load(silent = false) {
  if (!silent) { loading.value = true; error.value = ''; loadFailed.value = false }
  try {
    sites.value = await api.get<Site[]>(API.sites.list())
    certs.value = await api.get<Cert[]>(API.certs.list())
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

function certLevel(d: number | null) {
  if (d === null) return 'dim'
  if (d > 30) return 'ok'
  if (d >= 7) return 'warn'
  return 'bad'
}

// 自动续期扫描状态摘要：供编辑弹窗内 SSL 区展示"上次/下次扫描"
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
// 路由级根目录选择器：记录当前编辑的路由下标（站点级用 pickerOpen/onPickRoot）。
// 同一时刻只能开一个 DirectoryPickerDialog，站点级与路由级互斥（不会同时开）。
const routePickerIdx = ref(-1)
const routePickerOpen = ref(false)
function openRouteRootPicker(i: number) {
  routePickerIdx.value = i
  routePickerOpen.value = true
}
function onPickRouteRoot(p: string) {
  if (routePickerIdx.value >= 0) form.value.routes[routePickerIdx.value].root = p
  routePickerOpen.value = false
  routePickerIdx.value = -1
}
// 站点编辑弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const modalBox = ref<HTMLElement | null>(null)
// 编辑弹窗全屏 + 左侧分段导航（2026-10-11，B 方案）：导航 rail 平滑滚动到对应分区，
// 滚动时高亮当前分区；打开弹窗时复位到顶部与首个分区。
const modalBody = ref<HTMLElement | null>(null)
// 段名必须**如实**对应段内实际内容：此前「安全与性能」里塞着自定义片段、www 跳转、
// 伪静态这类「站点行为」项，「日志与证书」里塞着整块 Nginx 原文与历史版本——
// 名字与内容不符，找东西只能靠猜。
const navSections = [
  { id: 'sec-basic', label: '基础' },
  { id: 'sec-routing', label: '路由与后端' },
  { id: 'sec-secure', label: '安全与高级' },
  { id: 'sec-ops', label: '日志 · 证书 · 原文' },
] as const
/** 表单字段 → 所属分区。仅用于把字段级错误映射回导航 rail（见 secErrs）。 */
const FIELD_SEC: Record<string, string> = {
  name: 'sec-basic', domains: 'sec-basic', root: 'sec-basic',
  upstreams: 'sec-routing', fpm: 'sec-routing',
  redirectTarget: 'sec-routing', redirectCode: 'sec-routing', routes: 'sec-routing',
  wafProfile: 'sec-secure', wafRate: 'sec-secure', wafBurst: 'sec-secure',
  customConf: 'sec-secure', authUser: 'sec-secure', authPass: 'sec-secure',
}
/** 分区是否有字段级错误：rail 上对应项亮红点，用户切到别的分区后仍知道哪儿没改对。 */
const secErrs = computed<Record<string, boolean>>(() => {
  const m: Record<string, boolean> = {}
  for (const k of Object.keys(fieldErrs.value)) {
    const s = FIELD_SEC[k]
    if (s) m[s] = true
  }
  return m
})
const activeSec = ref<string>('sec-basic')
function scrollToSec(id: string) {
  const body = modalBody.value
  if (!body) return
  const el = body.querySelector<HTMLElement>('#' + id)
  if (!el) return
  body.scrollTo({ top: Math.max(0, el.offsetTop - 14), behavior: 'smooth' })
  activeSec.value = id
}
function onBodyScroll() {
  const body = modalBody.value
  if (!body) return
  const top = body.scrollTop + 28
  let cur: string = navSections[0].id
  for (const s of navSections) {
    const el = body.querySelector<HTMLElement>('#' + s.id)
    if (el && el.offsetTop <= top) cur = s.id
  }
  activeSec.value = cur
}
watch(modalOpen, (v) => {
  if (!v) return
  nextTick(() => {
    modalBody.value?.scrollTo({ top: 0 })
    activeSec.value = 'sec-basic'
  })
})
// 统一关闭出口（离场动画 + 焦点返还）：X / 点遮罩 / 取消按钮 / Esc 都走它
const { close: modalClose } = useModal(() => modalOpen.value, modalBox, closeModal)
const editing = ref<Site | null>(null)
/** 空表单。`wafRate: 0` / `wafBurst: 0` 与后端的"不限速 / 自动"语义一一对应。 */
function emptyForm() {
  return {
    name: '', domains: '', root: '', enabled: true,
    kind: 'static', upstreams: '', fpm: '',
    spa: false, redirectTarget: '', redirectCode: 301,
    // 多路由表。**新建时给一条 `/` 静态兜底**——不是默认值，是必要条件：
    // 缺兜底的路由表会被后端拒（漏掉的路径会落到别的站点去，用户无从预期）。
    routes: [newRoute('/', 'static')] as RouteRow[],
    wafOn: false, wafProfile: 'basic', wafRate: 0, wafBurst: 0,
    // 自定义配置片段（019）：插在主 server 块尾部（所有 location 之后），随保存并应用
    // 重新渲染下发；仅 owner 可改（后端 403 + 64KiB 双护栏）。空串 = 不使用。
    customConf: '',
    // 高级配置（020）：www 跳转 / TLS 强化 / 伪静态。默认值与后端 020 迁移一致
    wwwRedirect: 'off', tlsProfile: 'modern', tlsMin: 'TLSv1.2',
    hsts: false, hstsMaxAge: 300, hstsSub: false, hstsPreload: false,
    rewritePreset: 'none', rewriteCustom: '',
    // 访问控制 / 反代增强 / 站点日志（021）：默认值与后端 021 迁移一致
    ipAllow: '', ipDeny: '', authBasic: false, authUser: '', authPass: '',
    lbPolicy: 'least_conn', proxyConnectTimeout: 60, proxySendTimeout: 60, proxyReadTimeout: 60,
    logAccess: false, logError: false, logErrorLevel: 'error',
    // 对象说明（备注，022）：便签式内联编辑，独立于大表单保存
    remark: '',
  }
}

/** 表单里的一条路由（`upstreams` 存成逗号分隔的字符串，便于 v-model 绑定）。 */
interface RouteRow {
  prefix: string
  kind: 'proxy' | 'static' | 'php'
  upstreams: string
  spa: boolean
  fpm: string
  frontController: string
  /** kind=static：该路由自己的根目录（可选，覆盖站点级 root）；留空继承站点根 */
  root: string
}

function newRoute(prefix: string, kind: RouteRow['kind']): RouteRow {
  return { prefix, kind, upstreams: '', spa: false, fpm: '', frontController: '', root: '' }
}

/**
 * 新增一条路由。前缀给一个**不与现有重复**的默认值（`/api`、`/api2`…），
 * 免得用户点一下就撞上「前缀重复」报错还要自己想名字。
 */
function addRoute() {
  const used = new Set(form.value.routes.map((r) => r.prefix.trim()))
  let p = '/api'
  for (let i = 2; used.has(p) && i < 50; i++) p = `/api${i}`
  form.value.routes.push(newRoute(p, 'proxy'))
}

/** 删除一条路由。**至少保留一条**——空表无法保存，且用户多半只是想改不是想删光。 */
function removeRoute(i: number) {
  if (form.value.routes.length <= 1) return
  form.value.routes.splice(i, 1)
}

/** `RouteRow` → API 口径（只填该 kind 需要的字段，其余留空由后端忽略）。 */
function rowToRoute(r: RouteRow): SiteRoute {
  if (r.kind === 'proxy') {
    return { prefix: r.prefix.trim(), kind: 'proxy', upstreams: r.upstreams.split(/[,\s]+/).filter(Boolean) }
  }
  if (r.kind === 'php') {
    return { prefix: r.prefix.trim(), kind: 'php', fpm: r.fpm.trim(), front_controller: r.frontController.trim() }
  }
  return { prefix: r.prefix.trim(), kind: 'static', spa: !!r.spa, root: r.root.trim() || undefined }
}
const form = ref(emptyForm())

function openCreate() {
  editing.value = null
  form.value = emptyForm()
  resetTemplate()
  // 清掉上一次遗留的报错：否则上次保存失败的红条会在重新打开弹窗时**立即**出现，
  // 让人误以为这次什么都还没提交就已经出错了。
  error.value = ''
  void probeRuntime()
  modalOpen.value = true
}
function openEdit(s: Site) {
  editing.value = s
  form.value = {
    ...emptyForm(),
    name: s.name, domains: s.domains.join(', '), root: s.root, enabled: s.enabled,
    // 类型**从站点真实值预填**。此前写死 'static'，于是「编辑反代站 → 应用」
    // 会把它静默改写成静态站（后端当时也没存真实类型，两侧一起错）。
    kind: ['proxy', 'php', 'redirect', 'routed'].includes(s.kind) ? s.kind : 'static',
    // 多路由回填：后端已校验并归一化过（末尾 / 已去重），可直接编辑。
    // 兜底缺失时补一条——正常不会发生（写入方已拦），但避免打开就是空表无从下手。
    routes: s.kind === 'routed' && (s.routes ?? []).length
      ? (s.routes ?? []).map((r): RouteRow => ({
          prefix: r.prefix,
          kind: r.kind,
          upstreams: (r.upstreams ?? []).join(', '),
          spa: !!r.spa,
          fpm: r.fpm ?? '',
          frontController: r.front_controller ?? '',
          root: r.root ?? '',
        }))
      : [newRoute('/', 'static')],
    // 后端已把 upstreams/fpm 落库（migration 009），编辑时回填真实值：
    // 否则编辑反代/PHP 站再应用，后端配置会被静默清空。
    upstreams: (s.upstreams ?? []).join(', '),
    fpm: s.fpm ?? '',
    // SPA 回退仅 static 类型有意义：编辑时回填真实值，其余类型恒 false。
    spa: s.kind === 'static' && s.spa,
    // 整站重定向：编辑时回填目标 URL 与状态码（kind=redirect 时才有意义）。
    redirectTarget: s.redirect_target ?? '',
    redirectCode: s.redirect_code ?? 301,
    wafOn: s.waf_enabled,
    wafProfile: s.waf_profile ?? 'basic',
    wafRate: s.waf_rate_per_sec ?? 0,
    wafBurst: s.waf_burst ?? 0,
    // 自定义片段回填（019）：null / 缺失一律落空串，textarea 里就是干净的空白。
    customConf: s.custom_conf ?? '',
    // 高级配置回填（020）：库里都有 DEFAULT，缺失时回落到与后端相同的默认值
    wwwRedirect: s.www_redirect || 'off',
    tlsProfile: s.tls_profile || 'modern',
    tlsMin: s.tls_min || 'TLSv1.2',
    hsts: !!s.hsts,
    hstsMaxAge: s.hsts_max_age ?? 300,
    hstsSub: !!s.hsts_include_sub,
    hstsPreload: !!s.hsts_preload,
    rewritePreset: s.rewrite_preset || 'none',
    rewriteCustom: s.rewrite_custom ?? '',
    // 访问控制 / 反代增强 / 站点日志（021）回填：库里都有 DEFAULT，缺失时回落到与后端相同的默认值
    ipAllow: (s.ip_allow ?? []).join(', '),
    ipDeny: (s.ip_deny ?? []).join(', '),
    authBasic: !!s.auth_basic,
    authUser: s.auth_user ?? '',
    authPass: '', // 口令只写不读，永不回填
    lbPolicy: s.lb_policy || 'least_conn',
    proxyConnectTimeout: s.proxy_connect_timeout ?? 60,
    proxySendTimeout: s.proxy_send_timeout ?? 60,
    proxyReadTimeout: s.proxy_read_timeout ?? 60,
    logAccess: !!s.log_access,
    logError: !!s.log_error,
    logErrorLevel: s.log_error_level || 'error',
    // 对象说明回填（022）
    remark: s.remark ?? '',
  }
  // 与 openCreate 同理：清掉上次遗留的报错，避免「一打开就是红条」的误导。
  error.value = ''
  // 反推模板选中态：后端是 3000/8080/8000/5000 就点亮对应 chip（仅供辨识，不改数据）
  resetTemplate()
  detectTemplateFromUpstreams()
  void probeRuntime()
  // 站点配置区：清残留 + 拉取当前站点的落盘配置（异步，不阻塞弹窗打开）。
  resetConf()
  // 表单规格基线：保存时据此判断「本次是否改了影响配置的字段」（手动维护站点要弹二选一）。
  confSpecBase.value = confSpecNow()
  void loadConf(s.id)
  // 此前漏了这一行：只回填了表单却不开弹窗，点「编辑」毫无反应
  modalOpen.value = true
}

/** 对象说明（备注，022）：便签式内联保存，独立于大表单——保存站点要走 nginx
 *  校验与下发，一句备注不该拖住整张表单。仅编辑已有站点时可用（新建尚无 id）。 */
async function saveRemark(v: string) {
  if (!editing.value) return
  await api.patch(API.sites.remark(editing.value.id), { remark: v })
  form.value.remark = v
  editing.value.remark = v
}

/**
 * 复位应用模板选中态。每次打开弹窗都要做——否则上次的选择会残留在下一次新建里。
 */
function resetTemplate() {
  appTpl.value = ''
  tplFilled.value = ''
}

/**
 * 套用应用模板：把反代目标预填为 `http://127.0.0.1:<port>`。
 *
 * **刻意不覆盖用户手输的内容**——只在「后端」为空、或仍等于上次由模板写入的值时才填。
 * 否则用户先手填了 `http://10.0.0.5:9000` 再点一下模板，输入就被静默吞掉（很难发现）。
 * 再点一次同一个 chip 表示取消选择。
 */
function useTemplate(t: AppTemplate) {
  if (appTpl.value === t.key) { resetTemplate(); return }
  const cur = form.value.upstreams.trim()
  if (cur === '' || cur === tplFilled.value) {
    const v = `http://127.0.0.1:${t.port}`
    form.value.upstreams = v
    tplFilled.value = v
  }
  appTpl.value = t.key
  clearFieldErr('upstreams')
}

/**
 * 拉运行时安装状态，只为在模板提示里显示「已装 / 未装」。
 *
 * 双重门控：能力位 `package.install`（决定枚举端点是否可用）+ 权限点 `package.manage`
 * （后端 packages_list 正是按它签发的）——两者分属**两套命名空间**，写错不会报错、
 * 只会静默 disable（守卫 ci/check-permissions.sh）。
 * 失败**静默降级**：这只是锦上添花的提示，不该影响站点编辑主流程。
 *
 * ⚠ **口径是「包管理器里的系统包」**（apt 的 `nodejs` / `default-jdk`），**不等于**
 * 「这台机器上有没有 Node」——用 nvm / 官方安装包装好的运行时不在这里出现
 * （实测本机 `PATH` 有 node 22 而 apt 未装 nodejs）。故文案一律写「系统包 xxx 未装」，
 * 不做「你没有 Node」这种断言；`runtimePkg: null` 的语言干脆不显示状态。
 */
async function probeRuntime() {
  if (runtimeProbed.value) return
  runtimeProbed.value = true
  if (!auth.enabled(CAP.PACKAGE_INSTALL, 'package.manage')) return
  try {
    const r = await api.get<{ packages: PackageInfo[] }>(API.packages.list())
    runtimeInstalled.value = new Set((r.packages ?? []).map(x => x.name))
    runtimeDetectable.value = true
  } catch { runtimeDetectable.value = false }
}

/**
 * 编辑已有站点时，若其后端**恰好**是某个模板的默认端口，就把该模板点亮——
 * 让用户一眼看出"这是个 Node 应用"，不必回想当初选了什么。
 * 只在「单一后端且完全匹配」时命中，多后端（负载均衡）不强猜。
 */
function detectTemplateFromUpstreams() {
  const list = form.value.upstreams.split(/[,\s]+/).filter(Boolean)
  if (list.length !== 1) return
  const hit = APP_TEMPLATES.find(t => list[0] === `http://127.0.0.1:${t.port}`)
  if (hit) appTpl.value = hit.key
}

/** 站点类型的中文名（列表与提示共用一份）。 */
function kindLabel(k: string) {
  if (k === 'proxy') return '反向代理'
  if (k === 'php') return 'PHP'
  if (k === 'redirect') return '整站重定向'
  if (k === 'routed') return '多路由'
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
function closeModal() {
  modalOpen.value = false; editing.value = null
  // 关闭即清理：下次打开弹窗一定是干净的，不会"什么都还没提交就顶着上次的红条"。
  formError.value = ''; fieldErrs.value = {}
}

// ── 错误定位：把报错落到**出问题的那个输入框旁边** ──
/** 与后端 is_valid_domain 的语法段同口径（TLD 真实性只由后端校验，前端不内嵌列表）。 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
/** 与后端 is_valid_site_name 同口径：字母数字开头，后可接字母数字与 . _ -，长度 1~63。 */
const SITE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
/**
 * 后端 400 的字段名 → 表单字段 key + 中文兜底文案（见 panel-api `ApiError::bad_request`）。
 * 后端 reason 已是中文时优先用它（更具体），否则回退到这里的兜底（避免把英文甩给用户）。
 */
const BACKEND_FIELD: Record<string, { key: string; msg: string }> = {
  name: { key: 'name', msg: '站点名称格式不正确' },
  domains: { key: 'domains', msg: '域名格式不正确' },
  root: { key: 'root', msg: '根目录不合法' },
  upstreams: { key: 'upstreams', msg: '后端地址不合法' },
  fpm: { key: 'fpm', msg: 'php-fpm 目标不合法' },
  redirect_target: { key: 'redirectTarget', msg: '重定向目标 URL 不合法' },
  redirect_code: { key: 'redirectCode', msg: '重定向状态码不合法' },
  'waf.profile': { key: 'wafProfile', msg: 'WAF 档位不合法' },
  'waf.rate_per_sec': { key: 'wafRate', msg: '限速取值不合法' },
  'waf.burst': { key: 'wafBurst', msg: '突发桶取值不合法' },
  custom_conf: { key: 'customConf', msg: '自定义片段不合法' },
}
/** 后端 reason 是否已是给人看的中文——是则原样透出（更具体），否则用前端中文兜底。 */
function fieldMsg(fallback: string, reason: string) {
  return /[\u4e00-\u9fff]/.test(reason) ? reason : fallback
}
/** 用户一改动该字段就撤掉它的红字提示：问题正在被修，不该继续吓人。 */
function clearFieldErr(key: string) {
  if (fieldErrs.value[key]) delete fieldErrs.value[key]
}
/**
 * 把出问题的字段滚进视野。用 `nearest`——**已在视野内则纹丝不动**，
 * 只有真的看不见时才最小幅度滚动，避免"错误一出现页面就跳"。
 */
function revealField(key: string) {
  nextTick(() => {
    modalBox.value?.querySelector<HTMLElement>(`[data-f="${key}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}
/** 错误归位：编辑弹窗开着就进弹窗（绝不当页面级错误），否则才留在页面顶部的提示条。 */
function showErr(msg: string) {
  if (modalOpen.value) { formError.value = msg; errSeq.value++ }
  else error.value = msg
}

/**
 * 保存站点 = ① 写数据模型 ② 下发配置（环境支持时）。
 *
 * 这两步与后端的职责划分一一对应：`create`/`patch` 管 `sites` 表（`patch` 还负责
 * `enabled` 的**真同步**：停用=摘配置+reload），`apply` 管渲染下发。
 * 此前它们被拆成页面上两个卡片（顶部「应用站点配置」+ 本弹窗），字段重复、
 * 同一份信息要填两遍，且「新建」按钮建出来的站点还得再去顶部点一次应用才能访问
 * ——现在合并为：**保存即下发**。SSL 证书管理同理并入本弹窗（见下方 .ssl 区块）。
 */
async function save() {
  busy.value = true; error.value = ''; formError.value = ''; fieldErrs.value = {}
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  try {
    // ── 前置校验：**逐字段收集**，而非抛出第一个就中断 ──
    // 好处有二：① 一次把所有问题都标出来，用户改一轮即可；② 每条都挂在**对应输入框旁**
    // （靠模板上的 data-f 定位），"域名错就提示在域名处、根目录错就提示在根目录处"，
    // 而不是所有错误统一堆在弹窗底部、让用户自己去猜哪个框填错了。
    const errs: Record<string, string> = {}
    if (!name) errs.name = '请填写站点名称'
    else if (!SITE_NAME_RE.test(name)) errs.name = '名称需以字母或数字开头，只能含字母、数字、. _ -，长度 1~63'
    if (!domains.length) errs.domains = '至少需要填写一个域名'
    else {
      for (const d of domains) {
        if (!DOMAIN_RE.test(d.toLowerCase())) {
          errs.domains = `域名「${d}」格式不正确：需至少两级，如 example.com`
          break
        }
      }
    }
    if (webSupported.value) {
      // 目标值的必填校验。proxy/php 的目标会**直接进 nginx 配置文本**，注入校验在后端；
      // 这里只做"别把空值递上去"的提示，不做安全判断（前端判断等于没有判断）。
      if (form.value.kind === 'proxy' && !form.value.upstreams.trim()) errs.upstreams = '反向代理需要填写至少一个后端地址'
      if (form.value.kind === 'php' && !form.value.fpm.trim()) errs.fpm = 'PHP 站点需要填写 php-fpm 目标'
      if (form.value.kind === 'redirect') {
        const t = form.value.redirectTarget.trim()
        if (!t) errs.redirectTarget = '整站重定向需要填写目标 URL'
        else if (!/^https?:\/\/\S+/i.test(t)) errs.redirectTarget = '目标 URL 必须以 http:// 或 https:// 开头'
      }
      if (form.value.kind === 'routed') {
        // 逐条收集（与整体校验同风格：一次把所有问题标出来，而不是抛第一个就中断）
        const rs = form.value.routes
        if (!rs.length) errs.routes = '至少需要一条路由'
        else {
          const seen = new Set<string>()
          for (let i = 0; i < rs.length; i++) {
            const r = rs[i]
            const p = r.prefix.trim()
            if (!p.startsWith('/')) { errs.routes = `第 ${i + 1} 条路由的前缀「${r.prefix}」必须以 / 开头`; break }
            if (seen.has(p)) { errs.routes = `路由前缀「${p}」重复`; break }
            seen.add(p)
            if (r.kind === 'proxy' && !r.upstreams.trim()) { errs.routes = `第 ${i + 1} 条路由（${p}）的反代需要后端地址`; break }
            if (r.kind === 'php') {
              if (!r.fpm.trim()) { errs.routes = `第 ${i + 1} 条路由（${p}）需要 php-fpm 目标`; break }
              if (!r.frontController.trim().startsWith('/')) {
                errs.routes = `第 ${i + 1} 条路由（${p}）的入口脚本必须以 / 开头（如 /public/index.php）`; break
              }
            }
          }
          if (!errs.routes && !seen.has('/')) errs.routes = '必须有一条前缀为 / 的兜底路由（否则漏掉的路径会落到别的站点）'
        }
      }
      // 自定义片段（019）：前端只挡「明知超限还提交」的必然失败；owner 判定与
      // 64 KiB 的权威校验仍在后端（前端判断不等于后端校验）。非 owner 不发送该字段。
      if (isOwner.value && form.value.customConf.trim()
        && new TextEncoder().encode(form.value.customConf).length > 64 * 1024) {
        errs.customConf = '自定义片段超过 64 KiB 上限（原始配置文本按字节计）'
      }
      // 访问控制（021）：Basic Auth 开启时必须填用户名；新站点首次开启还需口令
      if (form.value.authBasic) {
        const u = form.value.authUser.trim()
        if (!u) errs.authUser = '开启 Basic Auth 必须填写用户名'
        else if (u.includes(':') || /\s/.test(u)) errs.authUser = '用户名不能含冒号或空白'
        else if (!editing.value && !form.value.authPass) errs.authPass = '新站点首次开启 Basic Auth 需设置口令'
      }
    }
    const firstBad = Object.keys(errs)[0]
    if (firstBad) {
      fieldErrs.value = errs
      errSeq.value++             // 红字重建 → 抖动动画重播：连点保存也总有可见反馈
      revealField(firstBad)      // 把第一个出错的字段（含其红字）滚进视野
      return
    }
    // 手动维护站点：apply 不会自动更新磁盘配置（后端整段跳过渲染/下发）。若本次动了
    // 影响配置的字段（或站点此前已未同步），先弹二选一——默默跳过就是制造
    // 「面板显示 A、nginx 实际 B」的静默分叉（as11 真实踩过，017 迁移为它而立）。
    // ⚠ 判定源必须「实时 + 快照」双取：confManual / confStale 是配置区本次会话的
    //   实时状态（loadConf、保存配置后即刻更新），editing.* 是打开弹窗时的列表快照。
    //   曾只用快照：同一会话内先「保存配置」转手动、再改 WAF 保存，快照里 manual
    //   仍是 false → 不弹二选一、静默入库（实测复现）——正是 017 要消灭的分叉。
    if (
      (confManual.value || editing.value?.manual_conf) &&
      form.value.enabled &&
      (confStale.value || editing.value?.conf_stale || confSpecChanged())
    ) {
      saveAsk.value = true
      return
    }
    await commitSave(false)
  } catch (e) {
    mapSaveError(e)
  } finally { busy.value = false }
}

/** 保存失败的统一落点（本次保存 + 二选一续跑共用同一套字段映射与抖动反馈）。 */
function mapSaveError(e: unknown) {
  // **能定位到字段就挂在字段旁**；定位不到（网络/服务端异常）才用通用错误条。
  const fd = errorFieldDetail(e)
  if (fd) {
    const m = BACKEND_FIELD[fd.field]
    if (m) {
      fieldErrs.value = { [m.key]: fieldMsg(m.msg, fd.reason) }
      revealField(m.key)
    } else {
      formError.value = fieldMsg('提交内容有误，请检查后重试', fd.reason)
    }
  } else if ((e as { code?: number } | null)?.code === 50001) {
    // 50001 = 路径越界。本表单里唯一的路径输入就是根目录，落到它旁边。
    fieldErrs.value = { root: errorText(e) }
    revealField('root')
  } else {
    formError.value = errorText(e)
  }
  // 递增序号：错误条被重建 → 抖动动画重播，用户连点保存每次都得到可见反馈。
  errSeq.value++
}

/**
 * 校验通过后的实际保存：patch/create 落库 + apply 下发。
 *
 * `regenerate=true` 仅对「手动维护」站点有意义：按当前表单重新渲染并覆盖手写配置
 * （后端 regen_conf；覆盖前自动备份），站点恢复为面板托管、「未同步」解除。
 * 「仅保存」（false）时后端保持文件不动——若与表单分叉，后端会标记为「未同步」。
 */
async function commitSave(regenerate: boolean) {
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  const root = form.value.root.trim() || undefined
  // regen 只对手动维护站点传递（其余站点后端会忽略，但不发明无用参数）。
  // ⚠ 与 save() 的弹窗判定同源：必须「实时（confManual）+ 快照（editing）」双取——
  //   同一会话内刚「保存配置」转手动时列表快照还是旧值，只查快照会漏传 regen_conf，
  //   用户点了「按表单重新生成」却实际不生成（静默失效）。
  const regen = regenerate && (confManual.value || editing.value?.manual_conf === true)
  // ① 数据模型。新建走 create（它能确立初始 enabled），编辑走 patch（它负责启停真同步）。
  if (editing.value) {
    // name 一并提交：后端 patch 自本次起支持改名（nginx 配置按域名派生、
    // root 已是绝对路径、证书按 domain，改名都不影响，也不会重新下发配置）
    await api.patch(API.sites.patch(editing.value.id), { name, domains, root, enabled: form.value.enabled })
  } else {
    await api.post(API.sites.create(), { name, domains, root, enabled: form.value.enabled })
  }
  // ② 下发。**停用态也照样调 apply**——它只落库不下发（与后端「停用守恒」一致），
  //    但类型 / 反代后端 / php-fpm / WAF 只有 apply 才会写进库。
  let msg: string
  if (webSupported.value) {
    const r = await deploy(name, domains, regen)
    msg = r && r.regenerated
      // 本次按表单重新生成：覆盖了手写配置（覆盖前已备份；备份失败也如实说）
      ? `已保存站点 ${name}：已按表单重新生成配置并覆盖磁盘文件${r.backup ? '（原配置已自动备份）' : '（注意：原配置备份失败，审计日志已记录）'}`
      : r && r.manual
        // 手动维护 + 选了「仅保存」：表单照常入库，磁盘配置**刻意不动**。
        // 只说"已保存"等于撒谎——要讲清"配置没改、以及怎么同步"。
        ? `已保存站点 ${name}：该站点为「手动维护」——表单改动已入库，配置文件未覆盖（如需同步到配置，请用配置区「按表单重新生成」）`
        : r && r.deployed === false
          ? `已保存站点 ${name}：当前为停用状态，配置已登记但未下发`
          : `已保存站点 ${name} 并下发配置`
  } else {
    msg = `已保存站点 ${name}（未接入 Web 服务器：仅登记，未下发）`
  }
  // 成功提示走浮层 toast（脱离文档流）：写成页面级 notice 会把下方内容整体下推，
  //   每次保存页面都抖一下，观感不稳——这正是本次改 toast 的原因。
  closeModal(); await load(); toast(msg)
}

/** 二选一后继续保存（「按表单重新生成」与「仅保存」两个动作按钮的落点）。 */
async function resumeSave(regenerate: boolean) {
  saveAsk.value = false
  busy.value = true
  try {
    await commitSave(regenerate)
  } catch (e) {
    mapSaveError(e)
  } finally { busy.value = false }
}

/** 站点类型 → apply 载荷里的目标值（proxy / php / redirect 的目标会直接进 nginx 配置文本）。 */
function kindTargets() {
  const kind = form.value.kind
  if (kind === 'proxy') return { upstreams: form.value.upstreams.split(/[,\s]+/).filter(Boolean) }
  if (kind === 'php') return { fpm: form.value.fpm.trim() }
  if (kind === 'redirect') return { redirect_target: form.value.redirectTarget.trim(), redirect_code: form.value.redirectCode }
  // 多路由：整表下发。省略 ≠ 清空（后端 `routes` 缺省 = 保留库中现有表）。
  if (kind === 'routed') return { routes: form.value.routes.map(rowToRoute) }
  return {}
}

/**
 * 渲染并下发站点配置（「保存站点」的第二步；受 webserver 能力门禁）。
 *
 * 与列表行「重载」的区别：重载只是让 nginx 重读**磁盘上已有的**配置，不会重新渲染；
 * 改了域名 / 类型 / WAF 后必须走这里才会生效。
 */
async function deploy(name: string, domains: string[], regenerate = false) {
  // 响应字段供 commitSave 如实提示：
  // - manual（本站点处于「手动维护」，本次**未**重渲染/下发）
  // - regenerated/backup（本次选了「按表单重新生成」：已覆盖手写配置 + 备份路径，可 null）
  return api.post<{ deployed?: boolean; manual?: boolean; regenerated?: boolean; backup?: string | null }>(API.sites.apply(), {
    name,
    domains,
    root: form.value.root.trim() || name,
    force_https: true,
    kind: form.value.kind,
    // SPA 回退仅对 static 类型有意义：其余类型强制 false，避免误带入反代/重定向。
    spa: form.value.kind === 'static' ? !!form.value.spa : false,
    ...kindTargets(),
    // 仅「手动维护 + 用户选了重新生成」才带：后端据此按本次表单覆盖手写配置
    ...(regenerate ? { regen_conf: true } : {}),
    // 自定义片段（019，仅 owner）：空串 = 清空、非空 = 覆盖；非 owner **不传**——
    // 后端语义是「缺省 = 保留库中现值」（与 waf 同款），不传绝不误清 owner 的片段。
    ...(isOwner.value ? { custom_conf: form.value.customConf } : {}),
    // 高级配置（020）：显式传即覆盖（校验在后端走白名单/区间）
    www_redirect: form.value.wwwRedirect,
    tls_profile: form.value.tlsProfile,
    tls_min: form.value.tlsMin,
    hsts: form.value.hsts,
    hsts_max_age: form.value.hstsMaxAge,
    hsts_sub: form.value.hstsSub,
    hsts_preload: form.value.hstsPreload,
    rewrite_preset: form.value.rewritePreset,
    rewrite_custom: form.value.rewriteCustom,
    // 访问控制 / 反代增强 / 站点日志（021）：IP 名单以逗号分隔字符串提交（后端解析/校验）
    ip_allow: form.value.ipAllow.split(/[,\s]+/).filter(Boolean).join(','),
    ip_deny: form.value.ipDeny.split(/[,\s]+/).filter(Boolean).join(','),
    auth_basic: form.value.authBasic,
    auth_user: form.value.authUser.trim() || null,
    // 口令只写不读：仅在本次填写了才提交（否则保留现有 htpasswd 文件，不误清）
    ...(form.value.authPass ? { auth_pass: form.value.authPass } : {}),
    lb_policy: form.value.lbPolicy,
    proxy_connect_timeout: form.value.proxyConnectTimeout,
    proxy_send_timeout: form.value.proxySendTimeout,
    proxy_read_timeout: form.value.proxyReadTimeout,
    log_access: form.value.logAccess,
    log_error: form.value.logError,
    log_error_level: form.value.logErrorLevel,
    waf: wafPayload(),
  })
}

// ── 站点日志（021）：查看 / 清空 ──
/** 查看日志：浏览器新标签打开下载端点（text/plain 直接渲染/下载）。 */
function viewLog(kind: 'access' | 'error') {
  if (!editing.value) return
  window.open(API.sites.logDownload(editing.value.id, kind), '_blank', 'noopener')
}
/** 清空日志（截断而非删除）：先弹内联二次确认（避免误清空），确认后 POST。 */
const clearAsk = ref<'access' | 'error' | null>(null)
async function clearLog(kind: 'access' | 'error') {
  if (!editing.value) return
  clearAsk.value = kind
}
async function confirmClear() {
  const kind = clearAsk.value
  clearAsk.value = null
  if (!kind || !editing.value) return
  // ⚠️ 清空日志发生在**编辑弹窗内**，错误绝不能写页面级 error——那行提示在 .mask 之后，
  //    用户只会看到"点了确认没反应"。走 formError（弹窗顶部吸顶条）。
  busy.value = true; formError.value = ''
  try {
    await api.post(API.sites.logClear(editing.value.id), { kind })
    toast(kind === 'access' ? '访问日志已清空' : '错误日志已清空')
  } catch (e) { formError.value = errorText(e); errSeq.value++ }
  finally { busy.value = false }
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
    else error.value = errorText(e)
  } finally { rowBusyId.value = null; busy.value = false; await load() }
}

// ── SSL：证书管理已并入「编辑站点」弹窗 ──
/** 编辑弹窗内展示「当前站点」的证书：按域名过滤全局证书列表（证书以 domain 归属站点）。 */
const siteCerts = computed<Cert[]>(() =>
  editing.value ? certs.value.filter(c => (editing.value as Site).domains.includes(c.domain)) : [])

/** SSL 签发弹窗（审计 U6：替代 window.prompt 选方式/填邮箱）。 */
const sslModal = ref<{ site: Site; method: 'self-signed' | 'http-01'; email: string } | null>(null)
/**
 * 签发弹窗**自己**的错误位。
 *
 * 签发弹窗是叠在站点弹窗之上的第二层遮罩，此时页面级的 error/notice 会被两层遮罩
 * 挡在后面——用户什么都看不见，只看到点「申请」没反应。所以这一层的报错必须落在
 * 它自己的可见区域里。
 */
const sslErr = ref('')

/** 根证书安装指引弹窗。自签证书能被浏览器信任的**唯一**前提是把根 CA 装进信任库。 */
const caHelp = ref(false)

// 另外两个弹窗同样接统一关闭出口（此前 CA 指引与 SSL 签发都只有点遮罩一种关法，
// 没有 Esc，也没有焦点返还）
const caBox = ref<HTMLElement | null>(null)
const { close: closeCaHelp } = useModal(() => caHelp.value, caBox, () => { caHelp.value = false })
const sslBox = ref<HTMLElement | null>(null)
const { close: closeSslModal } = useModal(() => !!sslModal.value, sslBox, () => { sslModal.value = null })
/**
 * 下载面板根证书（ca.crt）。
 *
 * 用 location 直下而非 fetch——与 FilesView 下载同范式：GET + cookie 认证即可，
 * 不需要（也不能）带 CSRF 头，响应流交给浏览器原生处理（自动落到下载目录）。
 */
function downloadCa() {
  window.location.href = API.certs.ca()
}

/**
 * 把签发类错误放到**用户当下真正看得见的那一层**：签发弹窗 > 站点编辑弹窗 > 页面级。
 * 此前一律写页面级 error/notice，弹窗开着时全被遮罩挡在后面 → 表现为"点了没反应"。
 * `asNotice`：能力未接入（还没装上）属提示而非报错，改走中性 toast。
 * toast 是浮层、恒在遮罩之上，故不再需要"弹窗开着就降级到页面级"的分支。
 */
function sslErrTo(msg: string, asNotice = false) {
  if (sslModal.value) { sslErr.value = msg; return }
  if (asNotice) { toast(msg, 'info'); return }
  showErr(msg)
}

/** 行内「SSL」快捷入口：直接开签发弹窗（仅一种渠道可用时立即执行，不给"必败选项"）。 */
function applySsl(s: Site) {
  error.value = ''
  if (!(selfSignedSupported.value && sslSupported.value)) {
    execSsl(s, selfSignedSupported.value ? 'self-signed' : 'http-01', '')
    return
  }
  sslErr.value = ''
  sslModal.value = { site: s, method: 'self-signed', email: '' }
}
/** 编辑弹窗内「申请证书」：作用对象即当前正在编辑的站点。 */
function applySslEditing() {
  if (editing.value) applySsl(editing.value)
}

async function execSsl(s: Site, method: 'self-signed' | 'http-01', email: string) {
  busy.value = true; error.value = ''; sslErr.value = ''
  // ACME 必须有账户邮箱：CA 靠它发到期/异常通知，缺了就明确报错，不代填假地址
  if (method === 'http-01' && !email.trim()) {
    sslErrTo('ACME 签发需要账户邮箱')
    busy.value = false
    return
  }
  try {
    const r = await api.post<{ task_id?: string }>(
      API.sites.sslApply(s.id), { domains: s.domains, method, email: method === 'http-01' ? email.trim() : undefined })
    toast(method === 'self-signed'
      ? `已为 ${s.name} 签发面板自签证书（记得「重载」使配置生效）`
      : `已提交 ${s.name} 的 ACME 签发任务${r?.task_id ? `（${r.task_id}）` : ''}，可在任务中心查看进度`)
    sslModal.value = null
    if (method === 'self-signed') await load()
  } catch (e) {
    // 能力未接入属于"还没装上"，沿用绿色提示语义；真出错才是红色。
    if (isUnsupported(e)) sslErrTo('当前环境未接入证书签发能力（需 openssl 或 ACME）', true)
    else sslErrTo(errorText(e))
  } finally { busy.value = false }
}

// ── 证书续期（自签同步 / ACME 任务化）/ 删除（纯数据操作）──
const delCert = ref<Cert | null>(null)
async function renewCert(c: Cert) {
  busy.value = true; error.value = ''
  let ok = ''
  try {
    await api.post(API.certs.renew(c.id), {})
    ok = `已续期 ${c.domain} 的证书`
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入证书续期能力', true)
    else sslErrTo(errorText(e))
  } finally { busy.value = false; await load(); if (ok) toast(ok) }
}
async function setAutoRenew(c: Cert, val: boolean) {
  busy.value = true; error.value = ''
  try {
    await api.patch(API.certs.autoRenew(c.id), { enabled: val })
    c.auto_renew = val
    toast(`${c.domain} 自动续期已${val ? '开启' : '关闭'}`)
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入 ACME，无法自动续期')
    else sslErrTo(errorText(e))
  } finally { busy.value = false }
}
async function doDeleteCert() {
  if (!delCert.value) return
  busy.value = true; error.value = ''
  const dom = delCert.value.domain
  try {
    await api.del(API.certs.remove(delCert.value.id))
    delCert.value = null
    await load()
    toast(`已删除证书 ${dom}`)
  } catch (e) {
    // 同 doDelete：失败必须关确认框，否则错误落在遮罩之后、表现为"点了没反应"
    delCert.value = null
    sslErrTo(errorText(e))
  } finally { busy.value = false }
}

// ── 站点原始配置（编辑弹窗内「站点配置（Nginx）」区）：查看 / 编辑 / 按表单重新生成 ──
//
// 这份文件是「表单 → render → 校验 → 下发」的**产物**。手动维护（后端 manual_conf）
// 让用户直接改这份产物成为一等状态：保存成功后表单「保存并应用」不再覆盖它，
// 直到「按表单重新生成」按表单重新渲染覆盖（或停用/重新启用清零标记）。
// 路径唯一来源是后端按落库 conf_path 的返回——前端**不拼路径**，后端也拒绝前端传路径。
const confLoading = ref(false)
/** 配置文件落盘路径；null = 尚未下发（停用态或从未 apply） */
const confPath = ref<string | null>(null)
/** 编辑区内容（与原文件同构；保存时原样提交） */
const confText = ref('')
/** 站点是否处于「手动维护」（后端 manual_conf） */
const confManual = ref(false)
/**
 * 本区块**独立**的错误位（与弹窗顶部 formError 分开）：
 * 配置区校验失败时，错误必须落在**配置区自己身上**——用户正在看的就是这段文本，
 * 甩到弹窗顶部等于让人自己去找是哪儿写坏了。
 */
const confErr = ref('')
const confBusy = ref(false)
/** 「按表单重新生成」二次确认（覆盖手工内容；覆盖前自动备份，但仍不可逆） */
const confAsk = ref(false)
/** 未同步（后端 stale，017 迁移）：表单规格与磁盘配置不一致——面板所见 ≠ nginx 实际生效 */
const confStale = ref(false)
/** 外部修改（020）：磁盘内容与最后一次留档不一致——文件在面板之外被改过 */
const confExternal = ref(false)
/** 保存二选一弹窗：手动维护站点 + 表单改动了影响配置的字段（或已未同步） */
const saveAsk = ref(false)
/** 表单规格基线（openEdit 时快照）：判断「本次编辑是否改了影响配置的字段」 */
const confSpecBase = ref('')
/** 原始配置编辑仅 owner 可保存（后端 403 同口径）；管理员可看不可写。 */
const isOwner = computed(() => auth.me?.role === 'owner')

const confHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可保存原始配置'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  if (!editing.value?.enabled) return '站点已停用（配置已移除）；先在下方勾选「启用」并保存，再回来编辑'
  return '保存到磁盘并重载（保存前自动做配置校验；失败不会动旧文件）'
})

/** 当前编辑中的配置字节数（UTF-8）：给超长配置一个可感知的量级（后端上限 64 KiB）。 */
const confSize = computed(() => new TextEncoder().encode(confText.value).length)
/** 接近 64 KiB 上限时警示（后端对该值做权威校验，这里只是提前提醒）。 */
const confTooBig = computed(() => confSize.value > 64 * 1024)

/** 「按表单重新生成」的提示：与「保存配置」后果完全不同，不能共用 confHint。 */
const regenHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可重新生成配置'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  return '按当前表单重新渲染并覆盖磁盘上的这份配置：丢弃手工修改（覆盖前自动备份到服务器），站点恢复为面板托管'
})

/** 「保存手动维护的站点」二选一的说明文案（conf_stale 时点明现状）。 */
const saveAskLead = computed(() => {
  const n = editing.value?.name ?? '该站点'
  const why = confSpecChanged()
    ? '检测到表单中影响配置的字段有变更。'
    : '该站点此前已处于「未同步」状态（表单与磁盘配置不一致）。'
  return `「${n}」处于手动维护：「保存并应用」不会自动更新磁盘上的 Nginx 配置。${why}`
    + '「按表单重新生成」会用当前表单覆盖配置（原手动配置先自动备份）；'
    + '「仅保存」只把表单值入库、配置文件保持不变（站点会标记「未同步」）。'
})

/**
 * 表单规格的本地指纹：仅用于 save() 判断「本次编辑是否改了影响配置的字段」，
 * 决定手动维护站点保存前是否弹二选一。
 *
 * ⚠ 字段清单与后端 `deploy_fingerprint`（panel-api/routes/sites.rs）保持一致——
 *   两边新增「影响 render 输出」的字段时必须同步加，否则该字段改动不触发保存时
 *   弹窗（兜底：后端 conf_stale 仍会把它标成「未同步」，属事后提醒而非漏报）。
 */
function confSpecNow(): string {
  return JSON.stringify([
    form.value.name.trim(),
    form.value.domains.trim(),
    form.value.root.trim(),
    form.value.kind,
    !!form.value.spa,
    form.value.upstreams.split(/[,\s]+/).filter(Boolean),
    form.value.fpm.trim(),
    form.value.redirectTarget.trim(),
    form.value.redirectCode,
    form.value.wafOn,
    form.value.wafProfile,
    form.value.wafRate,
    form.value.wafBurst,
    form.value.routes.map(rowToRoute),
    // 019：片段也是渲染输出的一部分（插在 server 块尾）——不进指纹的话，手动站点
    // 只改片段后保存不会弹二选一、磁盘文件静默不动（后端 018 起指纹同款含它）。
    form.value.customConf,
    // 高级配置（020）：同样改变渲染输出，漏了就不会弹「未同步」二选一
    form.value.wwwRedirect,
    form.value.tlsProfile,
    form.value.tlsMin,
    form.value.hsts,
    form.value.hstsMaxAge,
    form.value.hstsSub,
    form.value.hstsPreload,
    form.value.rewritePreset,
    form.value.rewriteCustom,
  ])
}
/** 本次编辑是否改了影响配置的字段（基线在 openEdit 快照；新建站点恒 false）。 */
function confSpecChanged(): boolean {
  return confSpecBase.value !== '' && confSpecNow() !== confSpecBase.value
}

// 保存二选一弹窗的通用弹窗行为（Esc / 焦点陷阱 / 离场动画）——与全站弹窗同规。
const saveAskBox = ref<HTMLElement | null>(null)
const { close: closeSaveAsk } = useModal(() => saveAsk.value, saveAskBox, () => { saveAsk.value = false })

/** 清空本区块状态（重新打开编辑弹窗时调用，避免上一站点的内容/报错残留）。 */
function resetConf() {
  confPath.value = null; confText.value = ''; confManual.value = false
  confErr.value = ''; confBusy.value = false; confAsk.value = false
  confStale.value = false; saveAsk.value = false; confExternal.value = false
  // 版本面板同样归零：上一站点展开的列表/报错/详情不能残留到下一个站点
  versOpen.value = false; versList.value = []; versErr.value = ''
  versOpenId.value = null; versDetail.value = null
  versLoading.value = false; rollbackTarget.value = null
}

/** 拉取当前站点配置（打开编辑弹窗时调用；失败落本区块错误位，不阻塞弹窗其它功能）。 */
async function loadConf(id: number) {
  confLoading.value = true; confErr.value = ''
  try {
    const d = await api.get<{ path: string | null; content: string | null; manual: boolean; stale: boolean; external?: boolean }>(
      API.sites.conf(id))
    confPath.value = d.path ?? null
    confText.value = d.content ?? ''
    confManual.value = d.manual
    // stale：表单规格 vs 磁盘配置的指纹不一致（后端 017）——面板所见 ≠ nginx 实际生效
    confStale.value = d.stale
    confExternal.value = !!d?.external
  } catch (e) {
    confErr.value = errorText(e)
  } finally { confLoading.value = false }
}

/**
 * 配置区错误文案：40002（nginx -t 校验失败）**必须透出原始输出**。
 *
 * errorText 的 40002 分支只给一句「配置校验未通过」——对表单保存够用，但对
 * 正在直接编辑原文的用户等于没有信息：人要知道的是「哪一行、什么错」。nginx 的
 * 原始输出正是那个可执行的答案（如 `nginx: [emerg] unexpected "}" ...:42`），
 * 属**命令诊断输出**而非内部英文标识，透出是刻意为之（后有 CJK 兜底纪律约束其它分支）。
 */
function confErrText(e: unknown) {
  if ((e as { code?: number } | null)?.code === 40002) {
    const out = (e as { detail?: { output?: unknown } }).detail?.output
    const s = typeof out === 'string' ? out.trim() : ''
    if (s) return `配置校验未通过（${webName.value}）：\n${s}`
  }
  return errorText(e)
}

/** 保存原始配置 → 转「手动维护」。门控前置（能力位 + 权限 + owner），否则只等来 501/403。 */
async function saveConf() {
  if (!editing.value || !canManage.value || !isOwner.value || !webSupported.value) return
  if (!editing.value.enabled) { confErr.value = '站点已停用（配置已移除），请先启用并保存后再编辑'; return }
  if (!confText.value.trim()) { confErr.value = '配置内容不能为空'; return }
  confBusy.value = true; confErr.value = ''
  try {
    const d = await api.put<{ path: string; manual: boolean; stale?: boolean; reloaded: boolean }>(
      API.sites.conf(editing.value.id), { content: confText.value })
    confPath.value = d?.path ?? confPath.value
    confManual.value = !!d?.manual
    // 保存原文 = 文件与表单在当前时刻对齐（后端快照即当前指纹）→ 未同步解除
    confStale.value = !!d?.stale
    toast('站点配置已保存并重载；此后表单「保存并应用」不再覆盖该文件')
    await load(true)
    if (versOpen.value) await loadVersions()  // 本次保存已留档新版本——展开的列表同步刷新
  } catch (e) {
    confErr.value = confErrText(e)
    errSeq.value++  // 重建错误条，抖动动画可重播（与表单错误同一机制）
  } finally { confBusy.value = false }
}

/** 按表单重新生成：按表单规格重新渲染覆盖（丢弃手工内容，覆盖前自动备份），成功后重新拉取本区内容。 */
async function restoreConf() {
  if (!editing.value || !canManage.value || !isOwner.value || !webSupported.value) return
  confAsk.value = false
  confBusy.value = true; confErr.value = ''
  try {
    const d = await api.post<{ backup?: string | null }>(API.sites.confRestore(editing.value.id), {})
    // 备份是安全网：有/无都要如实说（无 = 文件缺失或备份失败，审计日志已记录）
    toast(d?.backup
      ? '已按表单重新生成配置并下发（原手动配置已自动备份）'
      : '已按表单重新生成配置并下发（注意：原配置备份失败，手工修改未留存副本）')
    const id = editing.value.id
    await loadConf(id)
    await load(true)
    if (versOpen.value) await loadVersions()  // 重新生成同样在版本链留档
  } catch (e) {
    confErr.value = confErrText(e)
    errSeq.value++
  } finally { confBusy.value = false }
}

// ── 配置历史版本与回滚（018 迁移）──
//
// 每次成功写盘——保存并应用（apply）、按表单重新生成（regen）、手动保存（manual）、
// 回滚（rollback）——都会把「当时落盘的内容」留档（每站保留最近 20 版，同内容去重）。
// 回滚 = nginx -t 校验 → 现场留档 → 原子替换 → reload → 按「版本指纹 vs 当前表单
// 指纹」自动定态（一致 ⇒ 面板托管；否则转手动维护）。属 root 级写入面，仅 owner。

/** 版本面板是否展开（懒加载：首次展开才拉列表——不进弹窗就不发请求） */
const versOpen = ref(false)
const versLoading = ref(false)
/** 版本列表的独立错误位：加载/回滚失败只染红这一块，不该泼到整个配置区 */
const versErr = ref('')
const versList = ref<ConfVersion[]>([])
/** 正在展开查看正文的版本 id（null = 全部收起） */
const versOpenId = ref<number | null>(null)
const versDetailLoading = ref(false)
const versDetail = ref<ConfVersionDetail | null>(null)
/** 回滚二次确认的目标版本（ConfirmDialog 的 open 判据） */
const rollbackTarget = ref<ConfVersion | null>(null)

/** 版本来源 → 中文名（键 = 后端落库值 source，勿写成展示口径）。 */
function versSourceLabel(s: string) {
  if (s === 'apply') return '保存并应用'
  if (s === 'regen') return '重新生成'
  if (s === 'manual') return '手动保存'
  if (s === 'rollback') return '回滚'
  return s
}

/** 字节数的紧凑展示（版本行空间小，不做 KB/MB 自适应堆叠）。 */
function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

async function toggleVersions() {
  versOpen.value = !versOpen.value
  if (versOpen.value && !versList.value.length && !versLoading.value) await loadVersions()
}

async function loadVersions() {
  if (!editing.value) return
  versLoading.value = true; versErr.value = ''
  try {
    const d = await api.get<{ items: ConfVersion[] }>(API.sites.confVersions(editing.value.id))
    versList.value = d.items ?? []
  } catch (e) {
    versErr.value = confErrText(e)
  } finally { versLoading.value = false }
}

/** 展开 / 收起某版本正文（按需单取——列表不一次拉 20 份全文）。 */
async function toggleVersDetail(v: ConfVersion) {
  if (!editing.value) return
  if (versOpenId.value === v.id) { versOpenId.value = null; return }
  versOpenId.value = v.id
  versDetail.value = null
  versDetailLoading.value = true; versErr.value = ''
  try {
    versDetail.value = await api.get<ConfVersionDetail>(API.sites.confVersion(editing.value.id, v.id))
  } catch (e) {
    versErr.value = confErrText(e)
    versOpenId.value = null
  } finally { versDetailLoading.value = false }
}

/** 回滚按钮的禁用原因（tooltip）；可执行时讲清动作与后果。 */
function rollbackHint(v: ConfVersion): string {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可回滚配置（原始配置文本属 root 级写入面）'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  if (!editing.value?.enabled) return '站点已停用（配置已移除）；请先启用并保存后再回滚'
  if (v.current) return '该版本与磁盘上的当前文件一致，无需回滚'
  return `回滚到 ${fmtDateTime(v.created_at)} 的这版（${versSourceLabel(v.source)}）：先做配置校验，替换前把当前文件留档进版本链（可再次回滚找回），然后重载生效`
}

/** 回滚（二次确认后执行）：成功后整区重取——磁盘内容、手动/未同步态、版本列表。 */
async function doRollback() {
  if (!editing.value || !rollbackTarget.value) return
  if (!canManage.value || !isOwner.value || !webSupported.value) return
  const id = editing.value.id
  const vid = rollbackTarget.value.id
  rollbackTarget.value = null
  confBusy.value = true; confErr.value = ''; versErr.value = ''
  try {
    const d = await api.post<{ path: string; manual: boolean; stale: boolean; reloaded: boolean }>(
      API.sites.confRollback(id), { version_id: vid })
    confPath.value = d?.path ?? confPath.value
    confManual.value = !!d?.manual
    confStale.value = !!d?.stale
    toast(d?.manual
      ? '已回滚到所选版本并重载；内容与当前表单不一致，站点转入「手动维护」（表单再变更会标「未同步」）'
      : '已回滚到所选版本并重载；站点保持面板托管')
    await loadConf(id)
    await loadVersions()
    await load(true)
  } catch (e) {
    versErr.value = confErrText(e)
    errSeq.value++
  } finally { confBusy.value = false }
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
    <div v-if="loading && !sites.length" class="skeleton box" />
    <div v-else-if="sites.length" class="card flush toolbar-card">
      <!-- 页级筛选与动作收进卡顶栏：它们过滤 / 操作的就是这张表；原先单独占一条
           页面级横条时，横条本身比「搜索框」这个内容还重。 -->
      <div class="card-toolbar">
        <!-- 本地检索：站点一多就只能肉眼扫表，加一个按名称/域名过滤的框成本最低 -->
        <input v-model="q" class="site-search" type="search" placeholder="搜索名称或域名…" aria-label="搜索站点" />
        <span class="count">共 {{ sites.length }} 个站点</span>
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
              <button class="btn-ghost btn-sm" :disabled="!sslReady || busy" :title="sslReady ? '为该站点申请 / 续签证书' : sslHint" @click="applySsl(s)"><Icon name="lock" :size="13" /><span class="btn-label">证书</span></button>
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

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="modalOpen" class="mask" @click.self="modalClose">
      <div ref="modalBox" class="modal wide site-modal" role="dialog" aria-modal="true">
        <!-- 标题行（公共 .modal-head，吸顶）里顺带承载通用错误条：只放**归属不到具体
             输入框**的错误。字段级错误各自挂在对应输入框旁（靠各 label 的 data-f 定位），
             不在这里重复——此前所有错误一律压在弹窗最底部，用户在中部滚动时点保存根本
             看不到，只能反复点。
             ⚠️ 错误条放在 head **内部**而不是做成另一个 sticky 元素：两个 sticky 都贴顶
             会互相盖住；放进同一容器则整体吸顶，也不需要估算 head 高度的魔法数字。
             `:key` 绑 errSeq：连点保存时元素重建，抖动动画得以重播，不会"点了没反应"。 -->
        <div class="modal-head">
          <h3 class="modal-title">{{ editing ? '编辑站点' : '新建站点' }}</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
            <Icon name="close" :size="16" />
          </button>
          <p v-if="formError" :key="'fe' + errSeq" class="err-bar form-msg" role="alert">
            <Icon name="alert" :size="15" class="ic" /><span>{{ formError }}</span>
          </p>
        </div>
      <div class="modal-mid">
        <nav class="nav-rail" aria-label="编辑分区">
          <button v-for="s in navSections" :key="s.id" type="button" class="nav-item"
            :class="{ active: activeSec === s.id, 'has-err': secErrs[s.id] }"
            :title="secErrs[s.id] ? '该分区内有字段未填对' : s.label"
            @click="scrollToSec(s.id)">{{ s.label }}<i v-if="secErrs[s.id]" class="nav-dot" aria-hidden="true" /></button>
        </nav>
        <div ref="modalBody" class="modal-body" @scroll="onBodyScroll">
        <!-- 未接入底座时：站点仍可登记，但配置下发不了。如实说明，不装作能开 -->
        <div v-if="!webSupported" class="hint-note is-warn">
          <Icon name="alert" :size="15" class="ic" />
          <span>未接入 Web 服务器：<b>只能保存站点登记信息，无法下发配置</b>；
            下方的类型 / 反代 / PHP / WAF 也需底座才能生效。</span>
        </div>
        <section class="sector" id="sec-basic">
          <h4 class="sector-h">基础信息</h4>
        <label class="blk" :class="{ 'has-err': fieldErrs.name }" data-f="name"
          title="站点标识，用作配置文件名与默认目录；仅小写字母、数字、连字符（如 my-site）">名称
          <input v-model="form.name" placeholder="my-site" :aria-invalid="!!fieldErrs.name"
            @input="clearFieldErr('name')" />
          <span v-if="fieldErrs.name" :key="'name' + errSeq" class="field-err">{{ fieldErrs.name }}</span>
        </label>
        <label class="blk"
          title="单路由=整站一种处理方式；多路由=按 URL 前缀分派到不同后端或目录">类型
          <select v-model="form.kind" :disabled="!webSupported">
            <option value="static">静态</option>
            <option value="proxy">反向代理 / 负载均衡</option>
            <option value="php">PHP (php-fpm)</option>
            <option value="redirect">整站重定向</option>
            <option value="routed">多路由（按前缀分派）</option>
          </select>
        </label>
        <label class="blk full" :class="{ 'has-err': fieldErrs.domains }" data-f="domains"
          title="可填多个，逗号分隔；须解析到本机 IP，否则 HTTPS 证书申请可能失败">域名（逗号分隔）
          <input v-model="form.domains" placeholder="example.com, www.example.com"
            :aria-invalid="!!fieldErrs.domains" @input="clearFieldErr('domains')" />
          <span v-if="fieldErrs.domains" :key="'domains' + errSeq" class="field-err">{{ fieldErrs.domains }}</span>
        </label>
        <label class="blk full" :class="{ 'has-err': fieldErrs.root }" data-f="root"
          title="站点文件的物理目录；留空则用站点名，且必须位于站点根目录内（防路径穿越）">根目录（留空用站点名，须落在站点根目录内）
          <div class="dir-row">
            <input v-model="form.root" placeholder="留空则用站点名" :aria-invalid="!!fieldErrs.root"
              @input="clearFieldErr('root')" />
            <button type="button" class="btn-ghost btn-sm" @click="pickerOpen = true">
              <Icon name="folder" :size="13" /> 浏览…
            </button>
          </div>
          <!-- 硬约束「必须落在站点根目录内」此前只写在 title 里——用户填错只能等后端 50001。
               后端下发了 siteRoot 就常驻展示边界（旧后端无此端点时不显示）。 -->
          <span v-if="siteRoot" class="root-hint dim tiny">站点根目录：<code class="mono">{{ siteRoot }}</code>（须落在其中）</span>
          <span v-if="fieldErrs.root" :key="'root' + errSeq" class="field-err">{{ fieldErrs.root }}</span>
        </label>
        <!-- 对象说明（备注，022）：便签式内联编辑，独立于大表单保存——保存站点要走
             nginx 校验与下发，一句备注不该拖住整张表单。新建时暂无 id，不渲染。 -->
        <div v-if="editing" class="blk full">
          <span class="remark-lb">备注（这台站点干嘛的）</span>
          <InlineRemark :model-value="form.remark" :editable="canManage"
            :saver="saveRemark" placeholder="如：客户的官网，PHP 版本锁 7.4 不能动" />
        </div>
        <!-- 应用模板：Node / Java / Python / .NET 在 nginx 这一层接入方式完全相同
             （都是 proxy_pass 到本机端口），差异只在运行时与启动命令——故做成预填
             模板，而不是给 SiteKind 加 4 个产出同一份配置的变体。
             再点同一个 chip 可取消选择；手改过「后端」后切模板不会覆盖你填的内容。 -->
        <!-- 「启用」是站点级全局属性，此前排在弹窗最底部（Nginx 原文编辑器之后）、
             不属于任何导航分区——要滚过整份配置才找得到，rail 上也没有入口。 -->
        <label class="blk full row-inline">
          <input type="checkbox" v-model="form.enabled" />
          <span>启用（纳入 Web 服务器配置）</span>
        </label>
        <div class="hint-note" :class="{ 'is-warn': !!editing }">
          <Icon name="info" :size="15" class="ic" />
          <span>{{ editing
            ? '保存后立即生效：取消勾选会从 Web 服务器移除该站点配置并重载，站点随即停止对外服务；重新勾选则按当前设置重新下发。'
            : '保存即下发：站点会立即对外服务。取消勾选则只登记站点、不下发配置。' }}</span>
        </div>
        </section>
        <section class="sector" id="sec-routing">
          <h4 class="sector-h">路由与后端</h4>
        <div v-if="form.kind === 'proxy'" class="tpl-row">
          <span class="tpl-label">应用模板</span>
          <button v-for="t in APP_TEMPLATES" :key="t.key" type="button" class="tpl-chip"
            :class="{ 'is-on': appTpl === t.key, 'is-warn': appTpl === t.key && tplRuntimeMissing }"
            :disabled="!webSupported" :title="`默认端口 ${t.port}｜启动命令 ${t.startCmd}`"
            @click="useTemplate(t)">{{ t.label }}<em>:{{ t.port }}</em></button>
        </div>
        <p v-if="form.kind === 'proxy' && curTpl" class="hint-note tpl-note">
          <Icon name="info" :size="14" class="ic" />
          <span>启动命令 <b>{{ curTpl.startCmd }}</b>（{{ curTpl.typical }}）<template
            v-if="curTpl.runtimePkg && runtimeDetectable">；系统包 <b :class="{ 'is-warn': tplRuntimeMissing }">{{
            curTpl.runtimePkg }}{{ tplRuntimeMissing ? ' 未装，可到「软件」页装' : ' 已装' }}</b></template>。
            模板只预填反代目标，<b>不会创建应用进程</b>——进程请到「服务」页托管（systemd），或用「容器」页跑 Docker。</span>
        </p>
        <label v-if="form.kind === 'proxy'" class="blk full" :class="{ 'has-err': fieldErrs.upstreams }" data-f="upstreams"
          title="上游服务地址，逗号分隔可负载均衡；格式 http://127.0.0.1:3000">后端（逗号分隔）
          <input v-model="form.upstreams" :disabled="!webSupported" :aria-invalid="!!fieldErrs.upstreams"
            placeholder="http://127.0.0.1:3000, http://127.0.0.1:3001" @input="clearFieldErr('upstreams')" />
          <span v-if="fieldErrs.upstreams" :key="'upstreams' + errSeq" class="field-err">{{ fieldErrs.upstreams }}</span>
        </label>
        <label v-if="form.kind === 'php'" class="blk full" :class="{ 'has-err': fieldErrs.fpm }" data-f="fpm"
          title="PHP-FPM 监听地址；unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000">php-fpm
          <input v-model="form.fpm" :disabled="!webSupported" :aria-invalid="!!fieldErrs.fpm"
            placeholder="unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000" @input="clearFieldErr('fpm')" />
          <span v-if="fieldErrs.fpm" :key="'fpm' + errSeq" class="field-err">{{ fieldErrs.fpm }}</span>
        </label>
        <!-- SPA history 路由回退：仅 static 类型有意义。开启后 nginx 用
             `try_files $uri $uri/ /index.html` 兜底，配合前端 history 模式单页应用。
             对反代 / PHP / 重定向类型无意义，故仅 static 时显示。 -->
        <label v-if="form.kind === 'static'" class="blk row-inline"
          title="开启后未命中文件回退到 /index.html，适用于 Vue/React 等 history 模式单页应用">
          <input type="checkbox" v-model="form.spa" :disabled="!webSupported" />
          <span>SPA 回退（history 路由兜底到 index.html）</span>
        </label>
        <!-- 整站重定向：仅 redirect 类型有意义。目标须 http(s):// 开头（后端校验），
             状态码限 301/302/307/308；$request_uri 自动追加，无需手填路径。 -->
        <template v-if="form.kind === 'redirect'">
          <label class="blk full" :class="{ 'has-err': fieldErrs.redirectTarget }" data-f="redirectTarget"
            title="访问该站点时跳转到的目标 URL，须以 http(s):// 开头">重定向目标 URL
            <input v-model="form.redirectTarget" :disabled="!webSupported" :aria-invalid="!!fieldErrs.redirectTarget"
              placeholder="https://example.com" @input="clearFieldErr('redirectTarget')" />
            <span v-if="fieldErrs.redirectTarget" :key="'rt' + errSeq" class="field-err">{{ fieldErrs.redirectTarget }}</span>
          </label>
          <label class="blk" :class="{ 'has-err': fieldErrs.redirectCode }" data-f="redirectCode"
            title="301/308 永久（可被缓存）；302/307 临时（保留请求方法）">状态码
            <select v-model.number="form.redirectCode" :disabled="!webSupported" @change="clearFieldErr('redirectCode')">
              <option :value="301">301 永久</option>
              <option :value="302">302 临时</option>
              <option :value="307">307 临时（保留方法）</option>
              <option :value="308">308 永久（保留方法）</option>
            </select>
            <span v-if="fieldErrs.redirectCode" :key="'rc' + errSeq" class="field-err">{{ fieldErrs.redirectCode }}</span>
          </label>
        </template>

        <!-- 多路由：一个站点内按 URL 前缀分派。渲染为多条 `location ^~ <前缀>`——
             用 ^~（而非正则）是刻意的：前缀一旦 ^~ 就永不再走正则，于是「用户写的
             前缀」与「deny/WAF 的正则规则」的优先级变得确定，不取决于书写顺序。 -->
        <div v-if="form.kind === 'routed'" class="routes" data-f="routes" :class="{ 'has-err': fieldErrs.routes }">
          <div class="routes-head">
            <span class="routes-title">路由表<em>按前缀长度降序匹配；必须有一条 / 兜底</em></span>
            <button type="button" class="btn-ghost btn-sm" @click="addRoute()">
              <Icon name="plus" :size="13" /> 添加路由
            </button>
          </div>
          <div v-for="(r, i) in form.routes" :key="i" class="route-row">
            <input v-model="r.prefix" class="rt-prefix" placeholder="/api" :aria-label="`第 ${i + 1} 条路由的前缀`" />
            <select v-model="r.kind" class="rt-kind" :aria-label="`第 ${i + 1} 条路由的类型`">
              <option value="static">静态</option>
              <option value="proxy">反向代理</option>
              <option value="php">PHP</option>
            </select>
            <input v-if="r.kind === 'proxy'" v-model="r.upstreams" class="rt-target"
              placeholder="http://127.0.0.1:3000" :aria-label="`第 ${i + 1} 条路由的后端`" />
            <input v-else-if="r.kind === 'php'" v-model="r.fpm" class="rt-target"
              placeholder="unix:/run/php/php8.2-fpm.sock" :aria-label="`第 ${i + 1} 条路由的 php-fpm`" />
            <template v-else-if="r.kind === 'static'">
              <label class="rt-root" :title="'留空则用站点根目录；填了则这条静态路由从它自己的目录读文件'">
                <input v-model="r.root" class="rt-target" placeholder="留空=站点根目录"
                  :aria-label="`第 ${i + 1} 条路由的根目录`" />
                <button type="button" class="btn-ghost btn-sm rt-dir" :disabled="!canManage"
                  @click="openRouteRootPicker(i)" :aria-label="`浏览第 ${i + 1} 条路由的根目录`">
                  <Icon name="folder" :size="13" /> 目录
                </button>
              </label>
              <label class="rt-spa" :title="'未命中文件时回退到 /index.html（history 路由单页应用）'">
                <input type="checkbox" v-model="r.spa" /> SPA
              </label>
            </template>
            <input v-if="r.kind === 'php'" v-model="r.frontController" class="rt-target"
              placeholder="/public/index.php" :disabled="isCaddy"
              :title="isCaddy ? 'Caddy 下路由型 PHP 的入口脚本精确语义尚未实装，已置灰' : ''"
              :aria-label="`第 ${i + 1} 条路由的入口脚本`" />
            <button type="button" class="btn-ghost btn-sm rt-del" title="删除该路由"
              :disabled="form.routes.length <= 1" @click="removeRoute(i)">
              <Icon name="trash" :size="13" />
            </button>
          </div>
          <p class="field-err" v-if="fieldErrs.routes">{{ fieldErrs.routes }}</p>
          <p class="hint-note routes-note">
            <Icon name="info" :size="14" class="ic" />
            <span>典型用法：<b>/</b> 静态（SPA）+ <b>/api</b> 反代到后端；静态路由可**单独指定根目录**
              （如 <code>/</code> 前端产物 + <code>/blog</code> 另一套静态站，各自独立目录）。
              PHP 路由需填 <b>入口脚本</b>（如 <code>/public/index.php</code>）——多路由下不用
              <code>.php</code> 后缀匹配，而是把整个前缀交给该入口，由框架自己路由。</span>
          </p>
        </div>

        <!-- WAF：站点配置的一部分，与其它字段**同一次下发**，故同处一个表单 -->
        </section>
        <section class="sector" id="sec-secure">
          <h4 class="sector-h">安全与性能</h4>
        <div class="waf">
          <label class="inline" title="在被管理站点前生成拦截规则；规则集由系统内置，此处只能选档位与数值">
            <input type="checkbox" v-model="form.wafOn" :disabled="!webSupported" /> 启用 WAF
          </label>
          <template v-if="form.wafOn">
            <label :class="{ 'has-err': fieldErrs.wafProfile }" data-f="wafProfile"
              title="内置规则集档位：基础覆盖常见注入/穿越；严格额外拦截空 UA 与非常见方法（误杀率更高）">档位
              <select v-model="form.wafProfile" :disabled="!webSupported" @change="clearFieldErr('wafProfile')">
                <option value="basic">基础（SQLi / XSS / 穿越 / 敏感文件 / 恶意 UA）</option>
                <option value="strict">严格（+ 空 UA、非白名单方法，误杀率更高）</option>
              </select>
              <span v-if="fieldErrs.wafProfile" :key="'wp' + errSeq" class="field-err">{{ fieldErrs.wafProfile }}</span>
            </label>
            <label :class="{ 'has-err': fieldErrs.wafRate, 'is-dim': isCaddy }" data-f="wafRate"
              :title="isCaddy ? caddyNoop : '单客户端每秒最大请求数；0 = 不限速'">CC 限速（次/秒，0 = 不限）
              <input v-model.number="form.wafRate" type="number" min="0" max="1000" :disabled="!webSupported || isCaddy"
                :aria-invalid="!!fieldErrs.wafRate" @input="clearFieldErr('wafRate')" />
              <span v-if="fieldErrs.wafRate" :key="'wr' + errSeq" class="field-err">{{ fieldErrs.wafRate }}</span>
            </label>
            <label :title="isCaddy ? caddyNoop : (form.wafRate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速，否则后端会拒绝')"
              :class="{ 'has-err': fieldErrs.wafBurst, 'is-dim': isCaddy }" data-f="wafBurst">
              突发桶（0 = 自动）
              <input v-model.number="form.wafBurst" type="number" min="0" max="10000"
                :disabled="!webSupported || !form.wafRate || isCaddy" :aria-invalid="!!fieldErrs.wafBurst"
                @input="clearFieldErr('wafBurst')" />
              <span v-if="fieldErrs.wafBurst" :key="'wb' + errSeq" class="field-err">{{ fieldErrs.wafBurst }}</span>
            </label>
          </template>
        </div>
        <!-- caddy：WAF **规则集档位生效、限速不生效**（标准版无 rate_limit 指令，
             需第三方模块）。如实写明，否则用户会以为填了就在防 CC。 -->
        <p v-if="isCaddy && form.wafOn" class="hint-note is-warn">
          <Icon name="info" :size="14" class="ic" />
          <span>当前 Web 服务器为 Caddy：<b>规则集档位生效、限速不生效</b>——标准 Caddy 无 rate_limit 指令。</span>
        </p>

        <!-- 自定义配置片段（019）：原始 nginx 文本，插在主 server 块尾部（所有
             location 之后）。属**托管态**——随「保存并应用」重新渲染下发（与
             「手动维护」互补：那个是整文件被接管、这个是被渲染进去的片段）。
             仅 owner 可改（写坏≈root 级事故，后端 403 / 64KiB 双护栏），其他人只读。 -->
        <div class="cc">
          <div class="cc-head">
            <span class="cc-title"><Icon name="edit" :size="14" /> 自定义配置片段</span>
            <span v-if="!isOwner" class="dim tiny">仅 owner 可编辑</span>
          </div>
          <textarea v-model="form.customConf" class="mono cc-text" rows="5" spellcheck="false"
            :readonly="!canManage || !isOwner" :disabled="!webSupported || isCaddy"
            :aria-invalid="!!fieldErrs.customConf" data-f="customConf"
            placeholder="例如：location /static/ { expires 7d; }"></textarea>
          <span v-if="fieldErrs.customConf" :key="'cc' + errSeq" class="field-err">{{ fieldErrs.customConf }}</span>
          <p class="hint-note cc-note">
            <Icon name="info" :size="14" class="ic" />
            <span>插入在 server 块<b>尾部</b>（所有 location 之后），随「保存并应用」重新渲染下发；下发前经配置校验——写错不会上线。留空 = 不使用。</span>
          </p>
          <p v-if="isCaddy" class="hint-note cc-note is-warn">
            <Icon name="info" :size="14" class="ic" />
            <span>当前 Web 服务器为 Caddy：自定义片段是<b>原始 nginx 语法</b>，与 Caddyfile 语法不同、无法透传，已置灰。</span>
          </p>
        </div>

        <!-- 高级配置（020）：www 跳转 / TLS 强化 / 伪静态。
             三类都是「字段固定、极易写错、出错后果严重」——手写 `if ($host …)` 有陷阱、
             ssl_ciphers 抄错会让老客户端连不上、rewrite 是新手最大的坑，故做成表单
             由渲染器产出。TLS 项仅在站点已有证书时才会写进配置（前端如实说明）。 -->
        <div class="adv">
          <div class="adv-head">
            <span class="adv-title"><Icon name="shield" :size="14" /> 高级配置</span>
          </div>
          <label class="blk adv-row" title="只对主域名生效：子域不会被一起改写">
            www 跳转
            <select v-model="form.wwwRedirect">
              <option value="off">不处理</option>
              <option value="to_www">裸域 → www（example.com → www.example.com）</option>
              <option value="to_bare">www → 裸域（www.example.com → example.com）</option>
            </select>
          </label>
          <label class="blk adv-row"
            :title="isCaddy ? '影响启用的 TLS 版本：Caddy 最低只支持 TLSv1.2，更低的档位会如实回落' : '影响 ssl_protocols：只有下限及以上会被启用'">
            TLS 版本下限
            <select v-model="form.tlsMin">
              <option value="TLSv1" :disabled="isCaddy">TLSv1（最老客户端，不安全{{ isCaddy ? '，Caddy 不支持' : '' }}）</option>
              <option value="TLSv1.1" :disabled="isCaddy">TLSv1.1{{ isCaddy ? '（Caddy 不支持）' : '' }}</option>
              <option value="TLSv1.2">TLSv1.2（推荐）</option>
              <option value="TLSv1.3">TLSv1.3（仅新客户端）</option>
            </select>
          </label>
          <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '影响 ssl_ciphers：档位越高越安全、老客户端越可能连不上'">
            加密套件档位
            <select v-model="form.tlsProfile" :disabled="isCaddy">
              <option value="compat">兼容（老客户端，含弱套件）</option>
              <option value="modern">现代（默认）</option>
              <option value="strict">严格（仅 TLSv1.3 + 前向保密）</option>
            </select>
          </label>
          <label class="blk row-inline" title="开启后浏览器在 max-age 内强制 HTTPS，服务端无法撤回">
            <input type="checkbox" v-model="form.hsts" />
            <span>启用 HSTS（浏览器强制 HTTPS，不可撤回）</span>
          </label>
          <template v-if="form.hsts">
            <label class="blk adv-row" title="默认 300 秒：先小步验证，确认无误再调大">
              有效期 max-age（秒）
              <input v-model.number="form.hstsMaxAge" type="number" min="0" max="63072000" />
            </label>
            <label class="blk row-inline" title="一并约束所有子域：确认全部子域都支持 HTTPS 再开">
              <input type="checkbox" v-model="form.hstsSub" /> <span>含子域（includeSubDomains）</span>
            </label>
            <label class="blk row-inline" title="申请进浏览器内置列表，几乎不可逆">
              <input type="checkbox" v-model="form.hstsPreload" /> <span>加入 preload 列表</span>
            </label>
            <p class="hint-note is-warn adv-warn">
              <Icon name="alert" :size="14" class="ic" />
              <span>HSTS 在 max-age 期间<b>无法从服务端撤回</b>：先用 300 秒验证，确认全站可用 HTTPS 后再调大；preload 更要三思。</span>
            </p>
          </template>
          <template v-if="form.kind === 'php'">
            <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
              :title="isCaddy ? caddyNoop : '预置模板替换默认的 try_files 兜底；不确定就选「无」'">
              伪静态模板
              <select v-model="form.rewritePreset" :disabled="isCaddy">
                <option value="none">无</option>
                <option value="wordpress">WordPress</option>
                <option value="laravel">Laravel</option>
                <option value="thinkphp">ThinkPHP（PATH_INFO）</option>
                <option value="typecho">Typecho</option>
                <option value="discuz">Discuz</option>
                <option value="custom">自定义…</option>
              </select>
            </label>
            <label v-if="form.rewritePreset === 'custom'" class="blk full adv-row"
              title="原样进 location / 内；上限 64 KiB">
              自定义 rewrite（location / 内）
              <textarea v-model="form.rewriteCustom" class="mono adv-text" rows="4" spellcheck="false"
                :disabled="isCaddy" placeholder="try_files $uri $uri/ /index.php?$args;"></textarea>
            </label>
          </template>
          <p class="hint-note adv-note">
            <Icon name="info" :size="14" class="ic" />
            <span>TLS 与 HSTS 仅在站点<b>已有证书</b>时才会写进配置；www 跳转与伪静态随「保存并应用」重新渲染。</span>
          </p>
        </div>

        <!-- 访问控制 / 反代增强（021）：三类「字段固定、极易写错、后果严重」——
             IP 黑白名单顺序匹配、Basic Auth 口令落盘、多后端负载策略，皆由渲染器产出。 -->
        <div class="adv">
          <div class="adv-head">
            <span class="adv-title"><Icon name="key" :size="14" /> 访问控制与反代</span>
          </div>
          <!-- IP 黑白名单（互斥：白名单非空时黑名单被忽略，对应 input 禁用） -->
          <label class="blk full adv-row" title="单 IP 或 CIDR（IPv4），逗号/空格分隔。白名单非空即只放行名单内、其余拒绝">
            IP 白名单（allow）
            <textarea v-model="form.ipAllow" class="mono adv-text" rows="2" spellcheck="false"
              :disabled="!!form.ipDeny.trim()" placeholder="192.168.1.10, 10.0.0.0/24"></textarea>
          </label>
          <label class="blk full adv-row" :class="{ 'is-dim': !!form.ipAllow.trim() }"
            title="单 IP 或 CIDR（IPv4）。白名单非空时被忽略">
            IP 黑名单（deny）
            <textarea v-model="form.ipDeny" class="mono adv-text" rows="2" spellcheck="false"
              :disabled="!!form.ipAllow.trim()" placeholder="1.2.3.4, 5.6.7.0/24"></textarea>
          </label>
          <p class="hint-note adv-note" v-if="form.ipAllow.trim()">
            <Icon name="info" :size="14" class="ic" />
            <span>已启用白名单：黑名单被忽略（白名单优先，名单外全部拒绝）。</span>
          </p>
          <!-- HTTP Basic Auth：口令不落库，仅设置时经 openssl 生成 apr1 摘要写入 htpasswd -->
          <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '开启后访问站点需输入用户名口令（口令不落库）'">
            <input type="checkbox" v-model="form.authBasic" :disabled="isCaddy" /> <span>启用 Basic Auth（HTTP 基础认证）</span>
          </label>
          <template v-if="form.authBasic">
            <label class="blk full adv-row" data-f="authUser" :class="{ 'has-err': fieldErrs.authUser }"
              title="Basic Auth 用户名（不能含冒号或空白）">
              用户名
              <input v-model="form.authUser" @input="clearFieldErr('authUser')" :disabled="isCaddy"
                :aria-invalid="!!fieldErrs.authUser" placeholder="admin" />
              <span v-if="fieldErrs.authUser" :key="'authUser' + errSeq" class="field-err">{{ fieldErrs.authUser }}</span>
            </label>
            <label class="blk full adv-row" data-f="authPass" :class="{ 'has-err': fieldErrs.authPass }"
              title="留空 = 保留现有口令（仅设置时经 openssl 生成摘要写入 htpasswd，不落库、不回显）">
              口令{{ editing ? '（留空保留）' : '' }}
              <input type="password" v-model="form.authPass" @input="clearFieldErr('authPass')" :disabled="isCaddy"
                :aria-invalid="!!fieldErrs.authPass" placeholder="********" />
              <span v-if="fieldErrs.authPass" :key="'authPass' + errSeq" class="field-err">{{ fieldErrs.authPass }}</span>
            </label>
          </template>
          <!-- 反代增强：仅 proxy 类型有意义（单后端无 upstream 块、策略不生效） -->
          <template v-if="form.kind === 'proxy'">
            <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
              :title="isCaddy ? caddyNoop : '多后端时的负载均衡策略'">
              负载均衡策略
              <select v-model="form.lbPolicy" :disabled="isCaddy">
                <option value="least_conn">最小连接（默认）</option>
                <option value="ip_hash">按客户端 IP 哈希</option>
              </select>
            </label>
            <label class="blk adv-row" title="与上游建连超时（秒，1~3600）">
              建连超时（秒）
              <input v-model.number="form.proxyConnectTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
            </label>
            <label class="blk adv-row" title="向上游发送超时（秒，1~3600）">
              发送超时（秒）
              <input v-model.number="form.proxySendTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
            </label>
            <label class="blk adv-row" title="从上游读取超时（秒，1~3600）">
              读取超时（秒）
              <input v-model.number="form.proxyReadTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
            </label>
          </template>
        </div>

        </section>
        <section class="sector" id="sec-ops">
          <h4 class="sector-h">日志与证书</h4>
        <!-- 站点日志（021）：独立 access/error 开关 + 级别 + 查看/下载/清空 -->
        <div class="adv">
          <div class="adv-head">
            <span class="adv-title"><Icon name="file" :size="14" /> 站点日志</span>
          </div>
          <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '开启后由面板指定路径记录本站访问日志，可查看/下载/清空'">
            <input type="checkbox" v-model="form.logAccess" :disabled="isCaddy" /> <span>记录访问日志（access.log）</span>
          </label>
          <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '开启后由面板指定路径记录本站错误日志'">
            <input type="checkbox" v-model="form.logError" :disabled="isCaddy" /> <span>记录错误日志（error.log）</span>
          </label>
          <label class="blk adv-row" v-if="form.logError" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '错误日志级别'">
            错误级别
            <select v-model="form.logErrorLevel" :disabled="isCaddy">
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="notice">notice</option>
              <option value="warn">warn</option>
              <option value="error">error（默认）</option>
              <option value="crit">crit</option>
              <option value="alert">alert</option>
              <option value="emerg">emerg</option>
            </select>
          </label>
          <div class="log-actions" v-if="editing">
            <button v-if="form.logAccess" class="btn-ghost btn-sm" :disabled="busy" type="button"
              @click="viewLog('access')"><Icon name="file" :size="13" /> 查看访问日志</button>
            <button v-if="form.logAccess" class="btn-ghost btn-sm" :disabled="busy" type="button"
              @click="clearLog('access')"><Icon name="trash" :size="13" /> 清空访问日志</button>
            <button v-if="form.logError" class="btn-ghost btn-sm" :disabled="busy" type="button"
              @click="viewLog('error')"><Icon name="file" :size="13" /> 查看错误日志</button>
            <button v-if="form.logError" class="btn-ghost btn-sm" :disabled="busy" type="button"
              @click="clearLog('error')"><Icon name="trash" :size="13" /> 清空错误日志</button>
          </div>
          <div class="log-confirm" v-if="clearAsk">
            <span>确定清空{{ clearAsk === 'access' ? '访问' : '错误' }}日志？将截断文件（保留并继续写入），不可恢复。</span>
            <button class="btn-ghost btn-sm" type="button" @click="clearAsk = null">取消</button>
            <button class="btn-danger btn-sm" type="button" :disabled="busy" @click="confirmClear">确认清空</button>
          </div>
          <p class="hint-note adv-note" v-if="!form.logAccess && !form.logError">
            <Icon name="info" :size="14" class="ic" />
            <span>未开启独立日志：站点沿用 Web 服务器全局日志（无法按站点查看/下载/清空）。</span>
          </p>
        </div>

        <!-- SSL 证书：站点配置的一部分，与站点同处一个编辑弹窗
             （此前是页面下方独立的「证书」区块——与应用站点配置同理，单独成块既多余、
              又让「该站点的证书」与「编辑该站点」割裂在两处；现在合并进来，
              申请 / 续期 / 删除 / 自动续期 / 信任根证书全在弹窗内完成）。
              仅编辑既有站点时出现：新建站点尚未落库、无法归属证书。 -->
        <div v-if="editing" class="ssl">
          <div class="ssl-head">
            <span class="ssl-title"><Icon name="lock" :size="14" /> SSL 证书</span>
            <button class="btn-primary btn-sm" :disabled="!sslReady" :title="sslReady ? '为当前站点申请证书' : sslHint" @click="applySslEditing">
              <Icon name="plus" :size="13" /> 申请证书
            </button>
          </div>
          <p class="cert-sweep dim tiny">自动续期扫描：{{ sweepSummary() }}</p>
          <div v-if="siteCerts.length" class="ssl-list">
            <div v-for="c in siteCerts" :key="c.id" class="ssl-row">
              <div class="ssl-meta">
                <span class="mono">{{ c.domain }}</span>
                <span class="dim tiny">{{ certSourceLabel(c.source) }} · 到期 {{ fmtDate(c.not_after) }} · <span :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</span></span>
              </div>
              <div class="ssl-ops">
                <span v-if="c.source === 'acme'" class="switch" :title="sslSupported ? '到期前 30 天内自动续期' : '需 ACME 支持'">
                  <input type="checkbox" :checked="c.auto_renew" :disabled="!sslSupported || busy" @change="setAutoRenew(c, ($event.target as HTMLInputElement).checked)" /><i />
                </span>
                <button class="btn-ghost btn-sm" :disabled="!sslReady" :title="sslReady ? '续期这张证书' : sslHint" @click="renewCert(c)"><Icon name="refresh" :size="13" /> 续期</button>
                <button class="btn-ghost btn-sm danger" :disabled="!canSsl"
            :title="canSsl ? '' : '无 ssl.manage 权限'" @click="delCert = c"><Icon name="trash" :size="13" /> 删除</button>
              </div>
            </div>
          </div>
          <EmptyState v-else title="暂无证书" hint="点上方「申请证书」为该站点签发（需 openssl 或 ACME）" />
          <button class="btn-ghost btn-sm ca-link" title="导入根证书后，全部本地 HTTPS 站点不再报「非私密连接」" @click="caHelp = true">
            <Icon name="lock" :size="13" /> 信任根证书
          </button>
        </div>

        <!-- 站点原始配置：查看 / 编辑原文 / 按表单重新生成。
             这份文件是「表单 → render → 校验 → 下发」的**产物**；「手动维护」让直接改
             产物成为一等状态——保存后表单「保存并应用」不再覆盖它（后端 manual_conf）。
             路径由后端按落库 conf_path 给出：前端不拼路径，后端也不接受前端传路径。
             仅编辑既有站点时出现：新建站点尚未落库、没有配置文件可读。 -->
        <div v-if="editing" class="conf">
          <div class="conf-head">
            <span class="conf-title">
              <Icon name="file" :size="14" /> 站点配置（Nginx）
              <span v-if="confManual" class="badge" :class="confStale ? 'badge-danger' : 'badge-warn'"
                :title="confStale
                  ? '表单规格已变更，但磁盘上的这份配置没有跟着更新——面板显示的将不是 nginx 实际生效的内容；点「按表单重新生成」同步'
                  : '已手动接管：表单「保存并应用」不会覆盖磁盘上的这份配置；点「按表单重新生成」交还控制权'">
                {{ confStale ? '未同步' : '手动维护' }}</span>
            </span>
            <span v-if="confLoading" class="dim tiny">读取中…</span>
            <span v-else class="mono dim tiny ellipsis conf-path"
              :title="confPath || '尚未下发：保存「并应用」后生成'">{{ confPath || '尚未下发' }}</span>
            <!-- 字节数：超长配置此前完全没有量级感知（后端 64 KiB 上限只在提交后才报错） -->
            <span v-if="!confLoading && confText" class="dim tiny conf-size"
              :class="{ 'is-warn-text': confTooBig }"
              :title="confTooBig ? '已超过 64 KiB 上限，保存会被后端拒绝' : '当前配置大小（后端上限 64 KiB）'">
              {{ fmtBytes(confSize) }}</span>
          </div>
          <!-- 未同步警示（后端 017 指纹判定）：表单规格与磁盘配置分叉时，先说清现状再给操作 -->
          <p v-if="confStale" class="hint-note is-warn conf-stale">
            <Icon name="info" :size="14" class="ic" />
            <span>表单中影响配置的字段（如 WAF／域名／根目录）已变更，磁盘上的这份配置<b>没有跟着更新</b>——当前面板显示的将不是 nginx 实际生效的内容。点「按表单重新生成」同步，或继续在此手动编辑原文件。</span>
          </p>
          <!-- 外部修改（020）：面板不静默覆盖——是人工有意、脚本误写还是攻击无从判断 -->
          <p v-if="confExternal" class="hint-note is-warn conf-external">
            <Icon name="alert" :size="14" class="ic" />
            <span>检测到<b>外部修改</b>：磁盘上的这份配置与面板最后一次下发的内容不一致（文件在面板之外被改过）。面板不会擅自覆盖它——可点「按表单重新生成」覆盖，或把需要的改动改写成上方的「自定义配置片段」。</span>
          </p>
          <!-- 读取失败要给重试出口：此前失败只留一条红字，编辑区仍是空白 + 「尚未下发」
               占位符，用户会误判成"这个站点确实没有配置文件"。 -->
          <div v-if="confErr" :key="'cf' + errSeq" class="err-bar conf-msg conf-fail" role="alert">
            <Icon name="alert" :size="14" class="ic" />
            <span>{{ confErr }}</span>
            <button class="btn-ghost btn-sm" type="button" :disabled="confLoading"
              @click="editing && loadConf(editing.id)">重试</button>
          </div>
          <!-- 只读态要说清**为什么**不能改：NginxEditor 只读时外观虽已变化（底纹变灰），
               但原因此前只藏在按钮 title 里。 -->
          <p v-if="!canManage || !isOwner || !webSupported" class="hint-note is-warn conf-ro">
            <Icon name="lock" :size="14" class="ic" />
            <span>{{ !webSupported ? '未接入 Web 服务器（nginx）：配置只读'
              : (!isOwner ? '仅 owner 可编辑原始配置（当前为只读）' : '无 site.manage 权限：配置只读') }}</span>
          </p>
          <NginxEditor v-model="confText" class="conf-editor" :rows="10" :spellcheck="false"
            :readonly="!canManage || !isOwner || !webSupported"
            :placeholder="confLoading ? '读取中…' : (confErr ? '（读取失败：请点上方「重试」）' : '（配置文件为空或尚未下发——先保存「并应用」生成）')"
            aria-label="站点 Nginx 配置原文" />
          <div class="conf-ops">
            <p class="hint-note conf-hint">
              <Icon name="info" :size="14" class="ic" />
              <span v-if="confManual">保存原文将直接生效（先跑 nginx -t，失败不动旧文件）。<b>按表单重新生成</b>会丢弃你对这份配置的手工修改，按表单重新渲染（覆盖前自动备份）。</span>
              <span v-else>保存原文将<b>接管</b>这份配置：此后表单「保存并应用」不再覆盖它，直到「按表单重新生成」交还。</span>
            </p>
            <div class="conf-btns">
              <button v-if="confManual" class="btn-ghost btn-sm"
                :disabled="confBusy || !isOwner || !webSupported"
                :title="regenHint" @click="confAsk = true">
                <Icon name="refresh" :size="13" /> 按表单重新生成
              </button>
              <button class="btn-ghost btn-sm"
                :disabled="confBusy || !canManage || !isOwner || !webSupported || !editing?.enabled"
                :title="confHint" @click="saveConf">
                <Icon name="check" :size="13" /> {{ confBusy ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </div>
          <!-- 历史版本与回滚（018）：每次成功写盘（保存并应用 / 重新生成 / 手动保存 /
               回滚）都会留档，每站保留最近 20 版。懒加载：展开才拉列表；正文按需单取。 -->
          <div class="vers">
            <button class="btn-ghost btn-sm vers-toggle" @click="toggleVersions">
              <Icon name="clock" :size="13" />
              {{ versOpen ? '收起历史版本' : '历史版本与回滚' }}
            </button>
            <div v-if="versOpen" class="vers-panel">
              <p v-if="versLoading" class="dim tiny">加载中…</p>
              <p v-else-if="versErr" :key="'ve' + errSeq" class="err-bar conf-msg" role="alert">{{ versErr }}</p>
              <p v-else-if="!versList.length" class="dim tiny">暂无历史版本：每次「保存并应用」、重新生成、手动保存与回滚都会在此留档（每站保留最近 20 版）。</p>
              <template v-else>
                <div v-for="v in versList" :key="v.id" class="vers-row">
                  <div class="vers-meta">
                    <span class="vers-src">{{ versSourceLabel(v.source) }}</span>
                    <span class="dim tiny vers-when">{{ fmtDateTime(v.created_at) }} · {{ v.operator }} · {{ fmtBytes(v.size) }}</span>
                    <span v-if="v.current" class="badge badge-ok vers-cur" title="该版本与磁盘上的当前文件一致">当前</span>
                  </div>
                  <div class="vers-ops">
                    <button class="btn-ghost btn-sm" @click="toggleVersDetail(v)">
                      {{ versOpenId === v.id ? '收起' : '查看' }}
                    </button>
                    <button class="btn-ghost btn-sm"
                      :disabled="confBusy || !isOwner || !webSupported || !editing?.enabled || v.current"
                      :title="rollbackHint(v)" @click="rollbackTarget = v">
                      <Icon name="restart" :size="13" /> 回滚
                    </button>
                  </div>
                  <pre v-if="versOpenId === v.id" class="vers-content mono">{{ versDetailLoading ? '加载中…' : (versDetail?.content ?? '') }}</pre>
                </div>
              </template>
            </div>
          </div>
        </div>

        </section>
        <!-- 「启用」开关已上移到「基础」分区（见 sec-basic）：它是站点级全局属性，
             摆在弹窗最底部、Nginx 原文编辑器之后，既不属于任何导航分区也找不到。 -->
        <p class="tip">
          保存前会先跑一次 nginx 语法校验，失败不会影响正在运行的配置；反代后端只接受
          <code>http(s)://host:port</code>，WAF 与站点配置同一次下发。
        </p>
        <!-- 操作条吸底：弹窗比视口高时，按钮不会随内容滚走，矮窗口下也点得到。
             错误条**不再**挤在这里——它已上移到弹窗顶部吸顶（见上方 .form-msg），
             字段级错误则各自挂在出问题的输入框旁。 -->
        </div>
      </div>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="modalClose">取消</button>
            <button class="btn-primary" :disabled="busy" @click="save">
              {{ busy ? '保存中…' : (editing ? '保存并应用' : '创建并应用') }}</button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog :open="!!delTarget" danger title="删除站点"
      :detail="delTarget ? `将删除站点「${delTarget.name}」及其关联证书，且无法恢复。` : ''"
      confirm-word="删除" @confirm="doDelete" @cancel="delTarget = null" />

    <ConfirmDialog :open="batchDelOpen" danger title="批量删除站点"
      :detail="`将删除已选的 ${selected.length} 个站点及其关联证书，且无法恢复。此操作不可撤销。`"
      confirm-word="删除" @confirm="batchDelete" @cancel="batchDelOpen = false" />

    <ConfirmDialog :open="!!delCert" danger title="删除证书"
      :detail="delCert ? `将删除证书「${delCert.domain}」。` : ''"
      confirm-word="删除" @confirm="doDeleteCert" @cancel="delCert = null" />

    <ConfirmDialog :open="confAsk" danger title="按表单重新生成"
      :detail="editing ? `将按当前表单重新渲染「${editing.name}」的配置并覆盖磁盘上的现有文件——你对它做的全部手工修改都会丢失（覆盖前会自动备份到服务器，但请勿依赖它找回）。` : ''"
      confirm-word="重新生成" @confirm="restoreConf" @cancel="confAsk = false" />

    <!-- 回滚二次确认（018）：替换前会把当前文件留档进版本链（可再回滚找回），
         但为避免误点仍要求输入确认词。 -->
    <ConfirmDialog :open="!!rollbackTarget" danger title="回滚配置版本"
      :detail="rollbackTarget ? `将把「${editing?.name ?? ''}」的磁盘配置替换为 ${fmtDateTime(rollbackTarget.created_at)} 留档的版本（${versSourceLabel(rollbackTarget.source)}）。替换前先把当前文件留档进版本链（可再次回滚找回），随后执行 nginx -t 校验并重载。` : ''"
      confirm-word="回滚" @confirm="doRollback" @cancel="rollbackTarget = null" />

    <!-- 保存二选一：手动维护站点 + 表单改了影响配置的字段（或已未同步）。
         不弹这步 = 表单值静默入库而磁盘配置不动 → 面板与 nginx 分叉（as11 真实踩过）。
         level-2：叠加在编辑弹窗之上（与目录选择器同级抬层）。 -->
    <div v-if="saveAsk" class="mask level-2" @click.self="closeSaveAsk">
      <div ref="saveAskBox" class="modal stack" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">保存手动维护的站点</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeSaveAsk">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p class="modal-lead">{{ saveAskLead }}</p>
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeSaveAsk">取消</button>
          <button class="btn-ghost" title="只把表单值入库；磁盘配置保持不变（随后会标记「未同步」）"
            @click="resumeSave(false)">仅保存（不覆盖配置）</button>
          <button class="btn-primary" title="按当前表单覆盖磁盘配置：先自动备份原配置，再重新渲染并重载"
            @click="resumeSave(true)">按表单重新生成</button>
        </div>
      </div>
    </div>

    <DirectoryPickerDialog :open="pickerOpen" :initial-path="form.root || siteRoot"
      @select="onPickRoot" @cancel="pickerOpen = false" />

    <DirectoryPickerDialog :open="routePickerOpen"
      :initial-path="(form.routes[routePickerIdx]?.root) || siteRoot"
      @select="onPickRouteRoot" @cancel="routePickerOpen = false" />

    <!-- 根证书安装指引：自签 leaf 由面板本地根 CA 签发，不把根装进信任库浏览器必然报不可信。
         这是「自签证书没法在本地用」的正解——不是换证书，而是装根。 -->
    <div v-if="caHelp" class="mask" @click.self="closeCaHelp">
      <div ref="caBox" class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">安装面板根证书</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeCaHelp">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p class="modal-lead">
          面板自签的站点证书，全部由<b>本机这一张根 CA</b> 签发。浏览器只信任「已装进信任库的根 CA」，
          所以直接访问会提示「不受信任 / 非私密连接」——这是证书链原理，不是面板坏了。
          <b>导入一次</b>即可：这张 CA 签发的全部本地站点（含以后新建的）都直接受信，无需再点「继续前往」。
        </p>
        <!-- 公共 .hint-note.is-warn（此前 .ca-warn 私有复刻了一版警告样式） -->
        <p class="hint-note is-warn">
          <Icon name="alert" :size="14" class="ic" />
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

        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeCaHelp">关闭</button>
          </div>
        </div>
      </div>
    </div>

    <!-- SSL 签发弹窗（审计 U6）：替代 window.prompt 选方式/填邮箱；行内「SSL」与编辑弹窗「申请证书」共用 -->
    <!-- 签发弹窗叠在站点弹窗之上 → .level-2（此前与父弹窗同为 z-50，只靠 DOM 顺序压住） -->
    <div v-if="sslModal" class="mask level-2" @click.self="closeSslModal">
      <div ref="sslBox" class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">为「{{ sslModal.site.name }}」申请证书</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeSslModal">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <!-- 这里出的错若写页面级 error/notice，会被两层遮罩挡在后面，
             用户只觉得"点了申请没反应"。故在弹窗内自带错误位。 -->
        <p v-if="sslErr" class="err-bar" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ sslErr }}</span>
        </p>
        <label class="ssl-opt">
          <input type="radio" value="self-signed" v-model="sslModal.method" />
          <span><b>面板自签</b><br /><span class="dim">离线可用、立即可得；需先导入面板根证书浏览器才受信（见「信任根证书」）</span></span>
        </label>
        <label class="ssl-opt">
          <input type="radio" value="http-01" v-model="sslModal.method" />
          <span><b>ACME http-01</b><br /><span class="dim">可信证书，需公网 80 端口可达 + certbot</span></span>
        </label>
        <label v-if="sslModal.method === 'http-01'" class="blk">
          ACME 账户邮箱（必填，用于到期与异常通知）
          <input v-model="sslModal.email" type="email" placeholder="ops@example.com" autocomplete="email" />
        </label>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeSslModal">取消</button>
            <button class="btn-primary" :disabled="busy || (sslModal.method === 'http-01' && !sslModal.email.trim())"
              @click="execSsl(sslModal.site, sslModal.method, sslModal.email)">
              {{ busy ? '提交中…' : '申请' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 「站点」是页面首个（也是唯一）区块头：`.sec-head.block` 的 26px 上间距是给
   后续区块与上方表格分界用的，页面首块再叠这 26px 就与 .content 的 24px 上内边距
   重复留白。首个 div 是它时归零；若上方出现错误/提示条（同为 div），它便退回
   26px 正常分界。SSL 证书管理已并入编辑弹窗，页面下方不再有独立「证书」区块。 */
.sec-head.block:first-of-type { margin-top: 0; }

/* WAF 区块：位于站点编辑弹窗内，用虚线分隔以表明它是站点配置的一部分而非并列项。
   ⚠️ 曾用 flex-wrap 排这 4 个控件：570px 内容宽装不下「勾选 + 档位 + CC + 突发桶」，
   且折点取决于「档位」下拉最长 option 的宽度（基础 ≈300px / 严格 ≈360px 折法不同）——
   实测要么折成 3+1、要么 2+2：勾选框浮在 select 行、突发桶标签与输入分家，视觉错乱。
   改为确定性网格：勾选行独占一行（与上方 SPA 回退的勾选行同构），字段行三段式——
   档位弹性吸收余量，CC / 突发桶两列按标签宽度自适应（max-content 保证标签不折行）。 */
.waf { display: grid; grid-template-columns: minmax(96px, 1fr) max-content max-content;
  align-items: start; gap: 10px 14px; margin-top: 10px;
  border-top: 1px dashed var(--c-border); padding-top: 10px; }
.waf > label.inline { grid-column: 1 / -1; }
.waf label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--c-text-dim); }
.waf label.inline { flex-direction: row; align-items: center; }
.waf label.inline input { width: auto; }
/* 窄窗（弹窗退到 94vw 后内容区不足 ~470px）：字段行退回单列堆叠，防止数值列挤没「档位」 */
@media (max-width: 500px) {
  .waf { grid-template-columns: minmax(0, 1fr); }
}
.tiny { font-size: var(--fs-12); }
.cert-sweep { margin: 0 0 10px; padding-left: 2px; }
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
.blk { display: block; margin-bottom: 12px; font-size: var(--fs-13); color: var(--c-text-dim); }
.blk input { width: 100%; margin-top: 4px; }
/* 备注块（022）：标签与其它 blk 字段同规格；组件与标签间距同 input 的 margin-top */
.remark-lb { display: block; }
.remark-blk .iremark { margin-top: 4px; }
/* 多路由表：一个站点内多条 `location ^~ <前缀>`。逐行一条，窄屏自然换行。 */
.routes { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
.routes-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.routes-title { font-size: var(--fs-12-5); color: var(--c-text); }
.routes-title em { font-style: normal; margin-left: 8px; color: var(--c-text-dim); font-size: var(--fs-12); }
/* 一条路由 = 一行：root 是唯一可伸缩项（grow/shrink），其余固定列永不错行；
   窄到放不下时由 root 收缩兜底，避免 SPA/删除被挤到第二行 */
.route-row { display: flex; gap: 5px; align-items: center; flex-wrap: nowrap; }
/* 前缀列固定宽：它是这张表的主键，太宽会让后面的目标字段被挤出视野 */
.route-row .rt-prefix { flex: 0 0 116px; min-width: 0; }
.route-row .rt-kind   { flex: 0 0 80px; }
.route-row .rt-target { flex: 1 1 220px; min-width: 0; }
.route-row .rt-spa { flex: none; display: flex; align-items: center; gap: 5px;
  font-size: var(--fs-12-5); color: var(--c-text-dim); white-space: nowrap; }
/* 原生勾选框必须复位 width——全局 `input { width: 100% }` 会让它撑满整行 */
.route-row .rt-spa input { width: auto; }
/* 路由级根目录：label 包 input + 目录按钮，整体占弹性宽 */
.route-row .rt-root { flex: 1 1 160px; min-width: 0; display: flex; gap: 8px; align-items: center; }
.route-row .rt-root input { flex: 1 1 auto; min-width: 0; }
.route-row .rt-dir { flex: none; }
.route-row .rt-del { flex: none; }
.routes.has-err .rt-prefix, .routes.has-err .rt-kind { border-color: var(--c-danger); }
.routes-note { margin: 2px 0 0; }
.routes-note code { font-size: var(--fs-12); }

/* 反向代理的「应用模板」选择条。Node/Java/Python/.NET 的接入方式相同（都是
   proxy_pass 到本机端口），差异只在运行时与启动命令——故做成预填模板而非新类型。 */
.tpl-row { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px;
  align-items: center; margin-top: 2px; }
.tpl-label { font-size: var(--fs-12-5); color: var(--c-text-dim); }
.tpl-chip { font: inherit; font-size: var(--fs-12-5); line-height: 1; padding: 6px 13px;
  cursor: pointer; border-radius: 999px; border: 1px solid var(--c-border);
  background: var(--c-surface-2); color: var(--c-text);
  transition: border-color .15s, background .15s; }
.tpl-chip em { font-style: normal; color: var(--c-text-mute); }
.tpl-chip:hover:not(:disabled) { border-color: var(--c-primary); }
.tpl-chip.is-on { border-color: var(--c-primary); background: var(--c-primary-soft); }
.tpl-chip.is-warn { border-color: var(--c-warn); background: var(--c-warn-bg); }
.tpl-chip:disabled { opacity: .5; cursor: not-allowed; }
/* 紧跟在模板条之后：收掉 .hint-note 默认的 14px 下边距，与相邻输入行的间距对齐 */
.tpl-note { margin-top: 2px; margin-bottom: 10px; }
.tpl-note b { font-weight: 500; }
.tpl-note b.is-warn { color: var(--c-warn); }
.row-inline { display: flex; align-items: flex-start; gap: 7px; }
/* 文字可能折行，勾选框对齐首行而非整体垂直居中；并复位 width——
   全局 `input{width:100%}` 会把原生勾选框拉成宽盒子，勾选框与文字之间出现大段空隙、
   文字被挤到右侧折行（与 .waf label.inline input / .chk input 同一处坑，故同样复位）。 */
.row-inline input[type="checkbox"] { width: auto; margin: 4px 0 0; }
/* 「启用」开关的后果说明：停用是**真停用**（摘配置 + reload），必须让用户看见代价。
   原 .hint-line（12px + --c-text-mute）太小太淡、又用负 margin 紧贴勾选框，读起来像
   "被禁用的残留文字"；改为带 info 图标的信息条：13px + --c-text-dim，柔和底 +
   左侧主色描边，与勾选框拉开间距。编辑态（真停用后果）转琥珀色强调。 */
/* ⚠️ .hint-note 已提到 main.css 公共规则。此前本页私有副本的特异性
   （.hint-note[data-v-*] = 0,2,0）高于公共（0,1,0）会**静默压掉**公共定义，
   导致别的视图用同一类名时拿不到样式——留着它就是埋雷，故删除。 */
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 操作条基础式样统一取 main.css 公共类 */

/* 根证书引导与站点编辑都用宽版（宽度与滚动见公共 .modal.wide）；此处只补
   sticky 操作条需要的「下内边距归零」——底部留白改由操作条自己承担。 */
.modal.wide { padding-bottom: 0; }
/* 站点编辑弹窗：全屏面板 + 左侧分段导航（2026-10-11，B 方案）。
   结构：.modal(网格 标题 / 中部 / 操作条) > .modal-mid(导航 rail + .modal-body 滚动区)。
   覆盖公共 .modal.wide 的 620px → 全屏面板；特异性 (0,3,1) 压过公共 (0,2,0)。 */
.modal.wide.site-modal {
  /* 96vw 再叠加 .mask 的 clamp 内边距会溢出视口，改 100% 由 mask 统一控边 */
  width: min(1180px, 100%);
  height: min(94vh, 960px);
  max-height: 96vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  grid-template-columns: 1fr;
  padding: 0;
  /* ⚠️ 必须同步覆写这两个变量：公共 .modal-head 用它们的**负值**外扩
     （margin: -py -px 12px / padding: py px 12px），本是为抵消弹窗自身内边距而设计。
     padding 归零后不覆写，标题行会被推出容器、再被 overflow:hidden 裁掉——
     表现为标题与关闭按钮贴死上边与左边。与 TrashPanel / SqlConsole 同款全幅面板同口径。 */
  --modal-py: 0;
  --modal-px: 0;
  overflow: hidden;
}
/* 变量归零后 head 失去内边距，此处显式补（与 .modal-body 的 18/22 左对齐） */
.modal.wide.site-modal > .modal-head { grid-row: 1; margin: 0; padding: 14px 22px 12px;
  border-bottom: 1px solid var(--c-border); }
.modal.wide.site-modal > .modal-mid { grid-row: 2; display: flex; min-height: 0; }
.modal.wide.site-modal > .modal-foot {
  grid-row: 3; position: static; margin: 0; padding: 12px 22px;
  background: var(--c-surface-2); border-top: 1px solid var(--c-border);
}
/* 内部操作条不再自行吸底（弹窗为 grid 行，天然固定底部），吸底与背景由 grid 行承担。 */
.modal.wide.site-modal > .modal-foot .modal-actions { position: static; margin: 0;
  padding: 0; border-top: 0; background: none; }

/* 左侧分段导航 rail：点按平滑滚动到对应 .sector；当前分区由 onBodyScroll 高亮 */
.nav-rail {
  width: 176px; flex: none; overflow-y: auto;
  border-right: 1px solid var(--c-border);
  padding: 14px 10px; background: var(--c-surface-2);
  display: flex; flex-direction: column; gap: 2px;
}
.nav-item {
  display: block; width: 100%; text-align: left;
  border: 0; background: none; cursor: pointer;
  padding: 8px 10px; border-radius: 8px;
  font: inherit; font-size: var(--fs-13); color: var(--c-text);
}
.nav-item:hover { background: var(--c-hover); }
.nav-item.active { background: var(--c-primary-soft); color: var(--c-primary); font-weight: 600; }
/* 分区内有字段级错误：rail 上亮红点（用户切到别的分区后仍找得到问题在哪） */
.nav-item { position: relative; }
.nav-item.has-err { color: var(--c-danger); }
.nav-dot { position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: var(--c-danger); }

/* 内容滚动区与分区卡片 */
.modal-body { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; position: relative; padding: 18px 22px 8px; }
/* 全屏后横向空间充足：分区内简单输入框双列排布，宽块（路由表 / 代码编辑器 /
   证书列表 / 提示）整宽跨两列。整列块用 1fr 1fr，列间距 18、行距 14。 */
.modal-body .sector { max-width: 980px; margin: 0 auto 22px;
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 14px; align-items: start; }
/* 分区之间补一条分隔线：滚动长表单时边界只靠标题文字可辨，与左侧 rail 的「分段」感对不上 */
.modal-body .sector + .sector { border-top: 1px solid var(--c-border); padding-top: 20px; }
/* ⚠️ 必须写 margin:0 而不是只写 margin-bottom：main.css 的 `.modal .blk { margin: 12px 0 }`
   是**简写**，本页 .blk 只覆盖了 margin-bottom，margin-top:12px 仍在生效——与 row-gap
   叠加成 26px（设计为 14），首行字段与分区标题之间也凭空多 12px。 */
.modal-body .sector > .blk { margin: 0; }
/* 整宽元素：跨两列 */
.modal-body .sector > .blk.full,
.modal-body .sector > .routes,
.modal-body .sector > .tpl-row,
.modal-body .sector > .waf,
.modal-body .sector > .cc,
.modal-body .sector > .adv,
.modal-body .sector > .ssl,
.modal-body .sector > .conf,
.modal-body .sector > .hint-note { grid-column: 1 / -1; }
.modal-body .sector-h { grid-column: 1 / -1; font-size: var(--fs-14); font-weight: 700; margin: 0 0 2px; color: var(--c-text); }

/* 通用宽版弹窗（CA 指引等）操作条吸底：站点弹窗已在上方用 grid 行固定，不受影响 */
.modal.wide .modal-actions { position: sticky; bottom: 0; margin: 14px -20px 0;
  padding: 12px 20px; background: var(--c-surface-2); border-top: 1px solid var(--c-border); }

/* ── 弹窗内的报错：标题行内的通用条（吸顶）+ 字段级红字，两者分工明确 ── */
/* 通用消息条跟着公共 .modal-head **整体吸顶**（不再自己做第二个 sticky）：
   ① flex-basis:100% 让它独占标题下方的第二行；② 底色必须**不透明**，
   否则半透明底会让滚上来的字段文字透出；③ 外观取公共 .err-bar，此处只调排布。 */
.modal.wide.site-modal > .modal-head > .form-msg { flex-basis: 100%; margin: 0; }
/* .field-err / .err-bar（含抖动动画与 prefers-reduced-motion 降级）已提到 main.css
   公共规则；本页只保留 CA 指引的步骤式样。 */
.ca-actions { display: flex; gap: 10px; margin: 0 0 18px; }
.ca-steps { display: flex; flex-direction: column; gap: 14px; }
.ca-step-h { font-weight: 600; font-size: var(--fs-13); margin-bottom: 6px; color: var(--c-primary); }
.ca-step p { margin: 0 0 6px; font-size: var(--fs-12-5); line-height: 1.65; }
.ca-code { margin: 6px 0; padding: 9px 11px; border-radius: 8px; font-size: var(--fs-12); line-height: 1.6;
  overflow-x: auto; background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text); }
.ssl-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border: 1px solid var(--c-border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: var(--fs-13); line-height: 1.5; }
.ssl-opt:has(input:checked) { border-color: var(--c-primary); background: var(--c-primary-soft); }
.ssl-opt input { width: auto; margin-top: 2px; }
/* 自动续期开关：与 ServiceDetailView 的开机自启开关同款——实心主色底 + 白滑块、42×24。
   旧版是 --c-primary-soft 浅色底 + 主色滑块，开销/关都偏「浅橙」，用户反馈看不出选中。
   CronView 同步升级，三处一套。 */

/* SSL 证书区块：位于「编辑站点」弹窗内，与 WAF 同用虚线分隔，表明它是站点配置的一部分 */
.ssl { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; }
.ssl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ssl-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.ssl-list { display: flex; flex-direction: column; gap: 8px; }
.ssl-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px;
  border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-hover); }
.ssl-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ssl-meta .mono { font-family: var(--mono); font-size: var(--fs-13); }
.ssl-ops { display: flex; align-items: center; gap: 6px; flex: none; }
.ca-link { margin-top: 10px; }

/* 站点原始配置区块：与 SSL 区块同范式（虚线分隔，同为「既有站点专属」区块）。
   原文用等宽字体承载；nginx -t 的原始输出按**原样换行**展示（pre-wrap）。 */
.conf { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; display: grid; gap: 8px; }
.conf-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.conf-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); flex: none; }
.conf-path { margin-left: auto; max-width: 56%; text-align: right; }
.conf-msg { margin: 0; white-space: pre-wrap; }
/* （.conf-text 已删除：该 class 落在 NginxEditor 的**根容器**上，resize 无效、
   min-height 作用在 wrapper 而非 textarea，字号行高也与组件内部重复定义。
   高度、等宽字体、滚动条槽位统一由 NginxEditor 自己负责。） */
.conf-ops { display: flex; align-items: flex-start; gap: 10px; }
.conf-hint { margin: 0; flex: 1; min-width: 0; }
.conf-btns { display: flex; gap: 6px; flex: none; margin-top: 2px; }
.conf-badge { margin-left: 4px; }
/* 未同步警示条：.conf 是 grid（gap 管间距），归零外边距防止双重留白 */
.conf-stale { margin: 0; }

/* 自定义配置片段（019）：与 WAF / SSL 同范式（虚线分隔 = 站点配置的一部分）。
   原文用等宽字体；只读态（非 owner）仍可选中复制。 */
.cc { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; }
.cc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cc-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.cc-text { width: 100%; min-height: 96px; resize: vertical; font-size: var(--fs-12); line-height: 1.55; }
.cc-note { margin: 6px 0 0; }

/* 高级配置（020）：与 WAF / SSL 同范式（虚线分隔 = 站点配置的一部分）。
   内部是纵向堆叠的几个字段：选项多、且 HSTS 勾开后还会长出附加项，
   做成两列网格反而会让跟随出现的输入框跳位。 */
.adv { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px;
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 11px; align-items: start; }
/* 卡片内简单输入框双列；标题 / 整宽文本域 / 提示 / 日志操作条跨两列 */
/* 同 .sector：必须整条 margin 归零，否则 .modal .blk 的 margin-top:12px 与 row-gap 叠加 */
.modal-body .adv > .blk { margin: 0; }
.modal-body .adv > .adv-head,
.modal-body .adv > .blk.full,
.modal-body .adv > .adv-row.full,
.modal-body .adv > .hint-note,
.modal-body .adv > .adv-note,
.modal-body .adv > .adv-warn,
.modal-body .adv > .log-actions,
.modal-body .adv > .log-confirm { grid-column: 1 / -1; }
.adv-head { margin-bottom: 6px; }
.adv-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.adv-row { margin-bottom: 8px; }
.adv-row select { width: 100%; margin-top: 4px; }
.adv-text { width: 100%; min-height: 74px; resize: vertical; font-size: var(--fs-12); line-height: 1.55; margin-top: 4px; }
.adv-warn { margin: 6px 0 8px; }
.adv-note { margin: 8px 0 0; }
/* 021：IP 黑名单在白名单非空时禁用 + 视觉降权 */
.is-dim { opacity: .5; }
.is-dim textarea { pointer-events: none; }
/* 021：站点日志操作区 + 内联清空确认条 */
.log-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
.log-confirm {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin: 8px 0 0; padding: 8px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--c-danger, #e5484d) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-danger, #e5484d) 35%, transparent);
  font-size: var(--fs-12); color: var(--c-text);
}
.log-confirm > span { flex: 1 1 auto; min-width: 180px; }
/* 外部修改警示条：与 .conf-stale 同款（.conf 是 grid，归零外边距防双重留白） */
.conf-external { margin: 0; }
/* 窄视口（弹窗 ≈ 96vw 已不足 ~760px）回退单列：双列会被输入框宽度挤爆，
   且全宽项保持跨两列也无害（单列下本就整宽）。 */
@media (max-width: 760px) {
  .modal.wide.site-modal .modal-body .sector,
  .modal.wide.site-modal .modal-body .adv { grid-template-columns: 1fr; }
  .modal.wide.site-modal .modal-body .sector > .blk,
  .modal.wide.site-modal .modal-body .adv > .blk { grid-column: auto; }
  /* 窄屏 rail 转顶部横向 tab：176px 固定宽在 96vw 弹窗里会吃掉约 1/4 内容宽度 */
  .modal.wide.site-modal > .modal-mid { flex-direction: column; }
  .modal.wide.site-modal .nav-rail { width: auto; flex: none; flex-direction: row;
    overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); padding: 8px 10px; }
  .modal.wide.site-modal .nav-item { width: auto; white-space: nowrap; padding: 6px 12px; }
}
/* 矮窗（≤600px 高）：纵向 rail + 内容区双层滚动操作路径太长，同样转横向 tab 把高度让给内容 */
@media (max-height: 600px) {
  .modal.wide.site-modal > .modal-mid { flex-direction: column; }
  .modal.wide.site-modal .nav-rail { width: auto; flex: none; flex-direction: row;
    overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); padding: 8px 10px; }
  .modal.wide.site-modal .nav-item { width: auto; white-space: nowrap; padding: 6px 12px; }
}

/* 历史版本与回滚（018）：列表行 = 元信息 + 操作两列；正文展开为 pre-wrap 等宽块，
   展开行整幅跨列（不挤在 auto 列里）。 */
.vers { display: flex; flex-direction: column; gap: 8px; }
.vers-toggle { align-self: flex-start; }
.vers-panel { display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--c-border); border-radius: 8px; padding: 4px 10px 8px; background: var(--c-hover); }
.vers-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center;
  padding: 5px 0; border-bottom: 1px dashed var(--c-border); }
.vers-row:last-child { border-bottom: 0; }
.vers-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vers-src { flex: none; font-size: var(--fs-12-5); color: var(--c-text); }
.vers-when { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vers-cur { flex: none; }
.vers-ops { display: flex; gap: 4px; flex: none; }
.vers-content { grid-column: 1 / -1; margin: 4px 0 2px; padding: 8px 10px; max-height: 240px; overflow: auto;
  background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px;
  font-size: var(--fs-12); line-height: 1.55; white-space: pre-wrap; word-break: break-all; }

/* 显式列宽（与服务/进程页统一范式）：table-layout:fixed + colgroup 宽度，
   长域名/根目录/签发者 ellipsis 截断、完整值走 title 悬停。
   两表宽度完全独立（各自一套 class），改一张绝不会波及另一张。 */
table.fixed { table-layout: fixed; width: 100%; }
table.fixed th, table.fixed td { overflow: hidden; }
.ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
/* 证书表（编辑弹窗内「SSL 证书」区块复用同款列宽思路，此处保留历史列宽定义，
   若后续在弹窗内恢复完整证书表格可直接复用；当前弹窗内改用紧凑卡片列表。 */
col.w-dom { width: 24%; }
col.w-acts { width: 12%; }
col.w-iss { width: 14%; }
col.w-src { width: 10%; }
col.w-exp { width: 12%; }
col.w-left { width: 9%; }
col.w-auto { width: 12%; }
col.w-cst { width: 8%; }
/* 骨架（观感与列表页统一；keyframes 独立命名避免全局冲突） */
.skeleton { background: linear-gradient(90deg, var(--c-hover) 25%, var(--c-glass) 37%, var(--c-hover) 63%); background-size: 400% 100%; animation: site-sk 1.4s ease infinite; border-radius: var(--radius); }
.box { height: 300px; }
@keyframes site-sk { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

/* ══ UX 审计整改（2026-10-11）新增样式 ══ */
/* 页头检索框：与工具按钮同高，窄屏下不跟标题抢空间 */
.site-search { width: min(220px, 40vw); padding: 5px 10px; font-size: var(--fs-13); }
/* 根目录字段下的「站点根目录」边界说明 */
.root-hint { display: block; margin-top: 5px; }
.root-hint code { font-size: var(--fs-12); }
/* 状态列：单格最多 3 个徽章，改可换行的 flex 行——行高稳定，不再参差 */
.st-cell { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
/* 特性列（021）：图标徽章，含义走 title 悬停 */
.feat-cell { display: flex; align-items: center; gap: 6px; }
.feat { display: inline-flex; color: var(--c-primary); }
/* 路由表条数无上限会让分区无限增长，给可视上限、滚动收在表内 */
.routes { max-height: 45vh; overflow-y: auto; }
/* 标题层级统一：区块标题一律 13px/600（.routes-title 原 12.5px 比同级低半级） */
.routes-title { font-size: var(--fs-13); }
/* 配置区读取失败条：要塞一个「重试」按钮（.err-bar 是 flex，单独排布） */
.conf-fail { align-items: center; flex-wrap: wrap; gap: 8px; }
.conf-fail > span { flex: 1 1 auto; min-width: 0; }
/* 只读原因条：紧贴编辑器上方，收掉 .hint-note 默认下边距避免与编辑器拉开距离 */
.conf-ro { margin: 0 0 8px; }
/* 页面级错误条也走公共 .err-bar：此前是裸红字无图标，与弹窗内的 .err-bar 两种长相 */
.page-err { margin: 0 0 12px; }
/* 模板 chip 选中态加强：此前选中只改边框 + 浅底，与 hover（仅改边框）几乎分不出来 */
.tpl-chip.is-on { color: var(--c-primary); font-weight: 600; box-shadow: inset 0 0 0 1px var(--c-primary); }
/* 卡片列表行补 hover：表行有 tbody tr:hover，证书行 / 版本行此前完全没反馈 */
.ssl-row:hover, .vers-row:hover { background: var(--c-active); }
/* 配置字节数：紧跟路径右侧，超限转警示色 */
.conf-size { flex: none; margin-left: 8px; }
.is-warn-text { color: var(--c-warn); }
/* ── 列表批量操作（G3）── */
col.w-sel { width: 40px; }
.col-sel { text-align: center; width: 40px; padding-left: 0; padding-right: 0; }
.col-sel input { width: auto; vertical-align: middle; cursor: pointer; }
.batch-bar { display: flex; align-items: center; gap: 8px; padding: 10px 4px; border-top: 1px solid var(--c-border); margin-top: 4px; flex-wrap: wrap; }
.batch-count { font-size: var(--fs-13); color: var(--c-text-dim); }
.batch-bar .spacer { flex: 1; }
</style>

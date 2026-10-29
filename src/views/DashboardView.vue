<script setup lang="ts">
/**
 * 仪表盘（概览首页）。
 *
 * 设计：能力缺失时不渲染假数据（沿用原有纪律）；实时数据经 SSE，nano 档位退化为轮询。
 * 指标来源 /api/v1/system/overview，实时增量由 /api/v1/events/metrics 推送（字段同 overview 子集）。
 */
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { usePolling } from '@/composables/usePolling'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { CAP, fmtDateTime, type ServerNote } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import SkeletonCard from '@/components/SkeletonCard.vue'
import { type MetricItem } from '@/components/MetricHeader.vue'
import { cpuTone, type MetricTone } from '@/composables/metricTone'
import { bkTile, ctTile, siteTile, svcTile } from '@/composables/dashboardStatus'
import Icon from '@/components/Icon.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import OnboardingChecklist from '@/components/OnboardingChecklist.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'

const auth = useAuthStore()

// ── 本机便签（025）：多条独立便签，替代 022 单例说明 ──
// 读对全员开放，写需 system.manage。每条 InlineRemark 自管编辑态；删除走
// ConfirmDialog；新增是列表末尾一条空 InlineRemark（保存成功即 reload 收编——
// create 不返回 id，临时编辑行的 id 只能从收编后的列表拿）。
const notes = ref<ServerNote[]>([])
const noteLoaded = ref(false)
const adding = ref(false)
const delNote = ref<ServerNote | null>(null)
const noteErr = ref('')
const canSystemManage = computed(() => auth.can('system.manage'))

async function loadNotes() {
  try {
    const r = await api.get<ServerNote[]>(API.server.notes())
    notes.value = r ?? []
    noteErr.value = ''
  } catch (e) { noteErr.value = errorText(e) }
  noteLoaded.value = true
}
/** 保存既有便签：成功后本地更新，不整表 reload（updated_at 取本地秒，展示足够） */
async function saveNote(id: number, v: string) {
  await api.patch(API.server.note(id), { content: v })
  const n = notes.value.find(x => x.id === id)
  if (n) { n.content = v; n.updated_at = Math.floor(Date.now() / 1000) }
}
/** 新增便签（写需 system.manage） */
async function saveNew(v: string) {
  await api.post(API.server.notes(), { content: v })
  await loadNotes()
  adding.value = false
}
function doDeleteNote() {
  const n = delNote.value
  if (!n) return
  delNote.value = null
  api.del(API.server.note(n.id)).then(() => {
    notes.value = notes.value.filter(x => x.id !== n.id)
    toast('便签已删除')
  }).catch((e) => { noteErr.value = errorText(e) })
}
/** 相对时间（便签时间戳是展示信息；超 30 天退化为 MM-DD） */
function noteTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`
  const d = new Date(ts * 1000)
  const p = (k: number) => String(k).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 对应后端 `OverviewResp`（routes/system.rs::overview）。此前用 `any`，
 *  SSE 合并时字段拼错会静默显示 0。 */
interface Overview {
  ts: number
  uptime_sec: number
  cpu_pct: number
  mem_used_kib: number
  mem_total_kib: number
  load1: number
  disks: number
  disk_used_bytes: number
  disk_total_bytes: number
  net_in_bps: number
  net_out_bps: number
  /** nano | small | standard */
  tier: string
  /** 采样已降频（低配保护），UI 需提示 */
  degraded: boolean
}

const ov = ref<Overview | null>(null)
let es: EventSource | undefined
// 轮询档（nano 档没有 SSE）：10s 一轮，隐藏暂停交给 usePolling。
// ⚠ 原先概览轮询**不暂停**——挂后台的标签每 10s 打一次 /system/overview，
// 与 SystemView/ContainersView 的既有纪律不一致，属漏迁移而非刻意。
// pollingMode 为假时链空转（tick 里被 enabled 拦下），与 SSE 分支互斥不双跑。
usePolling({ fn: poll, ms: 10_000, enabled: () => auth.pollingMode })

// 实时推送是 overview 的字段子集，必须「合并」而非整体替换——
// 否则 SSE 不含的 disk/net/degraded 等字段会被覆盖成 undefined（进而显示 0）。
function apply(d: Partial<Overview>) { ov.value = { ...(ov.value || {}), ...d } as Overview }

/** 确定性失败（501/403）的显式提示；普通网络抖动静默重试（审计 F19） */
const ovError = ref('')

async function poll() {
  try {
    // CPU 是「区间使用率」而不是瞬时值：overview 每次 HTTP 请求现算一次快照，窗口＝
    // 距上一次 snapshot（通常是采集循环几十~几百毫秒前那次），而 SSE 推送与两个监控页
    // 用的是采集循环写进环形缓冲的整周期值。三者不同源 ⇒ 同一 ts 也会给出不同读数
    // （实测 51.14% vs 54.41%；负载抖动时更夸张：23.19% vs 72.80%）。
    // 首屏就把 CPU 对齐到环形缓冲末样本，之后 SSE 推送（同源自 ring）自然接续。
    // 后端已根治（0cb9c93：采集循环独占采样、overview 只读缓存），两者现为同源；
    // 这段覆盖保留作冗余兜底——旧后端或未合并他线 WIP 时仍能对齐，可随后端版本
    // 全面落地后再移除（届时 overview 与 realtime 末样本必然逐位相同）。
    const [r, rt] = await Promise.all([
      api.get<Overview>(API.system.overview()),
      api.get<{ samples?: { cpu?: number }[] }>(`${API.metrics.realtime()}?since=1`).catch(() => null),
    ])
    const s = rt?.samples
    const last = s && s.length ? s[s.length - 1] : null
    if (last && typeof last.cpu === 'number') r.cpu_pct = last.cpu
    apply(r); ovError.value = ''
  } catch (e) {
    // 任何拉取失败（能力未接入 10009 / 网络抖动 / 超时）都给出可重试的错误态，
    // 不再静默卡在骨架（审计 U-首屏错误态一致性）：此前非 isUnsupported 的失败会让
    // 5 张骨架永久停留、无任何提示与重试入口。errorText 已按码给出中文文案。
    ovError.value = errorText(e)
  }
}

/** 顶端指标卡（B7）：数值与单位分行呈现，长复合值走「副行」——
    此前整串塞进 value，在 5 列窄卡里折行、基线参差（实测「45.7 GB / 102.1 GB」折行）。
    注：computed 内引用下方声明的 cpu/memPct 等——惰性求值，运行时均已就绪。 */
const ovCards = computed<MetricItem[]>(() => {
  const totalG = (ov.value?.disk_total_bytes ?? 0) / 1073741824
  const usedG = (ov.value?.disk_used_bytes ?? 0) / 1073741824
  const tb = totalG >= 1024
  const du = tb ? 1024 : 1
  const dUnit = tb ? 'TB' : 'GB'
  return [
    { id: 'cpu', label: 'CPU', value: cpu.value, unit: '%', icon: 'cpu', tone: cpuTone(Number(cpu.value)), progress: Number(cpu.value) },
    { id: 'mem', label: '内存', value: ((ov.value?.mem_used_kib ?? 0) / 1048576).toFixed(1), unit: 'GB',
      sub: `总量 ${((ov.value?.mem_total_kib ?? 0) / 1048576).toFixed(1)} GB`,
      icon: 'server', tone: 'cyan', progress: memPct.value },
    { id: 'disk', label: '磁盘', value: (usedG / du).toFixed(1), unit: dUnit,
      sub: `总量 ${(totalG / du).toFixed(1)} ${dUnit}`,
      icon: 'disk', tone: 'ok', progress: diskPct.value },
    { id: 'load', label: '负载', value: (ov.value?.load1 ?? 0).toFixed(2), unit: '1m', icon: 'bolt', tone: loadTone.value },
    { id: 'net', label: '网络', value: `↓ ${fmtNet(ov.value?.net_in_bps)}`,
      sub: `↑ ${fmtNet(ov.value?.net_out_bps)}`, icon: 'network', tone: 'cyan' },
  ]
})

/** 按已保存布局渲染（顺序 + 显隐）；布局中未出现的卡片（未来新增）追加在末尾可见 */
const shownCards = computed<MetricItem[]>(() => {
  const prefs = layout.value
  if (!prefs?.length) return ovCards.value
  const byId = new Map(ovCards.value.map(c => [c.id as string, c]))
  const out: MetricItem[] = []
  for (const p of prefs) {
    const c = byId.get(p.id)
    if (c && p.visible) out.push(c)
  }
  for (const c of ovCards.value) {
    if (!prefs.some(p => p.id === c.id)) out.push(c)
  }
  return out
})
function fmtNet(bps?: number) {
  const m = (bps ?? 0) / 1e6
  return m >= 1 ? m.toFixed(1) + ' Mbps' : ((bps ?? 0) / 1e3).toFixed(0) + ' Kbps'
}
function fmtUptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

const cpu = computed(() => (ov.value ? (ov.value.cpu_pct ?? 0).toFixed(1) : '0'))
const memPct = computed(() => ov.value && ov.value.mem_total_kib
  ? (ov.value.mem_used_kib / ov.value.mem_total_kib * 100) : 0)
const diskPct = computed(() => ov.value && ov.value.disk_total_bytes
  ? ((ov.value.disk_used_bytes ?? 0) / ov.value.disk_total_bytes * 100) : 0)
const loadTone = computed<MetricTone>(() => {
  const l = ov.value?.load1 ?? 0
  return l > 4 ? 'danger' : l > 2 ? 'warn' : 'load'
})

// ── 模块入口（2026-10-29 概览 Hub）──
// 按侧栏 6 组里的前 5 个业务域给「一键直达」；「系统」组属低频管理，不占首屏。
// 只回答「去哪」（静态职责说明），「好不好」交给下方「运行状态」实时磁贴——分工不重复。
// 门控与侧栏同口径（whyDisabled === null）：不可达的模块整卡隐藏，避免「点过去才发现 501」。
const MODULES: { to: string; label: string; hint: string; icon: string; cap: string; perm: string }[] = [
  { to: '/system', label: '监控', hint: '实时趋势 · 进程 · 快照', icon: 'cpu', cap: CAP.METRICS_READ, perm: 'system.view' },
  { to: '/services', label: '服务', hint: '软件包 · systemd · 应用', icon: 'server', cap: CAP.SERVICE_MANAGE, perm: 'service.view' },
  { to: '/databases', label: '数据', hint: '数据库 · 容器 · 备份 · 文件', icon: 'database', cap: CAP.DBMS_MANAGE, perm: 'db.view' },
  { to: '/firewall', label: '安全', hint: '防火墙 · 公网暴露', icon: 'shield', cap: CAP.FIREWALL_MANAGE, perm: 'firewall.manage' },
  { to: '/logs', label: '运维', hint: '日志 · 任务 · 终端', icon: 'list', cap: CAP.LOGS_READ, perm: 'log.view' },
]
const modules = computed(() => MODULES.filter(m => auth.whyDisabled(m.cap, m.perm) === null))

// ── 运行状态总览（替换原"快捷入口"导航网格：侧边栏已覆盖导航，这里改呈真实状态）──
const svc = ref<{ total: number; active: number; failed: number; ok: boolean }>({ total: 0, active: 0, failed: 0, ok: false })
const ct = ref<{ total: number; running: number; ok: boolean }>({ total: 0, running: 0, ok: false })
// 容器不可用的原因（取自能力矩阵，避免为诊断而调用 list 触发 501）：daemon_unreachable | binary_missing
const ctUnavailable = ref<string>('')
const site = ref<{ total: number; enabled: number; ok: boolean }>({ total: 0, enabled: 0, ok: false })
const bk = ref<{ total: number; fail: number; ok: boolean }>({ total: 0, fail: 0, ok: false })

const containerSupported = computed(() => auth.supported(CAP.CONTAINER_VIEW))

// ── P1-20：抓取失败不再静默渲染成「—」 ──
// 原先四路失败全是裸 catch 静默吞掉，ok 停留 false，磁贴显示「—」+ 灰点，与
// 「健康但真的是空」在用户侧无法区分。现在失败写入错误文案，磁贴显示
// 「加载失败」+ 琥珀点，区块级错误条给出原因与重试（与 ovError 同范式）。
// 推导逻辑住在 composables/dashboardStatus.ts（.vue 纯逻辑没法单测）。
const svcErr = ref('')
const ctErr = ref('')
const siteErr = ref('')
const bkErr = ref('')
const statusErr = computed(() => svcErr.value || ctErr.value || siteErr.value || bkErr.value)
const svcView = computed(() => svcTile(svc.value, svcErr.value))
const ctView = computed(() => ctTile(ct.value, ctErr.value, ctUnavailable.value))
const siteView = computed(() => siteTile(site.value, siteErr.value))
const bkView = computed(() => bkTile(bk.value, bkErr.value))

async function loadStatus() {
  // 各列表独立抓取，单点失败只让对应磁贴进入错误态（P1-20），不拖累整块渲染
  try {
    // 注意：服务列表是包装对象（{init_system, services}），不是裸数组
    const r = await api.get<{ services: { state: string }[] }>(API.services.list())
    const list = r.services ?? []
    svc.value = { total: list.length, active: list.filter(s => s.state === 'active').length,
      failed: list.filter(s => s.state === 'failed').length, ok: true }
    svcErr.value = ''
  } catch (e) { svcErr.value = errorText(e) }
  if (containerSupported.value) {
    // 能力双轨：container.view 只控制菜单/卡片可见（containerSupported 已判定），
    // 真正能否操作取决于 container.manage（守护进程可达性）。
    // 不可用时直接读能力矩阵的 reason，避免调用 list 撞 CONTAINER_MANAGE 门禁而返回 501、污染控制台。
    const cm = auth.capabilities[CAP.CONTAINER_MANAGE]
    if (cm?.supported) {
      try {
        const list = await api.get<{ state: string }[]>(API.containers.list())
        ct.value = { total: list.length, running: list.filter(c => c.state === 'running').length, ok: true }
        ctErr.value = ''
      } catch (e) { ctErr.value = errorText(e) }
    } else {
      ctUnavailable.value = cm?.reason || 'unknown'
    }
  }
  try {
    const list = await api.get<{ enabled: boolean }[]>(API.sites.list())
    site.value = { total: list.length, enabled: list.filter(s => s.enabled).length, ok: true }
    siteErr.value = ''
  } catch (e) { siteErr.value = errorText(e) }
  try {
    const list = await api.get<{ last_result: string | null }[]>(API.backups.list())
    bk.value = { total: list.length, fail: list.filter(p => p.last_result === 'fail').length, ok: true }
    bkErr.value = ''
  } catch (e) { bkErr.value = errorText(e) }
}

const sysInfo = computed(() => {
  const p = auth.platform
  return [
    { k: '发行版', v: p?.distro || p?.os || '—' },
    { k: '内核', v: p?.kernel || '—' },
    { k: '架构', v: p?.arch || '—' },
    { k: '初始化', v: p?.init || '—' },
    { k: '档位', v: auth.me?.tier || '—' },
    { k: '运行时长', v: ov.value?.uptime_sec != null ? fmtUptime(ov.value.uptime_sec) : '—' },
  ]
})

// 救火直达：CPU / 内存冲高时，用户下一个动作几乎必然是"谁在吃资源"。
// 进程管理已并入主机监控的 Tab（2 击），这里在异常时补一条 1 击捷径。
const hot = computed(() => Number(cpu.value) >= 85 || memPct.value >= 90)

/**
 * 告警条目。**此前是从 `ov.alerts` 取的，但后端 OverviewResp 从不返回该字段**
 * （已核对 routes/system.rs），所以这个卡片永远显示"无活跃告警"——一个
 * 看起来有、实则恒为空的区块。后端暂无告警聚合接口，故按已有指标在前端
 * 生成：判据与上面的 `hot` 一致，只是把阈值写明便于后续替换为真接口。
 */
interface Alert { level: 'danger' | 'warn'; message: string }
const alerts = computed<Alert[]>(() => {
  const out: Alert[] = []
  const c = Number(cpu.value)
  const m = memPct.value
  if (c >= 95) out.push({ level: 'danger', message: `CPU 占用 ${c.toFixed(1)}%，持续高位` })
  else if (c >= 85) out.push({ level: 'warn', message: `CPU 占用 ${c.toFixed(1)}%` })
  if (m >= 95) out.push({ level: 'danger', message: `内存占用 ${m.toFixed(1)}%，接近耗尽` })
  else if (m >= 90) out.push({ level: 'warn', message: `内存占用 ${m.toFixed(1)}%` })
  return out
})

// ── 卡片布局（A1 个性化）：顺序 + 显隐，存后端 /api/v1/settings/dashboard ──
// 编辑需 settings.manage（布局是面板级共享配置）；读取对全员开放。
// 读取/写入失败都不阻塞概览：读失败用默认顺序，写失败出警告提示。
interface CardPref { id: string; visible: boolean }
const layout = ref<CardPref[] | null>(null)
const layoutOpen = ref(false)
const dragId = ref<string | null>(null)
const canLayout = computed(() => auth.can('settings.manage'))
const CARD_LABEL: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘', load: '负载', net: '网络' }

const layoutBox = ref<HTMLElement | null>(null)
const { close: closeLayout } = useModal(() => layoutOpen.value, layoutBox, () => (layoutOpen.value = false))

async function loadLayout() {
  try {
    const r = await api.get<{ cards: CardPref[] }>(API.settings.dashboard())
    if (r?.cards?.length) layout.value = r.cards
  } catch { /* 布局读取失败用默认顺序，不影响概览渲染 */ }
}
async function saveLayout(next: CardPref[]) {
  try {
    const r = await api.put<{ cards: CardPref[] }>(API.settings.dashboard(), { cards: next })
    if (r?.cards?.length) layout.value = r.cards
    toast('卡片布局已保存')
  } catch (e) { toast(errorText(e), 'warn') }
}
/** 拖拽/勾选的底稿：尚无已存布局时以当前默认顺序为准 */
function ensureLayout(): CardPref[] {
  return layout.value ?? ovCards.value.map(c => ({ id: c.id as string, visible: true }))
}
function toggleCard(id: string) {
  const arr = ensureLayout().map(c => ({ ...c, visible: c.id === id ? !c.visible : c.visible }))
  // 后端也会 400；前端先拦一道给出人话
  if (!arr.some(c => c.visible)) { toast('至少保留一张可见卡片', 'warn'); return }
  layout.value = arr
  void saveLayout(arr)
}
function onDragStart(id: string, e: DragEvent) {
  if (!canLayout.value) return
  dragId.value = id
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) }
}
function onDropOn(id: string) {
  const from = dragId.value
  dragId.value = null
  if (!canLayout.value || !from || from === id) return
  const arr = ensureLayout().slice()
  const fi = arr.findIndex(c => c.id === from)
  const ti = arr.findIndex(c => c.id === id)
  if (fi < 0 || ti < 0) return
  const [moved] = arr.splice(fi, 1)
  arr.splice(ti, 0, moved)
  layout.value = arr
  void saveLayout(arr)
}

onMounted(async () => {
  await auth.loadMe()
  void loadNotes()
  void loadLayout()
  if (!auth.supported(CAP.METRICS_READ)) return
  await poll()
  await loadStatus()
  if (auth.pollingMode) {
    // 轮询由上面的 usePolling 负责（链在 setup 时已建，此处无需再启动）
  } else {
    es = new EventSource(API.events.metrics())
    es.addEventListener('metrics', (ev) => {
      try { apply(JSON.parse((ev as MessageEvent).data)) } catch { /* 忽略坏帧 */ }
    })
  }
})
onUnmounted(() => { es?.close() })
</script>

<template>
  <div class="dash">
    <!-- 卡片设置（A1 个性化）：显隐开关；顺序在下方直接拖拽卡片调整。
         原 page-head 横条已去掉（只为一个设置钮不值得占一条页面级空横条），
         改为内容区右上角工具行——与 SitesView/ProcessesView「工具条收进卡片顶栏」同范式。 -->
    <div v-if="canLayout && auth.supported(CAP.METRICS_READ)" class="dash-tools">
      <button class="btn-ghost btn-sm" title="卡片显示与排序（在页面上直接拖拽卡片调整顺序）" @click="layoutOpen = true">
        <Icon name="gear" :size="14" /> 卡片设置
      </button>
    </div>

    <!-- C2 首启上手清单：未关闭且未全部完成时占位首屏（组件内部自判显隐与加载）。
         必须放在 v-if/v-else 链之外——插进链中会打断相邻关系，模板直接编译失败。 -->
    <OnboardingChecklist />

    <p v-if="!auth.supported(CAP.METRICS_READ)" class="muted">
      当前环境不支持资源监控（{{ auth.capabilities[CAP.METRICS_READ]?.reason ?? '未知原因' }}）
    </p>

    <template v-else>
      <p v-if="ovError" class="err" role="alert">{{ ovError }}<button class="btn-ghost btn-sm err-retry" type="button" @click="poll()">重试</button></p>
      <!-- 首屏骨架（审计 U11）：ov 尚未到达且无误时，用与 MetricCard 同形的 SkeletonCard
           占位，列数与真实卡片一致、零跳动；此前写死 height:96px 的方块与各卡基线不齐。 -->
      <div v-else-if="!ov" class="grid" :class="`cols-${Math.max(1, shownCards.length)}`">
        <SkeletonCard v-for="c in shownCards" :key="c.id" :progress="c.progress !== undefined" />
      </div>
      <!-- 指标卡（A1 个性化）：顺序/显隐按后端布局渲染；管理员可拖拽排序 -->
      <div v-else class="grid" :class="`cols-${Math.max(1, shownCards.length)}`">
        <MetricCard v-for="c in shownCards" :key="c.id" v-bind="c"
          :draggable="canLayout"
          :class="[{ 'card-drag': canLayout }, { dragging: dragId === c.id }]"
          @dragstart="onDragStart(c.id as string, $event)"
          @dragover.prevent
          @drop.prevent="onDropOn(c.id as string)"
          @dragend="dragId = null" />
      </div>

      <!-- 高负载时的救火捷径：只在异常时出现，避免常态占视觉位 -->
      <div v-if="hot" class="hot-tip">
        <Icon name="alert" :size="15" />
        <span>资源占用偏高：CPU {{ cpu }}% · 内存 {{ memPct.toFixed(0) }}%</span>
        <RouterLink to="/system/procs" class="btn-ghost btn-sm">查看占用进程</RouterLink>
      </div>

            <!-- 模块入口（2026-10-29 概览 Hub）：5 个业务域一键直达，与侧栏分组同构。
           轻量卡片（比下方状态磁贴更矮），只回答「去哪」；实时状态仍由「运行状态」承载。 -->
      <section v-if="modules.length" class="card">
        <div class="sec-head"><Icon name="bolt" :size="16" /><span>模块入口</span></div>
        <div class="mod-grid">
          <RouterLink v-for="m in modules" :key="m.to" :to="m.to" class="mod-card">
            <span class="mod-ico"><Icon :name="m.icon" :size="18" /></span>
            <span class="mod-body">
              <span class="mod-name">{{ m.label }}</span>
              <span class="mod-hint">{{ m.hint }}</span>
            </span>
          </RouterLink>
        </div>
      </section>

<!-- 运行状态总览（替换原快捷入口：导航由侧边栏承担，这里呈真实状态） -->
      <section class="card">
        <div class="sec-head"><Icon name="gauge" :size="16" /><span>运行状态</span></div>
        <!-- P1-20：部分磁贴抓取失败时给出原因与重试（与指标卡 ovError 同范式）；
              磁贴本身显示「加载失败」，这条错误条说明失败原因，重试会重抓全部四路。 -->
        <p v-if="statusErr" class="err" role="alert">部分运行状态加载失败：{{ statusErr }}<button class="btn-ghost btn-sm err-retry" type="button" @click="loadStatus">重试</button></p>
        <div class="status">
          <RouterLink to="/services" class="st-tile">
            <span class="st-dot" :class="svcView.tone" />
            <span class="st-ico"><Icon name="server" :size="18" /></span>
            <span class="st-main">服务</span>
            <span class="st-sub">{{ svcView.text }}</span>
          </RouterLink>
          <RouterLink v-if="containerSupported" to="/containers" class="st-tile">
            <span class="st-dot" :class="ctView.tone" />
            <span class="st-ico"><Icon name="docker" :size="18" /></span>
            <span class="st-main">容器</span>
            <span class="st-sub">{{ ctView.text }}</span>
          </RouterLink>
          <RouterLink to="/sites" class="st-tile">
            <span class="st-dot" :class="siteView.tone" />
            <span class="st-ico"><Icon name="globe" :size="18" /></span>
            <span class="st-main">网站</span>
            <span class="st-sub">{{ siteView.text }}</span>
          </RouterLink>
          <RouterLink to="/backups" class="st-tile">
            <span class="st-dot" :class="bkView.tone" />
            <span class="st-ico"><Icon name="archive" :size="18" /></span>
            <span class="st-main">备份</span>
            <span class="st-sub">{{ bkView.text }}</span>
          </RouterLink>
        </div>
      </section>

      <!-- 系统信息 + 告警。两列：此处只有 2 张卡，原用 cols-3 会让第三列**永远空着**
           （>1180px 时白占 1/3 行宽；≤1180px 的 cols-3 本就退化成两列，故窄屏无变化）。 -->
      <div class="grid cols-2">
        <section class="card info">
          <div class="sec-head"><Icon name="server" :size="16" /><span>系统信息</span></div>
          <dl>
            <div v-for="row in sysInfo" :key="row.k" class="row">
              <dt>{{ row.k }}</dt><dd>{{ row.v }}</dd>
            </div>
          </dl>
        </section>

        <section class="card alerts">
          <div class="sec-head"><Icon name="alert" :size="16" /><span>告警与事件</span></div>
          <ul v-if="alerts.length">
            <li v-for="(a, i) in alerts" :key="i">
              <!-- 等级文字化（审计 P11）：仅靠 dot 颜色色盲/读屏无法分辨 -->
              <span class="dot" :class="a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : 'ok'"
                :aria-label="a.level === 'danger' ? '严重' : a.level === 'warn' ? '警告' : '提示'" />
              <span class="a-lv">{{ a.level === 'danger' ? '严重' : a.level === 'warn' ? '警告' : '提示' }}</span>
              <span class="a-msg">{{ a.message }}</span>
            </li>
          </ul>
          <div v-else class="ok-state"><span class="dot ok" /> 系统运行正常，无活跃告警</div>
        </section>
      </div>
    </template>

    <!-- 本机便签（025，多条）：A1 降级——从首屏顶部移到页尾（首屏优先呈"这台机器是否健康"），
         仍不依赖 metrics 能力（能力缺失时它是页面上唯一的卡片）；且必须留在 v-if/v-else 链
         **之外**（塞进链中会打断相邻关系，模板直接编译失败）。 -->
    <section class="card server-note">
      <div class="sec-head">
        <Icon name="note" :size="16" /><span>本机便签</span>
        <button v-if="canSystemManage && noteLoaded && !adding" class="btn-ghost btn-sm note-add"
          @click="adding = true">
          <Icon name="plus" :size="13" />添加
        </button>
      </div>
      <p v-if="noteErr" class="err" role="alert">{{ noteErr }}<button class="btn-ghost btn-sm err-retry" type="button" @click="loadNotes">重试</button></p>
      <div v-if="notes.length || adding" class="note-list">
        <div v-for="n in notes" :key="n.id" class="note-row">
          <InlineRemark class="note-body" :model-value="n.content" :editable="canSystemManage && noteLoaded"
            :saver="(v: string) => saveNote(n.id, v)"
            placeholder="点击填写：这台机器是干嘛的、跑着什么、有什么禁忌（如：勿随意重启）…" />
          <template v-if="canSystemManage">
            <span class="note-time" :title="fmtDateTime(n.updated_at)">
              {{ noteTime(n.updated_at) }}
            </span>
            <button class="note-del" title="删除这条便签" @click="delNote = n">
              <Icon name="trash" :size="13" />
            </button>
          </template>
        </div>
        <InlineRemark v-if="adding" model-value="" :editable="true"
          :saver="saveNew" placeholder="写点什么：运维禁忌、网络变更、待办…" />
      </div>
      <p v-else-if="noteLoaded && !noteErr" class="muted">暂无便签。这台机器是干嘛的、跑着什么、有什么禁忌，写第一条吧。</p>
      <p v-else-if="!noteLoaded" class="muted">加载中…</p>
    </section>

    <ConfirmDialog :open="!!delNote" danger title="删除便签"
      :detail="delNote ? `将删除便签「${delNote.content.slice(0, 24)}${delNote.content.length > 24 ? '…' : ''}」，且无法恢复。` : ''"
      @confirm="doDeleteNote" @cancel="delNote = null" />

    <!-- 卡片设置弹窗（A1）：显隐开关；顺序在概览页直接拖拽卡片调整 -->
    <div v-if="layoutOpen" class="mask" @click.self="closeLayout">
      <div ref="layoutBox" class="modal" role="dialog" aria-modal="true" aria-label="卡片设置">
        <div class="modal-head">
          <h3 class="modal-title">概览卡片</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeLayout">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <!-- 整段包进 <span>：.hint-note 是 flex，裸文本 + <b> 会被拆成三个 item 并各被压窄。 -->
        <p class="hint-note"><span>勾选控制显示；在概览页直接<b>拖拽卡片</b>可调整顺序。至少保留一张。</span></p>
        <div class="lay-list">
          <label v-for="c in ensureLayout()" :key="c.id" class="lay-row">
            <input type="checkbox" :checked="c.visible" @change="toggleCard(c.id)" />
            <span>{{ CARD_LABEL[c.id] ?? c.id }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeLayout">完成</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 18px; }

/* 概览无卡头，页面级 page-head 横条已去掉，卡片设置收为内容区右上角工具行
   （与 SitesView/ProcessesView「工具条收进卡片顶栏」同范式）。 */
.dash-tools { display: flex; justify-content: flex-end; gap: 8px; }

/* 本机便签（025）：防误操作位。一条品牌色左边线让它从一众指标卡里被认出来，
   但不改填充色——避免和告警/热区提示抢视觉权重。 */
.server-note { border-left: 3px solid var(--c-primary); }
.note-add { margin-left: auto; }
.note-list { display: flex; flex-direction: column; gap: 10px; }
.note-row { display: flex; align-items: flex-start; gap: 6px; }
.note-row .note-body { flex: 1; min-width: 0; }
.note-time { flex: none; padding-top: 4px; font-size: var(--fs-12); color: var(--c-text-dim); white-space: nowrap; }
.note-del { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; margin-top: 1px; border: none; border-radius: 7px;
  background: none; color: var(--c-text-dim); cursor: pointer; opacity: .45; transition: opacity .12s ease; }
.note-del:hover { opacity: 1; color: var(--c-danger); background: var(--c-danger-soft); }

.hot-tip { display: flex; align-items: center; gap: 9px; padding: 9px 14px;
           border: 1px solid var(--c-danger); border-radius: 10px;
           background: var(--c-danger-soft); color: var(--c-danger); font-size: var(--fs-13-5); }
.hot-tip span { flex: 1; }

/* 模块入口：5 个业务域的一键直达。比「运行状态」磁贴更矮更轻——
   它只承载「去哪」，不承载状态，避免与下方实时磁贴抢视觉权重。 */
.mod-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 10px; }
.mod-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--c-border); background: var(--c-surface-2);
  text-decoration: none; color: var(--c-text);
  transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.mod-card:hover { transform: translateY(-2px); border-color: var(--c-border-strong); box-shadow: var(--shadow); }
.mod-ico { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
  background: var(--c-primary-soft); color: var(--c-primary); }
.mod-body { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.mod-name { font-size: var(--fs-13-5); font-weight: 600; }
.mod-hint { font-size: var(--fs-12); color: var(--c-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── A1 个性化：卡片拖拽与设置弹窗 ── */
.card-drag { cursor: grab; }
.card-drag:active { cursor: grabbing; }
.dragging { opacity: .45; }
.lay-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
.lay-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; font-size: var(--fs-13-5); }
.lay-row:hover { background: var(--c-hover); }
/* 原生勾选框复位 width（全局 input{width:100%}） */
.lay-row input { width: auto; }

.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: var(--fs-14); margin-bottom: 14px; }
.sec-head :deep(.icon) { color: var(--c-primary); }

.status { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.st-tile { position: relative; display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
           column-gap: 12px; align-items: center; padding: 14px 16px; border-radius: 12px;
           text-decoration: none; color: var(--c-text); border: 1px solid var(--c-border);
           background: var(--c-surface-2); transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.st-tile:hover { transform: translateY(-2px); border-color: var(--c-border-strong); box-shadow: var(--shadow); }
.st-dot { position: absolute; top: 14px; right: 14px; width: 9px; height: 9px; border-radius: 50%; background: var(--c-text-dim); }
.st-dot.ok { background: var(--c-ok); }
.st-dot.warn { background: var(--c-warn); }
.st-dot.danger { background: var(--c-danger); }
.st-dot.muted { background: var(--c-border-strong); }
.st-ico { grid-row: 1 / span 2; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
          background: var(--c-primary-soft); color: var(--c-primary); }
.st-main { font-size: var(--fs-14); font-weight: 600; }
.st-sub { font-size: var(--fs-12-5); color: var(--c-text-dim); }

.info dl { margin: 0; display: flex; flex-direction: column; gap: 0; }
.info .row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--c-border); }
.info .row:last-child { border-bottom: none; }
.info dt { color: var(--c-text-dim); font-size: var(--fs-13); }
.info dd { margin: 0; font-size: var(--fs-13-5); font-weight: 500; }

.alerts ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.alerts li { display: flex; align-items: flex-start; gap: 9px; font-size: var(--fs-13-5); }
.a-lv { flex: none; font-size: var(--fs-12); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--c-border); color: var(--c-text-dim); }
li:has(.dot.danger) .a-lv { color: var(--c-danger); border-color: var(--c-danger-soft); background: var(--c-danger-soft); }
li:has(.dot.warn) .a-lv { color: var(--c-warn); border-color: transparent; background: var(--c-warn-bg); }
li:has(.dot.ok) .a-lv { color: var(--c-ok); border-color: transparent; background: var(--c-ok-soft); }
.alerts .a-msg { flex: 1; }
.ok-state { display: flex; align-items: center; gap: 9px; color: var(--c-text-dim); font-size: var(--fs-13-5); }
</style>

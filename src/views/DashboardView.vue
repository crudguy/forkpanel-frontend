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
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { CAP, fmtDateTime, fmtUptime, type ServerNote, type ProcessInfo } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import SkeletonCard from '@/components/SkeletonCard.vue'
import { type MetricItem } from '@/components/MetricHeader.vue'
import { cpuTone, type MetricTone } from '@/composables/metricTone'
import { bkTile, ctTile, siteTile, svcTile } from '@/composables/dashboardStatus'
import Icon from '@/components/Icon.vue'
import InlineRemark from '@/components/InlineRemark.vue'
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

// 运行状态磁贴（服务 / 容器 / 网站 / 备份）单独一轮：此前只在 onMounted 拉一次，
// 长期停在概览页时计数会过期——服务恢复后磁贴仍显示「N 个服务异常」，点进去却对不上。
// 30s 比指标卡的 10s 更克制：四路请求（services/containers/sites/backups）合起来不轻，
// 而这几类状态变化频率低。隐藏暂停 / 回可见补拉由 usePolling 统一处理；
// 能力缺失时磁贴不渲染，enabled 每 tick 求值会把链空转掉。
usePolling({ fn: loadStatus, ms: 30_000, enabled: () => auth.supported(CAP.METRICS_READ) })

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
    此前整串塞进 value，在 5 列窄卡里折行、基线参差（实测「45.7 GiB / 102.1 GiB」折行）。
    注：computed 内引用下方声明的 cpu/memPct 等——惰性求值，运行时均已就绪。 */
const ovCards = computed<MetricItem[]>(() => {
  // 1073741824 = 1024³，所以单位是 GiB / TiB，不能标 GB / TB
  const totalG = (ov.value?.disk_total_bytes ?? 0) / 1073741824
  const usedG = (ov.value?.disk_used_bytes ?? 0) / 1073741824
  const tb = totalG >= 1024
  const du = tb ? 1024 : 1
  const dUnit = tb ? 'TiB' : 'GiB'
  return [
    { id: 'cpu', label: 'CPU', value: cpu.value, unit: '%', icon: 'cpu', tone: cpuTone(Number(cpu.value)), progress: Number(cpu.value) },
    { id: 'mem', label: '内存', value: ((ov.value?.mem_used_kib ?? 0) / 1048576).toFixed(1), unit: 'GiB',
      sub: `总量 ${((ov.value?.mem_total_kib ?? 0) / 1048576).toFixed(1)} GiB`,
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

const cpu = computed(() => (ov.value ? (ov.value.cpu_pct ?? 0).toFixed(1) : '0'))
const memPct = computed(() => ov.value && ov.value.mem_total_kib
  ? (ov.value.mem_used_kib / ov.value.mem_total_kib * 100) : 0)
const diskPct = computed(() => ov.value && ov.value.disk_total_bytes
  ? ((ov.value.disk_used_bytes ?? 0) / ov.value.disk_total_bytes * 100) : 0)
const loadTone = computed<MetricTone>(() => {
  const l = ov.value?.load1 ?? 0
  return l > 4 ? 'danger' : l > 2 ? 'warn' : 'load'
})

// ── 指标卡 hover 悬浮详情：鼠标移到任意指标卡上方弹出详情浮层 ──
// 设计要点：
// 1. 单例浮层，Teleport 到 body——避免祖先 transform/backdrop-filter 把浮层裁成小盒；
// 2. position: fixed + 卡片 getBoundingClientRect() 定位，上方空间不足且下方充裕时翻到下方，
//    水平方向按视口夹紧，绝不溢出屏幕；
// 3. pointer-events: none——浮层永不抢 hover，鼠标移出卡片即隐藏，无闪烁/卡死；
// 4. TIP_H 仅用于翻转判定（预估高度），无需实测，避免测量导致的定位跳动。
const tipCard = ref<MetricItem | null>(null)
const tipDetail = ref<{ rows: { k: string; v: string }[]; status: string; tone: MetricTone } | null>(null)
const tipStyle = ref<Record<string, string>>({})
const tipVisible = ref(false)
const TIP_W = 250
const TIP_H = 190

const TONE_LABEL: Record<string, string> = {
  primary: '正常', cyan: '正常', ok: '正常', load: '正常', neutral: '正常',
  hot: '偏高', warn: '警告', danger: '危险',
}

/** 各指标卡的悬浮详情内容；数据缺失（ov 未到）时返回 null，不弹浮层。 */
function cardDetail(id?: string): { rows: { k: string; v: string }[]; status: string; tone: MetricTone } | null {
  const o = ov.value
  if (!o) return null
  switch (id) {
    case 'cpu':
      return {
        rows: [
          { k: '实时使用率', v: `${cpu.value} %` },
          { k: '采样口径', v: '采集循环整周期均值' },
          { k: '刷新方式', v: auth.pollingMode ? '每 10s 轮询' : 'SSE 实时推送' },
        ],
        status: TONE_LABEL[cpuTone(Number(cpu.value))] ?? '正常',
        tone: cpuTone(Number(cpu.value)),
      }
    case 'mem': {
      const pct = memPct.value
      return {
        rows: [
          { k: '已用内存', v: `${((o.mem_used_kib ?? 0) / 1048576).toFixed(1)} GiB` },
          { k: '总内存', v: `${((o.mem_total_kib ?? 0) / 1048576).toFixed(1)} GiB` },
          { k: '使用率', v: `${pct.toFixed(1)} %` },
        ],
        status: pct >= 95 ? '危险' : pct >= 90 ? '警告' : '正常',
        tone: pct >= 95 ? 'danger' : pct >= 90 ? 'warn' : 'cyan',
      }
    }
    case 'disk': {
      const totalG = o.disk_total_bytes / 1073741824
      const usedG = o.disk_used_bytes / 1073741824
      const tb = totalG >= 1024
      const du = tb ? 1024 : 1
      const dUnit = tb ? 'TiB' : 'GiB'
      const pct = diskPct.value
      return {
        rows: [
          { k: '已用空间', v: `${(usedG / du).toFixed(1)} ${dUnit}` },
          { k: '总空间', v: `${(totalG / du).toFixed(1)} ${dUnit}` },
          { k: '使用率', v: `${pct.toFixed(1)} %` },
          { k: '磁盘数量', v: `${o.disks}` },
        ],
        status: pct >= 95 ? '危险' : pct >= 90 ? '警告' : '正常',
        tone: pct >= 95 ? 'danger' : pct >= 90 ? 'warn' : 'ok',
      }
    }
    case 'load': {
      const l = o.load1 ?? 0
      return {
        rows: [
          { k: '1 分钟负载', v: l.toFixed(2) },
          { k: '偏高阈值', v: '≥ 2' },
          { k: '高负载阈值', v: '≥ 4' },
          { k: '说明', v: '反映 CPU / IO 排队强度' },
        ],
        status: TONE_LABEL[loadTone.value] ?? '正常',
        tone: loadTone.value,
      }
    }
    case 'net':
      return {
        rows: [
          { k: '下行速率', v: fmtNet(o.net_in_bps) },
          { k: '上行速率', v: fmtNet(o.net_out_bps) },
          { k: '口径', v: '实时吞吐（瞬时）' },
          { k: '刷新方式', v: auth.pollingMode ? '每 10s 轮询' : 'SSE 实时推送' },
        ],
        status: '正常',
        tone: 'cyan',
      }
    default:
      return null
  }
}

function showTip(card: MetricItem, e: MouseEvent) {
  // 拖拽中或布局弹窗打开时不弹浮层（避免与拖拽排序 / 弹窗焦点冲突）
  if (dragId.value || layoutOpen.value) return
  const detail = cardDetail(card.id)
  if (!detail) return
  // 顶部进程：仅 CPU / 内存卡，且环境支持进程列表能力时（能力缺失整段不渲染，不造假数据）
  const sort = card.id === 'cpu' ? 'cpu' : card.id === 'mem' ? 'mem' : null
  tipProcSort.value = sort
  tipProcs.value = []
  tipProcErr.value = ''
  if (sort && auth.supported(CAP.PROCESS_LIST)) void loadTopProcs(sort)
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  let left = rect.left + rect.width / 2 - TIP_W / 2
  left = Math.max(8, Math.min(left, vw - TIP_W - 8))
  const roomAbove = rect.top - TIP_H - 10 > 8
  const roomBelow = rect.bottom + TIP_H + 10 < vh - 8
  // 默认优先浮于卡片上方（不挡下方「运行状态」区）；上方不足且下方充裕时翻到下方
  let top: number, tf: string
  if (roomAbove || !roomBelow) { top = rect.top; tf = 'translateY(calc(-100% - 10px))' }
  else { top = rect.bottom; tf = 'translateY(10px)' }
  tipCard.value = card
  tipDetail.value = detail
  tipStyle.value = { left: left + 'px', top: top + 'px', transform: tf }
  tipVisible.value = true
}
function hideTip() {
  tipVisible.value = false
  tipProcSort.value = null // 收起时复位，下次 hover 重新判定（缓存仍保留，重复 hover 即时出）
}

// ── hover 顶部进程（仅 CPU / 内存卡）：后端 /processes 支持 sort+limit 服务端取 Top N ──
// 懒加载 + 5s TTL 缓存：避免每次悬停都打 /processes（实测单程 ~40ms / 75KB），重复悬停即时出；
// 过期后下次 hover 再拉。能力缺失时整段不渲染（不造假数据，与仪表盘其余纪律一致）。
const tipProcSort = ref<'cpu' | 'mem' | null>(null)
const tipProcs = ref<ProcessInfo[]>([])
const tipProcLoading = ref(false)
const tipProcErr = ref('')
const PROC_TTL = 5000
const procCache = new Map<'cpu' | 'mem', { ts: number; data: ProcessInfo[] }>()

// 进程 RSS 专用：整数 MiB 分档，与 api/types.ts 的 fmtKib（三档、保留一位小数）
// 口径不同，Q-12 已裁决不为了去重硬合并——只把十进制标签换成 IEC。
function fmtMem(kib: number) {
  const mb = kib / 1024
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GiB' : mb.toFixed(0) + ' MiB'
}
async function loadTopProcs(sort: 'cpu' | 'mem') {
  const cached = procCache.get(sort)
  const now = Date.now()
  if (cached && now - cached.ts < PROC_TTL) {
    tipProcs.value = cached.data
    tipProcLoading.value = false
    return
  }
  tipProcLoading.value = true
  tipProcErr.value = ''
  try {
    const r = await api.get<ProcessInfo[]>(API.processes.list(), { params: { sort, limit: 5 } })
    const data = (r ?? []).slice(0, 5)
    procCache.set(sort, { ts: now, data })
    // 仅在仍展示该 sort 时回填：避免 hover 切卡后旧请求覆盖新卡数据
    if (tipProcSort.value === sort) tipProcs.value = data
    tipProcLoading.value = false
  } catch (e) {
    if (tipProcSort.value === sort) {
      tipProcErr.value = isUnsupported(e) ? '当前环境不支持进程管理' : errorText(e)
      tipProcLoading.value = false
    }
  }
}

// ── 运行状态总览（侧边栏已承担导航职能，这里只呈现真实状态）──
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

/** 服务磁贴跳转目标：**必须直达「服务」Tab**。
 *  ⚠ 不能跳 `/services` —— 它会重定向到默认的「软件」Tab，进去满屏是软件包，
 *  看不到 systemd 服务列表（概览报「N 个服务异常」、点进去却像"没有异常"，就是这么来的）。
 *  有异常时附带 `?filter=failed`，服务页只列失败项，省去在长列表里翻找。 */
const svcTo = computed(() =>
  !svcErr.value && svc.value.failed > 0 ? '/services/units?filter=failed' : '/services/units')

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
    <!-- 不支持资源监控：仅提示 + 本机便签（便签不依赖 metrics 能力，能力缺失时它是页面上唯一的卡片） -->
    <template v-if="!auth.supported(CAP.METRICS_READ)">
      <p class="muted">
        当前环境不支持资源监控（{{ auth.capabilities[CAP.METRICS_READ]?.reason ?? '未知原因' }}）
      </p>
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
    </template>

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
          @dragstart="onDragStart(c.id as string, $event); hideTip()"
          @dragover.prevent
          @drop.prevent="onDropOn(c.id as string)"
          @dragend="dragId = null"
          @mouseenter="showTip(c, $event)"
          @mouseleave="hideTip" />
      </div>

      <!-- 高负载时的救火捷径：只在异常时出现，避免常态占视觉位 -->
      <div v-if="hot" class="hot-tip">
        <Icon name="alert" :size="15" />
        <span>资源占用偏高：CPU {{ cpu }}% · 内存 {{ memPct.toFixed(0) }}%</span>
        <RouterLink to="/system/procs" class="btn-ghost btn-sm">查看占用进程</RouterLink>
      </div>

<!-- 运行状态总览（侧边栏已承担导航职能，这里只呈现真实状态） -->
      <section class="card">
        <div class="sec-head"><Icon name="gauge" :size="16" /><span>运行状态</span></div>
        <!-- P1-20：部分磁贴抓取失败时给出原因与重试（与指标卡 ovError 同范式）；
              磁贴本身显示「加载失败」，这条错误条说明失败原因，重试会重抓全部四路。 -->
        <p v-if="statusErr" class="err" role="alert">部分运行状态加载失败：{{ statusErr }}<button class="btn-ghost btn-sm err-retry" type="button" @click="loadStatus">重试</button></p>
        <div class="status">
          <RouterLink :to="svcTo" class="st-tile">
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

      <!-- 系统信息 + 告警与事件 + 本机便签：三列同行、统一卡片样式；
           ≤1180px 退化为两列、≤720px 单列（与指标卡栅格一致）。 -->
      <div class="grid cols-3">
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
      </div>
    </template>

    <!-- 指标卡 hover 悬浮详情：单例浮层，Teleport 到 body 避免被祖先裁切；
          pointer-events:none 保证鼠标移出卡片即隐藏、不抢 hover、无闪烁。 -->
    <Teleport to="body">
      <Transition name="mtip">
        <div v-if="tipVisible && tipCard && tipDetail" class="m-tip" :class="`tone-${tipDetail.tone}`"
             :style="tipStyle" role="tooltip">
          <div class="m-tip-head">
            <span v-if="tipCard.icon" class="ico"><Icon :name="tipCard.icon" :size="16" /></span>
            <span class="m-tip-label">{{ tipCard.label }}</span>
            <span class="badge">{{ tipDetail.status }}</span>
          </div>
          <div class="m-tip-val">
            <span class="num">{{ tipCard.value }}</span>
            <em v-if="tipCard.unit">{{ tipCard.unit }}</em>
            <span v-if="tipCard.sub" class="sub2">{{ tipCard.sub }}</span>
          </div>
          <dl class="m-tip-rows">
            <div v-for="r in tipDetail.rows" :key="r.k" class="row">
              <dt>{{ r.k }}</dt><dd>{{ r.v }}</dd>
            </div>
          </dl>
          <div v-if="tipProcSort && auth.supported(CAP.PROCESS_LIST)" class="m-tip-procs">
            <div class="m-tip-procs-head">
              <span>Top 5 进程</span>
              <span class="m-tip-procs-sub">按{{ tipProcSort === 'cpu' ? 'CPU' : '内存' }}</span>
            </div>
            <p v-if="tipProcLoading" class="m-tip-procs-msg">加载中…</p>
            <p v-else-if="tipProcErr" class="m-tip-procs-msg err">{{ tipProcErr }}</p>
            <ul v-else class="m-tip-procs-list">
              <li v-for="(p, i) in tipProcs" :key="p.pid" class="m-tip-proc">
                <span class="rank">{{ i + 1 }}</span>
                <span class="pname" :title="p.cmdline || p.name">{{ p.name }}</span>
                <span class="pval">{{ tipProcSort === 'cpu' ? p.cpu_pct.toFixed(1) + ' %' : fmtMem(p.rss_kib) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog :open="!!delNote" danger title="删除便签"
      :detail="delNote ? `将删除便签「${delNote.content.slice(0, 24)}${delNote.content.length > 24 ? '…' : ''}」，且无法恢复。` : ''"
      @confirm="doDeleteNote" @cancel="delNote = null" />

    <!-- 卡片设置弹窗（A1）：显隐开关；顺序在概览页直接拖拽卡片调整。
         浮层 Teleport 到 body：避免祖先出现 backdrop-filter/transform 时被裁切成小盒。 -->
    <Teleport to="body">
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
    </Teleport>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 18px; }

/* 本机便签（025）：与「系统信息 / 告警与事件」同处一行卡片，去掉独立左边线以统一观感。 */
.note-add { margin-left: auto; }
.note-list { display: flex; flex-direction: column; gap: 10px; }
.note-row { display: flex; align-items: flex-start; gap: 6px; }
.note-row .note-body { flex: 1; min-width: 0; }
.note-time { flex: none; padding-top: 4px; font-size: var(--fs-12); color: var(--c-text-dim); white-space: nowrap; }
.note-del { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; margin-top: 1px; border: none; border-radius: var(--radius-chip);
  background: none; color: var(--c-text-dim); cursor: pointer; opacity: .45; transition: opacity .12s ease; }
.note-del:hover { opacity: 1; color: var(--c-danger); background: var(--c-danger-soft); }

.hot-tip { display: flex; align-items: center; gap: 9px; padding: 9px 14px;
           border: 1px solid var(--c-danger); border-radius: var(--radius-sm);
           background: var(--c-danger-soft); color: var(--c-danger); font-size: var(--fs-13-5); }
.hot-tip span { flex: 1; }

/* ── A1 个性化：卡片拖拽与设置弹窗 ── */
.card-drag { cursor: grab; }
.card-drag:active { cursor: grabbing; }
.dragging { opacity: .45; }
.lay-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
.lay-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: var(--radius-xs); cursor: pointer; font-size: var(--fs-13-5); }
.lay-row:hover { background: var(--c-hover); }
/* 原生勾选框复位 width（全局 input{width:100%}） */
.lay-row input { width: auto; }

.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: var(--fs-14); margin-bottom: 14px; }
.sec-head :deep(.icon) { color: var(--c-primary); }

/* S2 概览「运行状态」磁贴曾用 auto-fill：宽屏下第 5 条隐式轨道为空却仍占 200px，
   右侧留出约 180px 空白、视觉重心偏左。改为 auto-fit：空轨道塌缩为 0，4 个磁贴始终拉满整行。 */
.status { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.st-tile { position: relative; display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
           column-gap: 12px; align-items: center; padding: 14px 16px; border-radius: var(--radius-md);
           text-decoration: none; color: var(--c-text); border: 1px solid var(--c-border);
           background: var(--c-surface-2); transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.st-tile:hover { transform: translateY(-2px); border-color: var(--c-border-strong); box-shadow: var(--shadow); }
.st-dot { position: absolute; top: 14px; right: 14px; width: 9px; height: 9px; border-radius: 50%; background: var(--c-text-dim); }
.st-dot.ok { background: var(--c-ok); }
.st-dot.warn { background: var(--c-warn); }
.st-dot.danger { background: var(--c-danger); }
.st-dot.muted { background: var(--c-border-strong); }
.st-ico { grid-row: 1 / span 2; width: 40px; height: 40px; border-radius: var(--radius-sm); display: grid; place-items: center;
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

/* ── 指标卡 hover 悬浮详情 ── */
.m-tip { position: fixed; z-index: 60; width: 250px; box-sizing: border-box;
  padding: 13px 15px 14px; border-radius: var(--radius-md); pointer-events: none;
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  box-shadow: var(--shadow-lg); opacity: 1; }
.mtip-enter-from, .mtip-leave-to { opacity: 0; }
.mtip-enter-active, .mtip-leave-active { transition: opacity .12s ease; }
.m-tip-head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.m-tip .ico { width: 28px; height: 28px; border-radius: var(--radius-xs); display: grid; place-items: center; flex: none;
  background: color-mix(in srgb, var(--c-text-dim) 16%, transparent); color: var(--c-text-dim); }
.m-tip-label { font-size: var(--fs-13-5); font-weight: 600; color: var(--c-text); }
.m-tip .badge { margin-left: auto; flex: none; font-size: var(--fs-12); padding: 1px 8px;
  border-radius: 999px; border: 1px solid var(--c-border); color: var(--c-text-dim); background: transparent; white-space: nowrap; }
.m-tip-val { display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-bottom: 11px;
  font-size: var(--fs-18); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.m-tip-val .num { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-tip-val em { font-style: normal; font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 500; white-space: nowrap; }
.m-tip-val .sub2 { margin-left: auto; font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 500; white-space: nowrap; }
.m-tip-rows { margin: 0; display: flex; flex-direction: column; }
.m-tip-rows .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0;
  border-top: 1px solid var(--c-border); font-size: var(--fs-12-5); }
.m-tip-rows .row:first-child { border-top: none; }
.m-tip-rows dt { color: var(--c-text-dim); white-space: nowrap; }
.m-tip-rows dd { margin: 0; font-weight: 500; color: var(--c-text); text-align: right; font-variant-numeric: tabular-nums; }
/* Top 5 进程（仅 CPU / 内存卡；能力缺失不渲染）：分隔 + 紧凑行 */
.m-tip-procs { margin-top: 11px; padding-top: 11px; border-top: 1px solid var(--c-border); }
.m-tip-procs-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px;
  font-size: var(--fs-12); font-weight: 600; color: var(--c-text-dim); }
.m-tip-procs-sub { font-size: var(--fs-12); font-weight: 500; color: var(--c-text-mute); }
.m-tip-procs-msg { margin: 0; font-size: var(--fs-12); color: var(--c-text-mute); }
.m-tip-procs-msg.err { color: var(--c-danger); }
.m-tip-procs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.m-tip-proc { display: flex; align-items: center; gap: 8px; font-size: var(--fs-12-5); }
.m-tip-proc .rank { flex: none; width: 15px; height: 15px; border-radius: var(--radius-chip); display: grid; place-items: center;
  font-size: var(--fs-12); font-weight: 700; color: var(--c-text-mute); background: var(--c-hover); }
.m-tip-proc .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); }
.m-tip-proc .pval { flex: none; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--c-text-dim); }
/* tone → 图标色 + 状态徽标色（与 MetricCard 同源 token，随主题切换） */
.m-tip.tone-primary .ico { background: var(--c-primary-soft); color: var(--c-primary); }
.m-tip.tone-primary .badge { color: var(--c-primary); border-color: var(--c-primary-soft); background: var(--c-primary-soft); }
.m-tip.tone-cyan .ico { background: color-mix(in srgb, var(--c-cyan) 14%, transparent); color: var(--c-cyan); }
.m-tip.tone-cyan .badge { color: var(--c-cyan); border-color: color-mix(in srgb, var(--c-cyan) 30%, transparent); background: color-mix(in srgb, var(--c-cyan) 12%, transparent); }
.m-tip.tone-ok .ico { background: var(--c-ok-soft); color: var(--c-ok); }
.m-tip.tone-ok .badge { color: var(--c-ok); border-color: var(--c-ok-soft); background: var(--c-ok-soft); }
.m-tip.tone-warn .ico { background: var(--c-warn-bg); color: var(--c-warn); }
.m-tip.tone-warn .badge { color: var(--c-warn); border-color: var(--c-warn-bg); background: var(--c-warn-bg); }
.m-tip.tone-danger .ico { background: var(--c-danger-soft); color: var(--c-danger); }
.m-tip.tone-danger .badge { color: var(--c-danger); border-color: var(--c-danger-soft); background: var(--c-danger-soft); }
.m-tip.tone-hot .ico { background: color-mix(in srgb, var(--chart-hot) 18%, transparent); color: var(--chart-hot); }
.m-tip.tone-hot .badge { color: var(--chart-hot); border-color: color-mix(in srgb, var(--chart-hot) 30%, transparent); background: color-mix(in srgb, var(--chart-hot) 16%, transparent); }
.m-tip.tone-cpu .ico { background: color-mix(in srgb, var(--chart-cpu) 18%, transparent); color: var(--chart-cpu); }
.m-tip.tone-cpu .badge { color: var(--chart-cpu); border-color: color-mix(in srgb, var(--chart-cpu) 30%, transparent); background: color-mix(in srgb, var(--chart-cpu) 16%, transparent); }
.m-tip.tone-load .ico { background: color-mix(in srgb, var(--chart-load) 18%, transparent); color: var(--chart-load); }
.m-tip.tone-load .badge { color: var(--chart-load); border-color: color-mix(in srgb, var(--chart-load) 30%, transparent); background: color-mix(in srgb, var(--chart-load) 16%, transparent); }
.m-tip.tone-neutral .ico { background: color-mix(in srgb, var(--c-text-dim) 16%, transparent); color: var(--c-text-dim); }
</style>

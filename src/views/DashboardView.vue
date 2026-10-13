<script setup lang="ts">
/**
 * 仪表盘（概览首页）。
 *
 * 设计：能力缺失时不渲染假数据（沿用原有纪律）；实时数据经 SSE，nano 档位退化为轮询。
 * 指标来源 /api/v1/system/overview，实时增量由 /api/v1/events/metrics 推送（字段同 overview 子集）。
 */
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { CAP, type ServerNote } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import { type MetricItem } from '@/components/MetricHeader.vue'
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
  } catch { /* 静默：加载失败不拖累概览，卡片退化为空态 */ }
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
let timer: number | undefined
let es: EventSource | undefined

// 实时推送是 overview 的字段子集，必须「合并」而非整体替换——
// 否则 SSE 不含的 disk/net/degraded 等字段会被覆盖成 undefined（进而显示 0）。
function apply(d: Partial<Overview>) { ov.value = { ...(ov.value || {}), ...d } as Overview }

/** 确定性失败（501/403）的显式提示；普通网络抖动静默重试（审计 F19） */
const ovError = ref('')

async function poll() {
  try {
    const r = await api.get<Overview>(API.system.overview()); apply(r); ovError.value = ''
  } catch (e) {
    if (isUnsupported(e)) ovError.value = errorText(e)
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
    { id: 'cpu', label: 'CPU', value: cpu.value, unit: '%', icon: 'cpu', tone: 'primary', progress: Number(cpu.value) },
    { id: 'mem', label: '内存', value: ((ov.value?.mem_used_kib ?? 0) / 1048576).toFixed(1), unit: 'GB',
      sub: `总量 ${((ov.value?.mem_total_kib ?? 0) / 1048576).toFixed(1)} GB`,
      icon: 'server', tone: 'cyan', progress: memPct.value },
    { id: 'disk', label: '磁盘', value: (usedG / du).toFixed(1), unit: dUnit,
      sub: `总量 ${(totalG / du).toFixed(1)} ${dUnit}`,
      icon: 'disk', tone: 'primary', progress: diskPct.value },
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
const loadTone = computed<'primary' | 'warn' | 'danger'>(() => {
  const l = ov.value?.load1 ?? 0
  return l > 4 ? 'danger' : l > 2 ? 'warn' : 'primary'
})

// ── 运行状态总览（替换原"快捷入口"导航网格：侧边栏已覆盖导航，这里改呈真实状态）──
const svc = ref<{ total: number; active: number; failed: number; ok: boolean }>({ total: 0, active: 0, failed: 0, ok: false })
const ct = ref<{ total: number; running: number; ok: boolean }>({ total: 0, running: 0, ok: false })
// 容器不可用的原因（取自能力矩阵，避免为诊断而调用 list 触发 501）：daemon_unreachable | binary_missing
const ctUnavailable = ref<string>('')
const site = ref<{ total: number; enabled: number; ok: boolean }>({ total: 0, enabled: 0, ok: false })
const bk = ref<{ total: number; fail: number; ok: boolean }>({ total: 0, fail: 0, ok: false })

const containerSupported = computed(() => auth.supported(CAP.CONTAINER_VIEW))

const svcTone = computed(() => !svc.value.ok ? 'muted' : svc.value.failed > 0 ? 'danger' : 'ok')
const ctTone = computed(() => !ct.value.ok ? 'muted' : ct.value.total > 0 && ct.value.running === 0 ? 'warn' : 'ok')
const siteTone = computed(() => !site.value.ok ? 'muted' : 'ok')
const bkTone = computed(() => !bk.value.ok ? 'muted' : bk.value.fail > 0 ? 'danger' : bk.value.total === 0 ? 'warn' : 'ok')

const svcText = computed(() => !svc.value.ok ? '—' : svc.value.failed > 0 ? `${svc.value.failed} 个服务异常` : `${svc.value.active} 个运行中`)
const ctText = computed(() => {
  if (ct.value.ok) return `运行中 ${ct.value.running} / 共 ${ct.value.total}`
  if (ctUnavailable.value === 'daemon_unreachable') return '守护进程不可达'
  if (ctUnavailable.value === 'binary_missing') return '未安装 Docker'
  return '不可用'
})
const bkText = computed(() => !bk.value.ok ? '—' : bk.value.total === 0 ? '未配置计划' : bk.value.fail > 0 ? `${bk.value.fail} 个计划失败` : '全部正常')

async function loadStatus() {
  // 各列表独立抓取，单点失败静默（审计 F19），不拖累整块渲染
  try {
    // 注意：服务列表是包装对象（{init_system, services}），不是裸数组
    const r = await api.get<{ services: { state: string }[] }>(API.services.list())
    const list = r.services ?? []
    svc.value = { total: list.length, active: list.filter(s => s.state === 'active').length,
      failed: list.filter(s => s.state === 'failed').length, ok: true }
  } catch { /* 静默 */ }
  if (containerSupported.value) {
    // 能力双轨：container.view 只控制菜单/卡片可见（containerSupported 已判定），
    // 真正能否操作取决于 container.manage（守护进程可达性）。
    // 不可用时直接读能力矩阵的 reason，避免调用 list 撞 CONTAINER_MANAGE 门禁而返回 501、污染控制台。
    const cm = auth.capabilities[CAP.CONTAINER_MANAGE]
    if (cm?.supported) {
      try {
        const list = await api.get<{ state: string }[]>(API.containers.list())
        ct.value = { total: list.length, running: list.filter(c => c.state === 'running').length, ok: true }
      } catch { /* 静默 */ }
    } else {
      ctUnavailable.value = cm?.reason || 'unknown'
    }
  }
  try {
    const list = await api.get<{ enabled: boolean }[]>(API.sites.list())
    site.value = { total: list.length, enabled: list.filter(s => s.enabled).length, ok: true }
  } catch { /* 静默 */ }
  try {
    const list = await api.get<{ last_result: string | null }[]>(API.backups.list())
    bk.value = { total: list.length, fail: list.filter(p => p.last_result === 'fail').length, ok: true }
  } catch { /* 静默 */ }
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
    timer = window.setInterval(poll, 10000)
  } else {
    es = new EventSource(API.events.metrics())
    es.addEventListener('metrics', (ev) => {
      try { apply(JSON.parse((ev as MessageEvent).data)) } catch { /* 忽略坏帧 */ }
    })
  }
})
onUnmounted(() => { if (timer) clearInterval(timer); es?.close() })
</script>

<template>
  <div class="dash">
    <div class="page-head">
      <h2 class="page-title">概览</h2>
      <span class="spacer" />
      <!-- 卡片设置（A1 个性化）：显隐开关；顺序在下方直接拖拽卡片调整 -->
      <button v-if="canLayout && auth.supported(CAP.METRICS_READ)" class="btn-ghost btn-sm"
        title="卡片显示与排序（在页面上直接拖拽卡片调整顺序）" @click="layoutOpen = true">
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
      <p v-if="ovError" class="err" role="alert">{{ ovError }}</p>
      <!-- 首屏骨架（审计 U11）：此前 ov=null 时指标卡全显示 0 值，故障与"真的空闲"无法区分 -->
      <div v-if="!ov" class="grid cols-5">
        <div v-for="i in 5" :key="i" class="card skeleton" style="height:96px" />
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

      <!-- 运行状态总览（替换原快捷入口：导航由侧边栏承担，这里呈真实状态） -->
      <section class="card">
        <div class="sec-head"><Icon name="gauge" :size="16" /><span>运行状态</span></div>
        <div class="status">
          <RouterLink to="/services" class="st-tile">
            <span class="st-dot" :class="svcTone" />
            <span class="st-ico"><Icon name="server" :size="18" /></span>
            <span class="st-main">服务</span>
            <span class="st-sub">{{ svcText }}</span>
          </RouterLink>
          <RouterLink v-if="containerSupported" to="/containers" class="st-tile">
            <span class="st-dot" :class="ctTone" />
            <span class="st-ico"><Icon name="docker" :size="18" /></span>
            <span class="st-main">容器</span>
            <span class="st-sub">{{ ctText }}</span>
          </RouterLink>
          <RouterLink to="/sites" class="st-tile">
            <span class="st-dot" :class="siteTone" />
            <span class="st-ico"><Icon name="globe" :size="18" /></span>
            <span class="st-main">网站</span>
            <span class="st-sub">{{ site.ok ? `共 ${site.total} 个 · 启用 ${site.enabled}` : '—' }}</span>
          </RouterLink>
          <RouterLink to="/backups" class="st-tile">
            <span class="st-dot" :class="bkTone" />
            <span class="st-ico"><Icon name="archive" :size="18" /></span>
            <span class="st-main">备份</span>
            <span class="st-sub">{{ bkText }}</span>
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
      <p v-if="noteErr" class="err" role="alert">{{ noteErr }}</p>
      <div v-if="notes.length || adding" class="note-list">
        <div v-for="n in notes" :key="n.id" class="note-row">
          <InlineRemark class="note-body" :model-value="n.content" :editable="canSystemManage && noteLoaded"
            :saver="(v: string) => saveNote(n.id, v)"
            placeholder="点击填写：这台机器是干嘛的、跑着什么、有什么禁忌（如：勿随意重启）…" />
          <template v-if="canSystemManage">
            <span class="note-time" :title="new Date(n.updated_at * 1000).toLocaleString()">
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
      <p v-else-if="noteLoaded" class="muted">暂无便签。这台机器是干嘛的、跑着什么、有什么禁忌，写第一条吧。</p>
      <p v-else class="muted">加载中…</p>
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
        <p class="hint-note">勾选控制显示；在概览页直接<b>拖拽卡片</b>可调整顺序。至少保留一张。</p>
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
           background: var(--c-danger-soft); color: var(--c-danger); font-size: 13.5px; }
.hot-tip span { flex: 1; }

/* ── A1 个性化：卡片拖拽与设置弹窗 ── */
.card-drag { cursor: grab; }
.card-drag:active { cursor: grabbing; }
.dragging { opacity: .45; }
.lay-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
.lay-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; font-size: 13.5px; }
.lay-row:hover { background: var(--c-hover); }
/* 原生勾选框复位 width（全局 input{width:100%}） */
.lay-row input { width: auto; }

.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; margin-bottom: 14px; }
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
.st-main { font-size: 14px; font-weight: 600; }
.st-sub { font-size: 12.5px; color: var(--c-text-dim); }

.info dl { margin: 0; display: flex; flex-direction: column; gap: 0; }
.info .row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--c-border); }
.info .row:last-child { border-bottom: none; }
.info dt { color: var(--c-text-dim); font-size: 13px; }
.info dd { margin: 0; font-size: 13.5px; font-weight: 500; }

.alerts ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.alerts li { display: flex; align-items: flex-start; gap: 9px; font-size: 13.5px; }
.a-lv { flex: none; font-size: 12px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--c-border); color: var(--c-text-dim); }
li:has(.dot.danger) .a-lv { color: var(--c-danger); border-color: var(--c-danger-soft); background: var(--c-danger-soft); }
li:has(.dot.warn) .a-lv { color: var(--c-warn); border-color: transparent; background: var(--c-warn-bg); }
li:has(.dot.ok) .a-lv { color: var(--c-ok); border-color: transparent; background: var(--c-ok-soft); }
.alerts .a-msg { flex: 1; }
.ok-state { display: flex; align-items: center; gap: 9px; color: var(--c-text-dim); font-size: 13.5px; }
</style>

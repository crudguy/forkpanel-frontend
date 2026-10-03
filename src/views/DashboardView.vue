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
import { CAP } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()

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

function fmtGB(b?: number) {
  const g = (b ?? 0) / 1073741824
  return g >= 1024 ? (g / 1024).toFixed(2) + ' TB' : g.toFixed(1) + ' GB'
}
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

onMounted(async () => {
  await auth.loadMe()
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
    <p v-if="!auth.supported(CAP.METRICS_READ)" class="muted">
      当前环境不支持资源监控（{{ auth.capabilities[CAP.METRICS_READ]?.reason ?? '未知原因' }}）
    </p>

    <template v-else>
      <p v-if="ovError" class="err" role="alert">{{ ovError }}</p>
      <!-- 首屏骨架（审计 U11）：此前 ov=null 时指标卡全显示 0 值，故障与"真的空闲"无法区分 -->
      <div v-if="!ov" class="grid cols-5">
        <div v-for="i in 5" :key="i" class="card skeleton" style="height:96px" />
      </div>
      <!-- 指标卡 -->
      <div v-else class="grid cols-5">
        <MetricCard label="CPU" :value="cpu" unit="%" icon="cpu" :progress="Number(cpu)" tone="primary" />
        <MetricCard label="内存" :value="((ov?.mem_used_kib || 0) / 1024).toFixed(0)"
          :unit="'/ ' + ((ov?.mem_total_kib || 0) / 1024).toFixed(0) + ' MB'" icon="server"
          :progress="memPct" tone="cyan" />
        <MetricCard label="磁盘" :value="ov ? fmtGB(ov.disk_used_bytes) : '0'"
          :unit="'/ ' + (ov ? fmtGB(ov.disk_total_bytes) : '0')" icon="disk"
          :progress="diskPct" tone="primary" />
        <MetricCard label="负载" :value="(ov?.load1 ?? 0).toFixed(2)" unit="1m" icon="bolt" :tone="loadTone" />
        <MetricCard label="网络" :value="ov ? fmtNet(ov.net_in_bps) : '0'"
          :unit="'↓ · ' + (ov ? fmtNet(ov.net_out_bps) : '0') + ' ↑'" icon="network" tone="cyan" />
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

      <!-- 系统信息 + 告警 -->
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
      </div>
    </template>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 18px; }

.hot-tip { display: flex; align-items: center; gap: 9px; padding: 9px 14px;
           border: 1px solid var(--c-danger); border-radius: 10px;
           background: var(--c-danger-soft); color: var(--c-danger); font-size: 13.5px; }
.hot-tip span { flex: 1; }

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

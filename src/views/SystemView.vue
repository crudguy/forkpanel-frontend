<script setup lang="ts">
/**
 * 主机监控。
 * 与首页概览的分工：概览看全貌（经 SSE 实时推送），本页看时间趋势（实时滚动 + 持久化历史）。
 * 曲线用自绘 SVG（不引图表库，守 110KB 首屏预算）。
 *
 * 实时指标 5 项：CPU / 内存 / 负载 / 磁盘使用率 / 网络吞吐（入·出）。
 * history 接口只返回 CPU / 内存 / 负载，故历史曲线覆盖这三项。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import MetricHeader, { type MetricItem } from '@/components/MetricHeader.vue'
import { cpuTone } from '@/composables/metricTone'
import { usePolling } from '@/composables/usePolling'
import { smoothSeriesPath } from '@/composables/smoothPath'
import { axisTicks, nearestIndex, tipLeft, valueY } from '@/composables/chartGuides'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface Sample {
  ts: number
  cpu: number               // cpu_pct
  mem_used_kib: number
  mem_total_kib: number
  load1: number
  disk_used_bytes: number
  disk_total_bytes: number
  net_in_bps: number
  net_out_bps: number
}
type HistRow = [number, number, number, number] // [ts, cpu_pct, mem_used_kib, load1]

const auth = useAuthStore()

// 配色：图例与曲线共用同一来源，确保一致且彼此对比鲜明
const COLOR = { cpu: 'var(--chart-cpu)', mem: 'var(--chart-mem)', load: 'var(--chart-load)', disk: 'var(--chart-disk)' } as const
const NET = { in: 'var(--chart-net-in)', out: 'var(--chart-net-out)' } as const

// 实时数据：客户端维护定长滚动缓冲，避免每次轮询整窗替换导致曲线跳变 / 重缩放
const MAXN = 120
const buf = ref<Sample[]>([])
const interval = ref(2000)
const gran = ref<'1m' | '1h'>('1m')
const history = ref<{ granularity: string; samples: HistRow[]; unavailable?: string } | null>(null)
/** 历史请求序号：快速切粒度时丢弃旧响应，避免「标签说 1m、曲线是 1h」 */
let histSeq = 0
/** 页面准入：能力位 + 权限点（轮询 enabled 用；导航已按同口径门控） */
const canView = computed(() => auth.supported(CAP.METRICS_READ) && auth.can('system.view'))


function mergeRealtime(samples: Sample[]) {
  if (!samples.length) return
  if (!buf.value.length) { buf.value = samples.slice(-MAXN); return }
  const lastTs = buf.value[buf.value.length - 1]?.ts ?? 0
  const fresh = samples.filter(s => s.ts > lastTs) // 只追加比本地更新鲜的点
  if (fresh.length) {
    const next = buf.value.concat(fresh)
    buf.value = next.length > MAXN ? next.slice(next.length - MAXN) : next
  }
}

/** 确定性失败（501/403）的显式提示；网络抖动保持静默，轮询自动重试（审计 F19） */
const rtError = ref('')

async function loadRealtime() {
  try {
    const r = await api.get<{ interval_ms: number; samples: Sample[] }>(
      API.metrics.realtime(), { params: { since: 60 } })
    interval.value = r.interval_ms
    mergeRealtime(r.samples)
    rtError.value = ''
  } catch (e) {
    // 保留上一帧防抖动；501/403 属确定性失败，须提示否则「暂无数据」无法排障
    if (isUnsupported(e)) rtError.value = errorText(e)
  }
}

async function loadHistory() {
  if (auth.me?.tier === 'nano') { history.value = null; return }
  const seq = ++histSeq
  const g = gran.value
  try {
    const r = await api.get<{ granularity: string; samples: HistRow[]; unavailable?: string }>(
      API.metrics.history(), { params: { gran: g } })
    if (seq !== histSeq) return   // 已有更新的粒度在途，丢弃本次结果
    history.value = r
  } catch { /* 保留上一帧：history 随 realtime 轮询重拉，确定性失败已在 rtError 提示 */ }
}

// 实时曲线：间隔取后端采样间隔（1~3s 夹取）。间隔是**变量**——自调度链在
// 下一次调度即用新值，不需要 watch + 手写重建。旧实现这段手写了两次（onMounted
// 与 onVisibility 各一份），注释里"恢复前先清旧句柄否则两个定时器同时跑"的坑
// 正是手写的产物；交给 usePolling 后隐藏暂停/回可见补拉/卸载清理都不再出现。
const rtPollMs = () => Math.min(Math.max(interval.value || 2000, 1000), 3000)
usePolling({ fn: loadRealtime, ms: rtPollMs, enabled: () => canView.value })
// 历史曲线 30s 一轮（变化慢，且 nano 档自身会短路）
usePolling({ fn: loadHistory, ms: 30_000, enabled: () => canView.value })

onMounted(() => { loadRealtime(); loadHistory() })

const last = computed(() => buf.value.at(-1))
const memPct = computed(() => last.value ? memPctOf(last.value) : 0)
const diskPct = computed(() => last.value ? diskPctOf(last.value) : 0)

/** 指标头数据项（A2）：与「专业快照」页共用 MetricHeader + 同一采样序列 */
const hdrItems = computed<MetricItem[]>(() => [
  { label: 'CPU', value: (last.value?.cpu ?? 0).toFixed(1), unit: '%',
      icon: 'cpu', tone: cpuTone(last.value?.cpu), progress: last.value?.cpu },
    { label: '内存', value: memPct.value.toFixed(1), unit: '%',
      icon: 'disk', tone: 'cyan', progress: memPct.value },
    { label: '负载', value: (last.value?.load1 ?? 0).toFixed(2), unit: '1m',
      icon: 'gauge', tone: 'load' },
  { label: '磁盘', value: diskPct.value.toFixed(1), unit: '%',
    icon: 'database', tone: 'ok', progress: diskPct.value },
])
const loadMax = computed(() =>
  Math.max(2, ...buf.value.map(s => s.load1)))
// 网络坐标轴上限取缓冲内入/出最大值，保证曲线不贴底
const netMaxBps = computed(() =>
  Math.max(1, ...buf.value.map(s => Math.max(s.net_in_bps, s.net_out_bps))))

/** 把缓冲序列映射为平滑 path；x 按索引等分 → 定长缓冲滚动时点距恒定，不跳变 */
function buildPath(accessor: (s: Sample) => number, max: number) {
  return smoothSeriesPath(buf.value.map(s => accessor(s)), max)
}

const cpuPath = computed(() => buildPath(s => s.cpu, 100))
const memPath = computed(() => buildPath(s => s.mem_total_kib ? s.mem_used_kib / s.mem_total_kib * 100 : 0, 100))
const loadPath = computed(() => buildPath(s => s.load1, loadMax.value))
const diskPath = computed(() =>
  buildPath(s => s.disk_total_bytes ? (s.disk_used_bytes / s.disk_total_bytes * 100) : 0, 100))
const netInPath = computed(() => buildPath(s => s.net_in_bps, netMaxBps.value))
const netOutPath = computed(() => buildPath(s => s.net_out_bps, netMaxBps.value))

function mbps(bps: number) { return (bps / 1e6).toFixed(1) }

// ── 历史曲线（长时趋势）──
const histRows = computed<HistRow[]>(() => history.value?.samples ?? [])
const historyUnavailable = computed(() =>
  auth.me?.tier === 'nano' || !!history.value?.unavailable)
const histCpuPath = computed(() => buildHistPath(r => r[1], 100))
// 历史样本只记录 mem_used_kib，总量只有实时快照里有。快照尚未到达时不能拿
// "已用×4" 当总量——那会让曲线恒为 25%，是个编出来的数字。改为总量未知时先不画
// （path d 为空即不渲染），等快照到达后按真实总量绘制。
const histMemPath = computed(() => {
  const total = last.value?.mem_total_kib
  if (!total) return ''
  return buildHistPath(r => r[2] / Math.max(1, total) * 100, 100)
})
const histLoadMax = computed(() => Math.max(2, ...histRows.value.map(r => r[3])))
const histLoadPath = computed(() => buildHistPath(r => r[3], histLoadMax.value))

function buildHistPath(accessor: (r: HistRow) => number, max: number) {
  return smoothSeriesPath(histRows.value.map(r => accessor(r)), max)
}

// ── 刻度 / 时间轴 / 悬停读数（不引图表库，全部沿用 0..100 坐标）──
type ChartKind = 'rt' | 'net' | 'hist'
interface TipLine { name: string; value: string; color: string }
const hover = ref<{ kind: ChartKind; index: number; left: number } | null>(null)

const pctTicks = axisTicks(100, v => v.toFixed(0))
const netTicks = computed(() => axisTicks(netMaxBps.value / 1e6, v => v.toFixed(v >= 10 ? 0 : 1)))

function memPctOf(s: Sample) { return s.mem_total_kib ? s.mem_used_kib / s.mem_total_kib * 100 : 0 }
function diskPctOf(s: Sample) { return s.disk_total_bytes ? s.disk_used_bytes / s.disk_total_bytes * 100 : 0 }

function hms(ts?: number) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
}
function mdhm(ts?: number) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const rtFrom = computed(() => hms(buf.value[0]?.ts))
const rtTo = computed(() => hms(buf.value.at(-1)?.ts))
const histFrom = computed(() => mdhm(histRows.value[0]?.[0]))
const histTo = computed(() => mdhm(histRows.value.at(-1)?.[0]))

function onHover(e: MouseEvent, kind: ChartKind, count: number) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  if (!rect.width || count < 2) return
  const ratio = (e.clientX - rect.left) / rect.width
  hover.value = { kind, index: nearestIndex(ratio, count), left: tipLeft(ratio) }
}
const cursorX = computed(() => {
  const h = hover.value
  if (!h) return 0
  const n = h.kind === 'hist' ? histRows.value.length : buf.value.length
  return n > 1 ? (h.index / (n - 1)) * 100 : 0
})
const tip = computed<{ time: string; lines: TipLine[] } | null>(() => {
  const h = hover.value
  if (!h) return null
  if (h.kind === 'hist') {
    const r = histRows.value[h.index]
    if (!r) return null
    const total = last.value?.mem_total_kib
    return {
      time: mdhm(r[0]),
      lines: [
        { name: 'CPU', value: `${r[1].toFixed(1)}%`, color: COLOR.cpu },
        { name: '内存', value: total ? `${(r[2] / Math.max(1, total) * 100).toFixed(1)}%` : '—', color: COLOR.mem },
        { name: '负载', value: r[3].toFixed(2), color: COLOR.load },
      ],
    }
  }
  const s = buf.value[h.index]
  if (!s) return null
  if (h.kind === 'net') {
    return {
      time: hms(s.ts),
      lines: [
        { name: '入站', value: `${mbps(s.net_in_bps)} Mbps`, color: NET.in },
        { name: '出站', value: `${mbps(s.net_out_bps)} Mbps`, color: NET.out },
      ],
    }
  }
  return {
    time: hms(s.ts),
    lines: [
      { name: 'CPU', value: `${s.cpu.toFixed(1)}%`, color: COLOR.cpu },
      { name: '内存', value: `${memPctOf(s).toFixed(1)}%`, color: COLOR.mem },
      { name: '负载', value: s.load1.toFixed(2), color: COLOR.load },
      { name: '磁盘', value: `${diskPctOf(s).toFixed(1)}%`, color: COLOR.disk },
    ],
  }
})
</script>

<template>
  <div>
    <p v-if="rtError" class="err" role="alert">{{ rtError }}</p>

    <!-- 顶部读数：与「专业快照」页取同一采样序列的末样本，同一时刻两页读数一致 -->
    <MetricHeader :items="hdrItems" :sampled-at="last?.ts ?? null"
      source-hint="最近 60 秒的末样本；与「专业快照」页顶端读数同源，同一时刻两页一致。" />

    <!-- 实时曲线：CPU / 内存 / 负载 / 磁盘 四系列 -->
    <div class="sec-head">
      <Icon name="chart" :size="16" /> 实时曲线
      <span class="legend">
        <i class="lg" :style="{ background: COLOR.cpu }" /> CPU {{ (last?.cpu ?? 0).toFixed(0) }}%
        <i class="lg" :style="{ background: COLOR.mem }" /> 内存 {{ memPct.toFixed(0) }}%
        <i class="lg" :style="{ background: COLOR.load }" /> 负载 {{ (last?.load1 ?? 0).toFixed(2) }}
        <i class="lg" :style="{ background: COLOR.disk }" /> 磁盘 {{ diskPct.toFixed(0) }}%
      </span>
    </div>
    <p class="sec-note">最近 60 秒，每 {{ interval }}ms 刷新；悬停查看各点数值。</p>
    <div v-if="buf.length" class="card chart">
      <div class="plot">
        <div class="axis-y">
          <span v-for="t in pctTicks" :key="t.y" :style="{ top: t.y + '%' }">{{ t.label }}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi"
             @mousemove="onHover($event, 'rt', buf.length)" @mouseleave="hover = null">
          <line v-for="t in pctTicks" :key="t.y" class="grid" x1="0" :y1="t.y" x2="100" :y2="t.y" vector-effect="non-scaling-stroke" />
          <line class="threshold hot" x1="0" :y1="valueY(60, 100)" x2="100" :y2="valueY(60, 100)" vector-effect="non-scaling-stroke" />
          <line class="threshold danger" x1="0" :y1="valueY(85, 100)" x2="100" :y2="valueY(85, 100)" vector-effect="non-scaling-stroke" />
          <path :d="cpuPath" fill="none" :style="{ stroke: COLOR.cpu }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="memPath" fill="none" :style="{ stroke: COLOR.mem }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="loadPath" fill="none" :style="{ stroke: COLOR.load }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="diskPath" fill="none" :style="{ stroke: COLOR.disk }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <line v-if="hover?.kind === 'rt'" class="cursor" :x1="cursorX" y1="0" :x2="cursorX" y2="100" vector-effect="non-scaling-stroke" />
        </svg>
        <div v-if="hover?.kind === 'rt' && tip" class="tip" :style="{ left: (hover?.left ?? 50) + '%' }">
          <div class="tip-time">{{ tip.time }}</div>
          <div v-for="l in tip?.lines ?? []" :key="l.name" class="tip-line">
            <span class="tip-name"><i class="tip-dot" :style="{ '--dot': l.color }" />{{ l.name }}</span><b>{{ l.value }}</b>
          </div>
        </div>
      </div>
      <div class="axis-x"><span>{{ rtFrom }}</span><span>现在 {{ rtTo }}</span></div>
      <p class="threshold-note">虚线：60% 偏热 · 85% 危险</p>
    </div>
    <EmptyState v-else title="暂无采样数据" hint="采集启动后会自动出现" />

    <!-- 网络吞吐：入/出双线（量纲为速率，与主曲线分开以免混淆） -->
    <div class="sec-head">
      <Icon name="network" :size="16" /> 网络吞吐
      <span class="legend">
        <i class="lg" :style="{ background: NET.in }" /> 入站 {{ mbps(last?.net_in_bps ?? 0) }} Mbps
        <i class="lg" :style="{ background: NET.out }" /> 出站 {{ mbps(last?.net_out_bps ?? 0) }} Mbps
      </span>
    </div>
    <p class="sec-note">入 / 出速率，单位 Mbps；悬停查看各点数值。历史视图目前只提供 CPU / 内存 / 负载。</p>
    <div v-if="buf.length" class="card chart">
      <div class="plot">
        <div class="axis-y">
          <span v-for="t in netTicks" :key="t.y" :style="{ top: t.y + '%' }">{{ t.label }}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi"
             @mousemove="onHover($event, 'net', buf.length)" @mouseleave="hover = null">
          <line v-for="t in netTicks" :key="t.y" class="grid" x1="0" :y1="t.y" x2="100" :y2="t.y" vector-effect="non-scaling-stroke" />
          <path :d="netInPath" fill="none" :style="{ stroke: NET.in }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="netOutPath" fill="none" :style="{ stroke: NET.out }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <line v-if="hover?.kind === 'net'" class="cursor" :x1="cursorX" y1="0" :x2="cursorX" y2="100" vector-effect="non-scaling-stroke" />
        </svg>
        <div v-if="hover?.kind === 'net' && tip" class="tip" :style="{ left: (hover?.left ?? 50) + '%' }">
          <div class="tip-time">{{ tip.time }}</div>
          <div v-for="l in tip?.lines ?? []" :key="l.name" class="tip-line">
            <span class="tip-name"><i class="tip-dot" :style="{ '--dot': l.color }" />{{ l.name }}</span><b>{{ l.value }}</b>
          </div>
        </div>
      </div>
      <div class="axis-x"><span>{{ rtFrom }}</span><span>现在 {{ rtTo }}</span></div>
    </div>
    <EmptyState v-else title="暂无采样数据" hint="采集启动后会自动出现" />

    <!-- 历史趋势：持久化长时趋势（nano 档位不落盘） -->
    <div class="sec-head">
      <Icon name="clock" :size="16" /> 历史趋势
      <span class="gran">
        <button class="chip" :class="{ on: gran === '1m' }" @click="gran = '1m'; loadHistory()">1m</button>
        <button class="chip" :class="{ on: gran === '1h' }" @click="gran = '1h'; loadHistory()">1h</button>
      </span>
    </div>
    <p class="sec-note">1m 每点代表 1 分钟，可回看 7 天；1h 每点代表 1 小时，可回看 90 天。悬停查看各点数值。</p>
    <EmptyState v-if="historyUnavailable"
      title="nano 档位不提供历史曲线"
      hint="升级档位后即可查看长时趋势" />
    <div v-else-if="histRows.length" class="card chart">
      <div class="plot">
        <div class="axis-y">
          <span v-for="t in pctTicks" :key="t.y" :style="{ top: t.y + '%' }">{{ t.label }}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi"
             @mousemove="onHover($event, 'hist', histRows.length)" @mouseleave="hover = null">
          <line v-for="t in pctTicks" :key="t.y" class="grid" x1="0" :y1="t.y" x2="100" :y2="t.y" vector-effect="non-scaling-stroke" />
          <path :d="histCpuPath" fill="none" :style="{ stroke: COLOR.cpu }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="histMemPath" fill="none" :style="{ stroke: COLOR.mem }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="histLoadPath" fill="none" :style="{ stroke: COLOR.load }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
          <line v-if="hover?.kind === 'hist'" class="cursor" :x1="cursorX" y1="0" :x2="cursorX" y2="100" vector-effect="non-scaling-stroke" />
        </svg>
        <div v-if="hover?.kind === 'hist' && tip" class="tip" :style="{ left: (hover?.left ?? 50) + '%' }">
          <div class="tip-time">{{ tip.time }}</div>
          <div v-for="l in tip?.lines ?? []" :key="l.name" class="tip-line">
            <span class="tip-name"><i class="tip-dot" :style="{ '--dot': l.color }" />{{ l.name }}</span><b>{{ l.value }}</b>
          </div>
        </div>
      </div>
      <div class="axis-x"><span>{{ histFrom }}</span><span>{{ histTo }}</span></div>
      <p class="dim pad">CPU / 内存 / 负载 · {{ gran === '1m' ? '每点 1 分钟' : '每点 1 小时' }}；负载纵轴自适应</p>
    </div>
    <EmptyState v-else title="历史数据为空" hint="运行片刻后即可查看" />

  </div>
</template>

<style scoped>
.chart { padding: 10px; }
.chart svg { width: 100%; height: 130px; display: block; }
.chart svg.multi { height: 150px; }
.plot { position: relative; display: flex; gap: 6px; }
.plot svg { flex: 1; width: auto; min-width: 0; }
.axis-y { position: relative; width: 34px; flex: none; }
.axis-y span { position: absolute; right: 0; transform: translateY(-50%);
  font-size: var(--fs-12); color: var(--c-text-dim); }
.axis-x { display: flex; justify-content: space-between; margin: 4px 0 0 40px;
  font-size: var(--fs-12); color: var(--c-text-dim); }
.grid { stroke: var(--c-border); stroke-width: 1; }
.threshold { stroke-width: 1; stroke-dasharray: 4 3; }
.threshold.hot { stroke: var(--chart-hot); }
.threshold.danger { stroke: var(--c-danger); }
.cursor { stroke: var(--c-text-dim); stroke-width: 1; stroke-dasharray: 2 2; }
.threshold-note { margin: 4px 0 0 40px; font-size: var(--fs-12); color: var(--c-text-dim); }
.tip { position: absolute; top: 4px; transform: translateX(-50%); min-width: 118px;
  padding: 6px 8px; background: var(--c-surface); border: 1px solid var(--c-border);
  border-radius: var(--radius-xs); pointer-events: none; }
.tip-time { color: var(--c-text-dim); font-size: var(--fs-12); margin-bottom: 3px; }
.tip-line { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  font-size: var(--fs-12); line-height: 1.6; white-space: nowrap; }
.tip-name { display: inline-flex; align-items: center; gap: 5px; color: var(--c-text-dim); }
.tip-dot { width: 7px; height: 7px; border-radius: 999px; display: inline-block; background: var(--dot); }
.tip-line b { color: var(--c-text); font-weight: 600; }
.pad { padding: 4px 2px 0; margin: 0; }
/* 模块说明：与图例/曲线配套，避免与页面副标重复 */
.sec-note { margin: 6px 2px 12px; font-size: var(--fs-12-5); line-height: 1.7; color: var(--c-text-dim); }
.sec-note b { color: var(--c-text); font-weight: 600; }
.sec-note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 5px; border-radius: var(--radius-chip); color: var(--c-text); }
.legend { margin-left: auto; display: inline-flex; gap: 14px; align-items: center;
  font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 500; }
.lg { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 5px;
  vertical-align: middle; }
.gran { margin-left: auto; display: inline-flex; gap: 6px; }
.chip { font: inherit; font-size: var(--fs-12); padding: 3px 11px; border-radius: 999px; cursor: pointer;
  color: var(--c-text-dim); background: transparent; border: 1px solid var(--c-border); transition: all .15s; }
.chip:hover { color: var(--c-text); border-color: color-mix(in srgb, var(--c-primary) 50%, var(--c-border)); }
  .chip.on { color: var(--c-on-accent); background: var(--gradient); border-color: transparent; }
</style>

<script setup lang="ts">
/**
 * 主机监控。
 * 与首页概览的分工：概览看全貌（经 SSE 实时推送），本页看时间趋势（实时滚动 + 持久化历史）。
 * 曲线用自绘 SVG（不引图表库，守 150KB 首屏预算）。
 *
 * 实时指标 5 项：CPU / 内存 / 负载 / 磁盘使用率 / 网络吞吐（入·出）。
 * 其中磁盘与网络为实时采集，后端 history 聚合表仅落盘 CPU / 内存 / 负载，
 * 故历史趋势模块不含磁盘/网络（见页面说明）。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import MetricHeader, { type MetricItem } from '@/components/MetricHeader.vue'
import { cpuTone } from '@/composables/metricTone'
import { usePolling } from '@/composables/usePolling'
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
  try { history.value = await api.get(API.metrics.history(), { params: { gran: gran.value } }) }
  catch { /* 保留上一帧：history 随 realtime 轮询重拉，确定性失败已在 rtError 提示 */ }
}

// 实时曲线：间隔取后端采样间隔（1~3s 夹取）。间隔是**变量**——自调度链在
// 下一次调度即用新值，不需要 watch + 手写重建。旧实现这段手写了两次（onMounted
// 与 onVisibility 各一份），注释里"恢复前先清旧句柄否则两个定时器同时跑"的坑
// 正是手写的产物；交给 usePolling 后隐藏暂停/回可见补拉/卸载清理都不再出现。
const rtPollMs = () => Math.min(Math.max(interval.value || 2000, 1000), 3000)
usePolling({ fn: loadRealtime, ms: rtPollMs })
// 历史曲线 30s 一轮（变化慢，且 nano 档自身会短路）
usePolling({ fn: loadHistory, ms: 30_000 })

onMounted(() => { loadRealtime(); loadHistory() })

const last = computed(() => buf.value.at(-1))
const memPct = computed(() =>
  last.value && last.value.mem_total_kib ? (last.value.mem_used_kib / last.value.mem_total_kib * 100) : 0)
const diskPct = computed(() =>
  last.value && last.value.disk_total_bytes ? (last.value.disk_used_bytes / last.value.disk_total_bytes * 100) : 0)

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

/** 把缓冲序列映射成 SVG polyline 点串；缓冲定长 → x 间距恒定 → 滚动不跳变 */
function buildPoints(accessor: (s: Sample) => number, max: number) {
  const n = buf.value.length
  if (n < 2) return ''
  return buf.value.map((s, i) => {
    const v = Math.min(Math.max(accessor(s), 0), max)
    const x = (i / (n - 1) * 100).toFixed(2)
    const y = (100 - (v / max) * 100).toFixed(2)
    return `${x},${y}`
  }).join(' ')
}

const cpuPts = computed(() => buildPoints(s => s.cpu, 100))
const memPts = computed(() => buildPoints(() => memPct.value, 100))
const loadPts = computed(() => buildPoints(s => s.load1, loadMax.value))
const diskPts = computed(() =>
  buildPoints(s => s.disk_total_bytes ? (s.disk_used_bytes / s.disk_total_bytes * 100) : 0, 100))
const netInPts = computed(() => buildPoints(s => s.net_in_bps, netMaxBps.value))
const netOutPts = computed(() => buildPoints(s => s.net_out_bps, netMaxBps.value))

function mbps(bps: number) { return (bps / 1e6).toFixed(1) }

// ── 历史曲线（长时趋势）──
const histRows = computed<HistRow[]>(() => history.value?.samples ?? [])
const historyUnavailable = computed(() =>
  auth.me?.tier === 'nano' || !!history.value?.unavailable)
const histCpuPts = computed(() => buildHist(r => r[1], 100))
// 历史样本只记录 mem_used_kib，总量只有实时快照里有。快照尚未到达时不能拿
// "已用×4" 当总量——那会让曲线恒为 25%，是个编出来的数字。改为总量未知时先不画
// （polyline points 为空即不渲染），等快照到达后按真实总量绘制。
const histMemPts = computed(() => {
  const total = last.value?.mem_total_kib
  if (!total) return ''
  return buildHist(r => r[2] / Math.max(1, total) * 100, 100)
})
const histLoadMax = computed(() => Math.max(2, ...histRows.value.map(r => r[3])))
const histLoadPts = computed(() => buildHist(r => r[3], histLoadMax.value))

function buildHist(accessor: (r: HistRow) => number, max: number) {
  const n = histRows.value.length
  if (n < 2) return ''
  return histRows.value.map((r, i) => {
    const v = Math.min(Math.max(accessor(r), 0), max)
    const x = (i / (n - 1) * 100).toFixed(2)
    const y = (100 - (v / max) * 100).toFixed(2)
    return `${x},${y}`
  }).join(' ')
}
</script>

<template>
  <div>
    <p v-if="rtError" class="err" role="alert">{{ rtError }}</p>

    <!-- 顶部读数（A2）：与「专业快照」页共用 MetricHeader + 同一采样序列（环形缓冲），
         同一时刻两页读数一致；下方曲线为趋势呈现 -->
    <MetricHeader :items="hdrItems" :sampled-at="last?.ts ?? null"
      source-hint="取自面板统一的 60 秒滚动采样序列（每 2 秒采样一次）；与「专业快照」页顶端读数同源，同一时刻两页一致。" />

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
    <p class="sec-note">
      最近 60 秒滚动采样，每 {{ interval }}ms 自动刷新；曲线随新数据自右向左平滑滚动，颜色对应上方图例。
    </p>
    <div v-if="buf.length" class="card chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi">
        <polyline :points="cpuPts" fill="none" :style="{ stroke: COLOR.cpu }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="memPts" fill="none" :style="{ stroke: COLOR.mem }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="loadPts" fill="none" :style="{ stroke: COLOR.load }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="diskPts" fill="none" :style="{ stroke: COLOR.disk }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    </div>
    <EmptyState v-else title="暂无采样数据" hint="采集由内部调度器驱动，稍候自动出现" />

    <!-- 网络吞吐：入/出双线（量纲为速率，与主曲线分开以免混淆） -->
    <div class="sec-head">
      <Icon name="network" :size="16" /> 网络吞吐
      <span class="legend">
        <i class="lg" :style="{ background: NET.in }" /> 入站 {{ mbps(last?.net_in_bps ?? 0) }} Mbps
        <i class="lg" :style="{ background: NET.out }" /> 出站 {{ mbps(last?.net_out_bps ?? 0) }} Mbps
      </span>
    </div>
    <p class="sec-note">
      实时采样速率（排除回环接口），单位 Mbps；曲线随新数据平滑滚动。<b>网络为实时指标，不落盘历史。</b>
    </p>
    <div v-if="buf.length" class="card chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi">
        <polyline :points="netInPts" fill="none" :style="{ stroke: NET.in }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="netOutPts" fill="none" :style="{ stroke: NET.out }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    </div>
    <EmptyState v-else title="暂无采样数据" hint="采集由内部调度器驱动，稍候自动出现" />

    <!-- 历史趋势：持久化长时趋势（nano 档位不落盘） -->
    <div class="sec-head">
      <Icon name="clock" :size="16" /> 历史趋势
      <span class="gran">
        <button class="chip" :class="{ on: gran === '1m' }" @click="gran = '1m'; loadHistory()">1m</button>
        <button class="chip" :class="{ on: gran === '1h' }" @click="gran = '1h'; loadHistory()">1h</button>
      </span>
    </div>
    <p class="sec-note">
      <b>设计目的：</b>将内存环形缓冲中的实时采样聚合并落盘，形成可回看的长时趋势，弥补实时曲线只保留近 60 秒的局限。<br>
      <b>数据含义：</b>每个点来自已落盘的聚合表——<code>1m</code> 粒度下每点代表「该 1 分钟内的聚合值」（默认保留 7 天），<code>1h</code> 粒度下每点代表「该 1 小时内的聚合值」（保留 90 天）。<br>
      <b>关于「1m」：</b>它是<strong>聚合粒度（一个点的时间桶宽）</strong>，并非「仅过去 1 分钟」。整条曲线覆盖服务运行以来已落盘的全部历史；nano 档位不落盘，故无此模块。<br>
      <b>覆盖范围：</b>历史聚合表当前落盘 <strong>CPU / 内存 / 负载</strong> 三项；磁盘与网络为实时指标，未进入历史聚合，故本模块不含二者。
    </p>
    <EmptyState v-if="historyUnavailable"
      title="nano 档位不落盘历史数据"
      hint="512MB 机器仅保留内存环形缓冲，升级档位后即可查看长时曲线" />
    <div v-else-if="histRows.length" class="card chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="multi">
        <polyline :points="histCpuPts" fill="none" :style="{ stroke: COLOR.cpu }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="histMemPts" fill="none" :style="{ stroke: COLOR.mem }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        <polyline :points="histLoadPts" fill="none" :style="{ stroke: COLOR.load }" stroke-width="1"
                  vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
      <p class="dim pad">CPU / 内存 / 负载 历史趋势 · 当前粒度 {{ gran === '1m' ? '1 分钟' : '1 小时' }}</p>
    </div>
    <EmptyState v-else title="历史数据为空" hint="服务运行片刻后开始聚合落盘" />
  </div>
</template>

<style scoped>
.chart { padding: 10px; }
.chart svg { width: 100%; height: 130px; display: block; }
.chart svg.multi { height: 150px; }
.pad { padding: 4px 2px 0; margin: 0; }
/* 模块说明：与图例/曲线配套，避免与页面副标重复 */
.sec-note { margin: 6px 2px 12px; font-size: var(--fs-12-5); line-height: 1.7; color: var(--c-text-dim); }
.sec-note b { color: var(--c-text); font-weight: 600; }
.sec-note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 5px; border-radius: 4px; color: var(--c-text); }
.legend { margin-left: auto; display: inline-flex; gap: 14px; align-items: center;
  font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 500; }
.lg { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 5px;
  vertical-align: middle; }
.gran { margin-left: auto; display: inline-flex; gap: 6px; }
.chip { font: inherit; font-size: var(--fs-12); padding: 3px 11px; border-radius: 999px; cursor: pointer;
  color: var(--c-text-dim); background: transparent; border: 1px solid var(--c-border); transition: all .15s; }
.chip:hover { color: var(--c-text); border-color: color-mix(in srgb, var(--c-primary) 50%, var(--c-border)); }
.chip.on { color: #fff; background: var(--gradient); border-color: transparent; }
</style>

<script setup lang="ts">
/**
 * 专业监控页。
 * 与「主机监控(SystemView)」的分工：SystemView 看时间趋势（实时滚动 + 历史落盘），
 * 本页看**完整结构快照**——CPU 每核、负载 1/5/15、内存 + 交换明细、每挂载点磁盘、
 * 每网卡吞吐、进程数 + Top 进程。数据来自后端已采集的 SystemSnapshot，纯按需拉取，
 * 每 2 秒刷新快照 / 3 秒刷新进程（procfs 读取开销 <0.02ms，轮询极轻）。
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { SystemSnapshot, ProcessInfo } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const snap = ref<SystemSnapshot | null>(null)
const procs = ref<ProcessInfo[]>([])
const procSort = ref<'cpu' | 'mem'>('cpu')
const loading = ref(true)
const procError = ref('')

// 配色：与主机监控页图例一致，彼此对比鲜明
const C = {
  cpu: '#ff6a3d', mem: '#36c5d6', swap: '#ffb454', disk: '#4cd07d',
  netIn: '#4ea1ff', netOut: '#ffb454', load: '#b48cff', danger: '#ff4d4d', hot: '#ff9a3d',
}

const cpuPct = computed(() => snap.value?.cpu.total_pct ?? 0)
const perCore = computed<number[]>(() => snap.value?.cpu.per_core_pct ?? [])
const cores = computed(() => perCore.value.length)
const loads = computed<number[]>(() => {
  const c = snap.value?.cpu
  return [c?.load1 ?? 0, c?.load5 ?? 0, c?.load15 ?? 0]
})
const memPct = computed(() => {
  const m = snap.value?.mem
  return m && m.total_kib ? (m.used_kib / m.total_kib) * 100 : 0
})
const swapTotalKib = computed(() => snap.value?.mem.swap_total_kib ?? 0)
const swapUsedKib = computed(() => snap.value?.mem.swap_used_kib ?? 0)
const swapPct = computed(() => (swapTotalKib.value ? (swapUsedKib.value / swapTotalKib.value) * 100 : 0))
const swapActive = computed(() => swapTotalKib.value > 0)
const procCount = computed(() => snap.value?.proc_count ?? 0)

const diskRows = computed(() => (snap.value?.disks ?? []).map(d => ({
  mount: d.mount_point, device: d.device, fs: d.fs_type,
  pct: d.total_bytes ? (d.used_bytes / d.total_bytes) * 100 : 0,
  used: d.used_bytes, total: d.total_bytes, net: d.is_network_fs,
})))
const netRows = computed(() => (snap.value?.nets ?? [])
  .filter(n => n.iface !== 'lo')
  .map(n => ({ iface: n.iface, rx: n.rx_rate_bps, tx: n.tx_rate_bps })))

// 温度传感器：来自 /sys/class/hwmon；无 hwmon 的机器（多数虚拟机）为空，模板给 EmptyState
const tempRows = computed(() => (snap.value?.temps ?? []).map(t => ({
  chip: t.chip, label: t.label, celsius: t.celsius, critical: t.critical,
})))

// 内存明细（字节格式化后下发，避免模板算术）
const memUsedStr = computed(() => fmtBytes((snap.value?.mem.used_kib ?? 0) * 1024))
const memAvailStr = computed(() => fmtBytes((snap.value?.mem.available_kib ?? 0) * 1024))
const memBufStr = computed(() => fmtBytes((snap.value?.mem.buffers_kib ?? 0) * 1024))
const memCacheStr = computed(() => fmtBytes((snap.value?.mem.cached_kib ?? 0) * 1024))
const swapUsedStr = computed(() => fmtBytes(swapUsedKib.value * 1024))
const swapTotalStr = computed(() => fmtBytes(swapTotalKib.value * 1024))

function fmtBytes(b: number): string {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i]
}
function fmtMbps(bps: number): string { return (bps / 1e6).toFixed(2) }
function fmtPct(x: number): string { return x.toFixed(1) }
function coreColor(p: number): string { return p >= 85 ? C.danger : p >= 60 ? C.hot : C.cpu }
function loadColor(l: number): string {
  const r = cores.value ? l / cores.value : 0
  return r >= 1 ? C.danger : r >= 0.7 ? C.hot : C.load
}
function loadRatio(l: number): number {
  const r = cores.value ? l / cores.value : 0
  return Math.min(r / 2, 1) * 100 // 以 2×核心数为满刻度
}

/** 确定性失败（501 未实现 / 403 无权限）的显式提示；网络抖动保持静默重试 */
const snapError = ref('')

async function loadSnapshot() {
  try {
    snap.value = await api.get<SystemSnapshot>(API.metrics.snapshot())
    snapError.value = ''
  } catch (e) {
    // 保留上一帧避免网络抖动闪空是对的；但 501/403 是确定性失败，
    // 一直静默会让「暂无数据」变成排障黑洞（审计 F19）
    if (isUnsupported(e)) snapError.value = errorText(e)
  }
  finally { loading.value = false }
}
async function loadProcs() {
  procError.value = ''
  try {
    procs.value = await api.get<ProcessInfo[]>(API.processes.list(),
      { params: { sort: procSort.value, limit: 15 } })
  } catch (e) { procError.value = errorText(e) }
}
function switchSort(s: 'cpu' | 'mem') { procSort.value = s; loadProcs() }

let rtTimer: number | undefined, procTimer: number | undefined

/** 页面隐藏暂停轮询、可见时补一次再恢复（审计 P9） */
function onVisibility() {
  if (document.hidden) {
    if (rtTimer) { clearInterval(rtTimer); rtTimer = undefined }
    if (procTimer) { clearInterval(procTimer); procTimer = undefined }
  } else {
    loadSnapshot(); loadProcs()
    rtTimer = window.setInterval(loadSnapshot, 2000)
    procTimer = window.setInterval(loadProcs, 3000)
  }
}

onMounted(() => {
  loadSnapshot(); loadProcs()
  rtTimer = window.setInterval(loadSnapshot, 2000)
  procTimer = window.setInterval(loadProcs, 3000)
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  if (rtTimer) clearInterval(rtTimer)
  if (procTimer) clearInterval(procTimer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <span class="tier-chip">{{ auth.me?.tier ?? '-' }}</span>
      </div>
    </div>

    <p v-if="snapError" class="err" role="alert">{{ snapError }}</p>

    <div v-if="loading && !snap" class="card skeleton" style="height:280px" />
    <template v-else-if="snap">
      <!-- 顶部读数 -->
      <div class="grid cols-4">
        <MetricCard label="CPU 总体" :value="fmtPct(cpuPct)" unit="%" icon="cpu" tone="primary" :progress="cpuPct" />
        <MetricCard label="内存" :value="fmtPct(memPct)" unit="%" icon="disk" tone="cyan" :progress="memPct" />
        <MetricCard label="负载 1m" :value="loads[0].toFixed(2)" unit="" icon="gauge" tone="warn" />
        <MetricCard label="进程数" :value="String(procCount)" unit="" icon="process" tone="primary" />
      </div>

      <!-- CPU 详情：每核 + 负载 -->
      <div class="sec-head"><Icon name="cpu" :size="16" /> CPU 使用率（每核）</div>
      <div class="card cpu-detail">
        <div class="cores">
          <div v-for="(p, i) in perCore" :key="i" class="core"
               :style="{ height: Math.max(2, p) + '%', background: coreColor(p) }"
               :title="`核 ${i}: ${fmtPct(p)}%`" />
        </div>
        <div class="core-axis"><span>0%</span><span>{{ cores }} 核</span><span>100%</span></div>
        <div class="load-row">
          <div class="load-item" v-for="(l, i) in loads" :key="i">
            <span class="lk">负载 {{ ['1m', '5m', '15m'][i] }}</span>
            <b :style="{ color: loadColor(l) }">{{ fmtPct(l) }}</b>
            <div class="prog"><div class="fill" :style="{ width: loadRatio(l) + '%', background: loadColor(l) }" /></div>
          </div>
        </div>
        <p class="sec-note">
          每核柱状为实时使用率；负载读数以核心数（{{ cores }}）为基准，≥1 表示饱和（红色警示）。
          每 2 秒刷新快照。
        </p>
      </div>

      <!-- 内存与交换 -->
      <div class="sec-head"><Icon name="disk" :size="16" /> 内存与交换</div>
      <div class="card mem-detail">
        <div class="kv">
          <div class="kvi"><span>已用</span><b>{{ memUsedStr }}</b></div>
          <div class="kvi"><span>可用</span><b>{{ memAvailStr }}</b></div>
          <div class="kvi"><span>buffers</span><b>{{ memBufStr }}</b></div>
          <div class="kvi"><span>cached</span><b>{{ memCacheStr }}</b></div>
        </div>
        <template v-if="swapActive">
          <div class="swap-head">
            <span>交换分区</span><b>{{ fmtPct(swapPct) }}%</b>
            <span class="dim">{{ swapUsedStr }} / {{ swapTotalStr }}</span>
          </div>
          <div class="prog"><div class="fill" :style="{ width: swapPct + '%', background: C.swap }" /></div>
        </template>
        <p v-else class="sec-note">未配置交换分区。</p>
      </div>

      <!-- 磁盘：每挂载点 -->
      <div class="sec-head"><Icon name="database" :size="16" /> 磁盘（每挂载点）</div>
      <div v-if="diskRows.length" class="cards-2">
        <div v-for="d in diskRows" :key="d.mount" class="card disk">
          <div class="disk-top">
            <span class="mount">{{ d.mount }}</span>
            <span v-if="d.net" class="badge warn">网络 FS</span>
          </div>
          <div class="disk-sub">{{ d.device }} · {{ d.fs }}</div>
          <div class="prog"><div class="fill" :style="{ width: d.pct + '%', background: d.net ? C.hot : C.disk }" /></div>
          <div class="disk-foot"><b>{{ fmtPct(d.pct) }}%</b><span class="dim">{{ fmtBytes(d.used) }} / {{ fmtBytes(d.total) }}</span></div>
        </div>
      </div>
      <!-- 空态放 grid 外（审计 U13）：作为 grid 子元素只占一列，排版破碎 -->
      <EmptyState v-else title="无磁盘数据" />

      <!-- 网络：每网卡 -->
      <div class="sec-head"><Icon name="network" :size="16" /> 网络吞吐（每网卡）</div>
      <div v-if="netRows.length" class="cards-2">
        <div v-for="n in netRows" :key="n.iface" class="card net">
          <div class="net-top"><span class="iface">{{ n.iface }}</span></div>
          <div class="net-row"><span class="lk" :style="{ color: C.netIn }">入站</span><b>{{ fmtMbps(n.rx) }} Mbps</b></div>
          <div class="prog"><div class="fill" :style="{ width: Math.min(100, (n.rx / 1e8) * 100) + '%', background: C.netIn }" /></div>
          <div class="net-row"><span class="lk" :style="{ color: C.netOut }">出站</span><b>{{ fmtMbps(n.tx) }} Mbps</b></div>
          <div class="prog"><div class="fill" :style="{ width: Math.min(100, (n.tx / 1e8) * 100) + '%', background: C.netOut }" /></div>
        </div>
      </div>
      <EmptyState v-else title="无网络接口" />

      <!-- 温度（hwmon） -->
      <div class="sec-head"><Icon name="cpu" :size="16" /> 温度传感器</div>
      <div v-if="tempRows.length" class="cards-2">
        <div v-for="t in tempRows" :key="t.chip + ':' + t.label" class="card temp">
          <div class="temp-top">
            <span class="tlabel">{{ t.label }}</span>
            <span class="chip-name">{{ t.chip }}</span>
          </div>
          <div class="temp-val" :style="{ color: t.critical ? C.danger : C.disk }">
            <b>{{ t.celsius.toFixed(1) }}</b><span class="unit">°C</span>
          </div>
          <div class="prog">
            <div class="fill" :style="{ width: Math.min(100, t.celsius) + '%', background: t.critical ? C.danger : C.disk }" />
          </div>
          <div v-if="t.critical" class="temp-warn">已达临界温度</div>
        </div>
      </div>
      <EmptyState v-else title="无温度传感器（本机无 /sys/class/hwmon）" />

      <!-- 进程 -->
      <div class="sec-head">
        <Icon name="process" :size="16" /> 进程（Top {{ procs.length }}）
        <span class="gran">
          <button class="chip" :class="{ on: procSort === 'cpu' }" @click="switchSort('cpu')">CPU</button>
          <button class="chip" :class="{ on: procSort === 'mem' }" @click="switchSort('mem')">内存</button>
        </span>
      </div>
      <p v-if="procError" class="err">{{ procError }}</p>
      <div class="card flush">
        <table>
          <thead><tr><th>PID</th><th>进程</th><th class="num">CPU</th><th class="num">内存</th><th>用户</th></tr></thead>
          <tbody>
            <tr v-for="p in procs" :key="p.pid">
              <td class="mono">{{ p.pid }}</td>
              <td>{{ p.name }}</td>
              <td class="num">{{ fmtPct(p.cpu_pct) }}%</td>
              <td class="num">{{ (p.rss_kib / 1024).toFixed(0) }} MB</td>
              <td>{{ p.user ?? '-' }}</td>
            </tr>
            <tr v-if="!procs.length"><td colspan="5"><EmptyState title="无进程数据" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>
    <EmptyState v-else title="暂无快照数据" hint="采集由内部调度器驱动，稍候自动出现" />
  </div>
</template>

<style scoped>
.card.flush { padding: 0; overflow: hidden; }
.skeleton { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

.sec-head { display: flex; align-items: center; gap: 8px; margin: 22px 2px 10px;
  font-size: 15px; font-weight: 600; color: var(--c-text); }
.sec-note { margin: 8px 2px 4px; font-size: 12.5px; line-height: 1.7; color: var(--c-text-dim); }
.dim { color: var(--c-text-mute); }
.err { color: var(--c-danger); font-size: 13px; margin: 0 2px 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.tier-chip { font-size: 12px; font-weight: 600; vertical-align: middle; margin-left: 8px;
  padding: 2px 9px; border-radius: 999px; color: var(--c-ok);
  background: var(--c-ok-soft); border: 1px solid color-mix(in srgb, var(--c-ok) 35%, transparent); }

/* CPU 每核 + 负载 */
.cpu-detail { padding: 14px; }
.cores { display: flex; align-items: flex-end; gap: 3px; height: 96px; }
.core { flex: 1; min-width: 5px; border-radius: 3px 3px 0 0;
  transition: height .4s ease, background .4s; }
.core-axis { display: flex; justify-content: space-between; font-size: 11px;
  color: var(--c-text-mute); margin-top: 4px; }
.load-row { display: flex; gap: 14px; margin-top: 14px; }
.load-item { flex: 1; }
.lk { font-size: 12px; color: var(--c-text-dim); }
.load-item b { font-size: 16px; margin-left: 6px; }

/* 进度条（通用） */
.prog { height: 7px; border-radius: 999px; background: var(--c-border); overflow: hidden; margin-top: 5px; }
.prog > .fill { height: 100%; border-radius: 999px; transition: width .4s ease; }

/* 内存明细 */
.mem-detail { padding: 14px; }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.kvi { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--c-text-dim); }
.kvi b { font-size: 15px; color: var(--c-text); }
.swap-head { display: flex; align-items: center; gap: 8px; margin: 12px 0 5px; font-size: 13px; }
.swap-head .dim { margin-left: auto; }

/* 磁盘 / 网络网格 */
.cards-2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.disk, .net { padding: 13px; }
.disk-top, .net-top { display: flex; align-items: center; justify-content: space-between; }
.mount { font-weight: 600; font-size: 14px; word-break: break-all; }
.disk-sub { font-size: 12px; color: var(--c-text-mute); margin: 3px 0 9px; }
.disk-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 7px; font-size: 12px; }
.disk-foot b { font-size: 14px; }
.net-top .iface { font-weight: 600; font-size: 14px; }
.net-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; font-size: 13px; }
.net-row b { font-size: 14px; }
.temp { padding: 13px; }
.temp-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.temp-top .tlabel { font-weight: 600; font-size: 14px; }
.temp-top .chip-name { font-size: 11px; color: var(--c-text-mute); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.temp-val { margin-top: 8px; display: flex; align-items: baseline; gap: 3px; }
.temp-val b { font-size: 26px; font-weight: 650; line-height: 1; }
.temp-val .unit { font-size: 13px; opacity: .75; }
.temp-warn { margin-top: 6px; font-size: 12px; color: var(--c-danger); }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; }
.badge.warn { color: var(--c-warn); background: var(--c-warn-bg); border-color: transparent; }

/* 进程排序切换 */
.gran { margin-left: auto; display: inline-flex; gap: 6px; }
.chip { font: inherit; font-size: 12px; padding: 3px 11px; border-radius: 999px; cursor: pointer;
  color: var(--c-text-dim); background: transparent; border: 1px solid var(--c-border); transition: all .15s; }
.chip:hover { color: var(--c-text); border-color: color-mix(in srgb, var(--c-primary) 50%, var(--c-border)); }
.chip.on { color: #fff; background: var(--gradient); border-color: transparent; }

/* 进程表 */
table { width: 100%; border-collapse: collapse; }
th, td { padding: 9px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--c-border); }
th { color: var(--c-text-mute); font-weight: 600; }
td.num, th.num { text-align: right; }
tbody tr:hover { background: var(--c-hover); }
</style>

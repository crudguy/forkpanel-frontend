<script setup lang="ts">
/**
 * 仪表盘（概览首页）。
 *
 * 设计：能力缺失时不渲染假数据（沿用原有纪律）；实时数据经 SSE，nano 档位退化为轮询。
 * 指标来源 /api/v1/system/overview，实时增量由 /api/v1/events/metrics 推送（字段同 overview 子集）。
 */
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/api/client'
import { CAP } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const ov = ref<any>(null)
let timer: number | undefined
let es: EventSource | undefined

// 实时推送是 overview 的字段子集，必须「合并」而非整体替换——
// 否则 SSE 不含的 disk/net/alerts/uptime 等字段会被覆盖成 undefined（进而显示 0）。
function apply(d: any) { ov.value = { ...(ov.value || {}), ...d } }

async function poll() {
  try { const r = await api.get<any>('/api/v1/system/overview'); apply(r) } catch { /* 静默重试 */ }
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

const shortcuts = [
  { to: '/system', label: '主机监控', icon: 'cpu' },
  { to: '/services', label: '软件与服务', icon: 'server' },
  { to: '/sites', label: '网站与 SSL', icon: 'globe' },
  { to: '/databases', label: '数据库', icon: 'database' },
  { to: '/files', label: '文件', icon: 'folder' },
  { to: '/firewall', label: '安全', icon: 'shield' },
  { to: '/cron', label: '任务', icon: 'clock' },
  { to: '/cron/tasks', label: '任务中心', icon: 'tasks' },
  { to: '/users', label: '用户', icon: 'users' },
]

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

const alerts = computed<any[]>(() => ov.value?.alerts ?? [])

onMounted(async () => {
  await auth.loadMe()
  if (!auth.supported(CAP.METRICS_READ)) return
  await poll()
  if (auth.pollingMode) {
    timer = window.setInterval(poll, 10000)
  } else {
    es = new EventSource('/api/v1/events/metrics')
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
      <!-- 指标卡 -->
      <div class="grid cols-5">
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

      <!-- 快捷入口 -->
      <section class="card">
        <div class="sec-head"><Icon name="bolt" :size="16" /><span>快捷入口</span></div>
        <div class="quick">
          <RouterLink v-for="q in shortcuts" :key="q.to" :to="q.to" class="quick-item">
            <span class="q-ico"><Icon :name="q.icon" :size="20" /></span>
            <span class="q-label">{{ q.label }}</span>
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
              <span class="dot" :class="a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : 'ok'" />
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

.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; margin-bottom: 14px; }
.sec-head :deep(.icon) { color: var(--c-primary); }

.quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.quick-item { display: flex; flex-direction: column; align-items: center; gap: 9px;
              padding: 16px 10px; border-radius: 12px; text-decoration: none; color: var(--c-text);
              border: 1px solid var(--c-border); background: var(--c-surface-2);
              transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.quick-item:hover { transform: translateY(-3px); border-color: var(--c-border-strong); box-shadow: var(--shadow); }
.q-ico { width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center;
         background: var(--c-primary-soft); color: var(--c-primary); }
.quick-item:hover .q-ico { background: var(--gradient); color: #fff; box-shadow: var(--glow); }
.q-label { font-size: 13px; }

.info dl { margin: 0; display: flex; flex-direction: column; gap: 0; }
.info .row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--c-border); }
.info .row:last-child { border-bottom: none; }
.info dt { color: var(--c-text-dim); font-size: 13px; }
.info dd { margin: 0; font-size: 13.5px; font-weight: 500; }

.alerts ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.alerts li { display: flex; align-items: flex-start; gap: 9px; font-size: 13.5px; }
.alerts .a-msg { flex: 1; }
.ok-state { display: flex; align-items: center; gap: 9px; color: var(--c-text-dim); font-size: 13.5px; }
</style>

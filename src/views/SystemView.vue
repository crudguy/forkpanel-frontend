<script setup lang="ts">
/**
 * 系统监控。
 *
 * 刻意的处理：nano 档位下历史曲线不可用（不落盘），UI 明确说明原因，
 * 而不是画一条空曲线让人以为"没数据"。
 */
import { ref, onMounted, computed } from 'vue'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import MetricCard from '@/components/MetricCard.vue'
import EmptyState from '@/components/EmptyState.vue'

interface Sample { ts: number; cpu: number; mem_used_kib: number; mem_total_kib: number; load1: number }

const auth = useAuthStore()
const samples = ref<Sample[]>([])
const interval = ref(1000)
const history = ref<{ granularity: string; samples: unknown[]; unavailable?: string } | null>(null)

async function load() {
  try {
    const r = await api.get<{ interval_ms: number; samples: Sample[] }>(
      '/api/v1/metrics/realtime', { params: { since: 60 } })
    interval.value = r.interval_ms
    samples.value = r.samples
  } catch { samples.value = [] }
  if (auth.me?.tier !== 'nano') {
    try { history.value = await api.get('/api/v1/metrics/history', { params: { gran: '1m' } }) }
    catch { history.value = null }
  }
}
onMounted(load)

const last = computed(() => samples.value.at(-1))
const historyUnavailable = computed(() => auth.me?.tier === 'nano')
</script>

<template>
  <div>
    <header class="bar">
      <h2>系统监控</h2>
      <span class="meta">采样 {{ interval }}ms</span>
      <span class="sp" />
      <button @click="load">刷新</button>
    </header>

    <div class="grid">
      <MetricCard label="CPU" :value="(last?.cpu ?? 0).toFixed(1)" unit="%" />
      <MetricCard label="内存" :value="((last?.mem_used_kib ?? 0) / 1024).toFixed(0)"
                  :unit="`/ ${((last?.mem_total_kib ?? 0) / 1024).toFixed(0)} MB`" />
      <MetricCard label="负载" :value="(last?.load1 ?? 0).toFixed(2)" unit="1m" />
      <MetricCard label="档位" :value="auth.me?.tier ?? '-'" unit="" />
    </div>

    <h3>实时曲线</h3>
    <div v-if="samples.length" class="chart">
      <!-- 自绘 SVG：不引图表库（ECharts 单库 350KB+，与 150KB 预算冲突） -->
      <svg :viewBox="`0 0 ${samples.length * 4} 100`" preserveAspectRatio="none">
        <polyline :points="samples.map((s, i) => `${i * 4},${100 - Math.min(s.cpu, 100)}`).join(' ')"
                  fill="none" stroke="var(--c-primary)" stroke-width="1.5" />
      </svg>
    </div>
    <EmptyState v-else title="暂无采样数据" hint="采集由内部调度器驱动" />

    <h3>历史</h3>
    <EmptyState v-if="historyUnavailable"
      title="nano 档位不落盘历史数据"
      hint="512MB 机器上仅保留内存环形缓冲，重启后清空" />
    <p v-else-if="history" class="dim">已加载 {{ history.samples.length }} 个 {{ history.granularity }} 聚合点</p>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
h3 { margin: 16px 0 8px; font-size: 14px; }
.meta { font-size: 12px; color: var(--c-text-dim); font-family: var(--mono); }
.sp { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.chart { border: 1px solid var(--c-border); border-radius: var(--radius); padding: 8px; background: var(--c-surface); }
.chart svg { width: 100%; height: 120px; display: block; }
.dim { color: var(--c-text-dim); font-size: 13px; }
</style>

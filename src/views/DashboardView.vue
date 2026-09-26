<script setup lang="ts">
/**
 * 仪表盘（M0 阶段为空壳，M1 接入真实指标）。
 *
 * 两个刻意的设计：
 * 1. nano 档位自动退化为轮询（SSE 在低配机器上是负担）—— 由 store 的 pollingMode 决定，
 *    前端不判断平台，只读档位。
 * 2. 指标卡在能力位缺失时不渲染（而不是渲染成 0），避免"假装可用"。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/api/client'
import { CAP } from '@/api/types'
import MetricCard from '@/components/MetricCard.vue'

const auth = useAuthStore()
const cpu = ref(0)
const memUsed = ref(0)
const memTotal = ref(0)
const load1 = ref(0)
const degraded = ref(false)
let timer: number | undefined
let es: EventSource | undefined

function apply(data: { cpu_pct: number; mem_used_kib: number; mem_total_kib: number; load1: number; degraded: boolean }) {
  cpu.value = data.cpu_pct
  memUsed.value = data.mem_used_kib
  memTotal.value = data.mem_total_kib
  load1.value = data.load1
  degraded.value = data.degraded
}

async function poll() {
  try {
    const r = await api.get<Parameters<typeof apply>[0]>('/api/v1/system/overview')
    apply(r)
  } catch {
    /* 轮询失败静默重试，避免弹窗轰炸 */
  }
}

onMounted(async () => {
  await auth.loadMe()
  if (!auth.supported(CAP.METRICS_READ)) return
  await poll()
  if (auth.pollingMode) {
    timer = window.setInterval(poll, 10000)   // nano：10s 轮询
  } else {
    es = new EventSource('/api/v1/events/metrics')
    es.addEventListener('metrics', (ev) => {
      try { apply(JSON.parse((ev as MessageEvent).data)) } catch { /* 忽略坏帧 */ }
    })
  }
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  es?.close()
})
</script>

<template>
  <div class="dash">
    <header>
      <h2>概览</h2>
      <span v-if="degraded" class="badge" title="低配降级：已自动降低采样频率">已降频</span>
    </header>

    <p v-if="!auth.supported(CAP.METRICS_READ)" class="empty">
      当前环境不支持资源监控（{{ auth.capabilities[CAP.METRICS_READ]?.reason ?? '未知原因' }}）
    </p>

    <div v-else class="grid">
      <MetricCard label="CPU" :value="cpu.toFixed(1)" unit="%" />
      <MetricCard label="内存" :value="(memUsed / 1024).toFixed(0)" :unit="`/ ${(memTotal / 1024).toFixed(0)} MB`" />
      <MetricCard label="负载" :value="load1.toFixed(2)" unit="1m" />
      <MetricCard label="档位" :value="auth.me?.tier ?? '-'" unit="" />
    </div>

    <p class="hint">M1 阶段接入实时曲线与历史数据</p>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 16px; }
header { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px;
         background: var(--c-warn-bg); color: var(--c-warn); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.empty, .hint { color: var(--c-text-dim); font-size: 13px; margin: 0; }
</style>

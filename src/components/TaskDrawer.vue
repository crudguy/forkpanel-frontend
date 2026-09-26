<script setup lang="ts">
/**
 * 任务进度抽屉。
 *
 * 订阅 /api/v1/events/tasks（SSE），把任务中心广播的进度/日志渲染出来。
 * nano 档位退化为轮询（SSE 在低配机器上是负担）—— 由 store 的 pollingMode 决定，
 * 前端不判断平台。
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface Line { id: number; kind: 'progress' | 'log'; text: string; percent?: number }

const auth = useAuthStore()
const lines = ref<Line[]>([])
const open = ref(false)
let es: EventSource | undefined
let timer: number | undefined

const latest = computed(() => {
  for (let i = lines.value.length - 1; i >= 0; i--) {
    if (lines.value[i].percent !== undefined) return lines.value[i].percent!
  }
  return 0
})

function push(l: Line) {
  lines.value.push(l)
  // 上限保护：长任务可能输出上万行，DOM 撑不住
  if (lines.value.length > 500) lines.value.splice(0, lines.value.length - 500)
}

function attach() {
  if (auth.pollingMode) {
    timer = window.setInterval(() => { /* 轮询 /api/v1/tasks 补全，骨架阶段留空 */ }, 5000)
    return
  }
  es = new EventSource('/api/v1/events/tasks')
  es.addEventListener('progress', (e) => {
    const d = JSON.parse((e as MessageEvent).data)
    push({ id: d.id, kind: 'progress', text: d.message ?? '', percent: d.percent })
  })
  es.addEventListener('log', (e) => {
    const d = JSON.parse((e as MessageEvent).data)
    push({ id: d.id, kind: 'log', text: d.line })
  })
  es.addEventListener('finished', (e) => {
    const d = JSON.parse((e as MessageEvent).data)
    push({ id: d.id, kind: 'log', text: `任务结束：${d.state}` })
  })
}

onMounted(attach)
onUnmounted(() => { es?.close(); if (timer) clearInterval(timer) })

defineExpose({ show: () => (open.value = true), hide: () => (open.value = false) })
</script>

<template>
  <button class="fab" :class="{ active: open }" @click="open = !open">
    任务 {{ lines.length ? `(${latest}%)` : '' }}
  </button>

  <aside v-if="open" class="drawer">
    <header>
      <strong>任务进度</strong>
      <button @click="open = false">关闭</button>
    </header>
    <div class="bar"><i :style="{ width: latest + '%' }" /></div>
    <ol>
      <li v-for="(l, i) in lines" :key="i" :class="l.kind">{{ l.text }}</li>
    </ol>
    <p v-if="!lines.length" class="none">暂无任务</p>
  </aside>
</template>

<style scoped>
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 40; }
.fab.active { background: var(--c-active); }
.drawer { position: fixed; right: 20px; bottom: 64px; width: min(480px, 92vw); max-height: 50vh;
          background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius);
          padding: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 40; }
header { display: flex; align-items: center; justify-content: space-between; }
.bar { height: 4px; background: var(--c-hover); border-radius: 2px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--c-primary); transition: width .2s; }
ol { margin: 0; padding-left: 16px; overflow: auto; font-family: var(--mono); font-size: 12px; }
li.log { color: var(--c-text-dim); }
li.progress { color: var(--c-primary); }
.none { margin: 0; font-size: 13px; color: var(--c-text-dim); }
</style>

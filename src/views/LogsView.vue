<script setup lang="ts">
/**
 * 日志查看。
 *
 * 两个刻意的设计：
 * 1. grep 是**字面量**匹配，不是正则 —— 后端刻意不做正则（ReDoS）。
 *    UI 措辞必须说清，否则用户会输入 `.*` 然后困惑为什么没匹配。
 * 2. 行数上限由服务端强制（2000），UI 只做提示不做承诺。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'

interface Src { id: string; label: string; kind: string }
interface Line { ts: number | null; level: string | null; text: string }

const auth = useAuthStore()
const sources = ref<Src[]>([])
const cur = ref('')
const lines = ref<Line[]>([])
const grep = ref('')
const count = ref(200)
const error = ref('')
const capped = ref(false)

async function loadSources() {
  try {
    const r = await api.get<{ sources: Src[] }>('/api/v1/logs/sources')
    sources.value = r.sources
    if (r.sources.length && !cur.value) { cur.value = r.sources[0].id; load() }
  } catch (e) { error.value = errorText(e) }
}

async function load() {
  if (!cur.value) return
  error.value = ''
  try {
    const r = await api.get<{ lines: Line[]; capped: boolean }>(`/api/v1/logs/${encodeURIComponent(cur.value)}`, {
      params: { lines: count.value, grep: grep.value || undefined },
    })
    lines.value = r.lines; capped.value = r.capped
  } catch (e) { error.value = errorText(e); lines.value = [] }
}

onMounted(loadSources)
watch(cur, load)

const canView = computed(() => auth.enabled(CAP.LOGS_READ, 'log.view'))
</script>

<template>
  <div>
    <header class="bar">
      <h2>日志</h2>
      <select v-model="cur" :disabled="!canView">
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <input v-model="grep" class="grep" placeholder="过滤（普通文本，非正则）"
             @keyup.enter="load" />
      <select v-model.number="count" @change="load">
        <option :value="100">100 行</option>
        <option :value="500">500 行</option>
        <option :value="2000">2000 行（上限）</option>
      </select>
      <button :disabled="!canView" @click="load">刷新</button>
    </header>

    <EmptyState v-if="!auth.supported(CAP.LOGS_READ)"
      title="当前环境不支持日志查看"
      :reason="auth.capabilities[CAP.LOGS_READ]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="capped" class="warn">已达服务端上限（单次最多 2000 行）</p>

      <pre class="view"><code v-for="(l, i) in lines" :key="i" :class="l.level?.toLowerCase()">
<span class="ts">{{ l.ts ? new Date(l.ts * 1000).toLocaleTimeString() : '—' }}</span> {{ l.text }}</code></pre>
      <EmptyState v-if="!lines.length && !error" title="无匹配日志" />
    </template>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 18px; }
.grep { width: 220px; }
.err { color: var(--c-danger); font-size: 13px; }
.warn { color: var(--c-warn); font-size: 13px; }
.view { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius);
        padding: 12px; max-height: 60vh; overflow: auto; font-family: var(--mono); font-size: 12px;
        margin: 0; white-space: pre-wrap; word-break: break-all; }
.view code { display: block; }
.ts { color: var(--c-text-dim); }
.error, .err { color: var(--c-danger); }
.warn, .warning { color: var(--c-warn); }
.info { color: var(--c-text-dim); }
</style>

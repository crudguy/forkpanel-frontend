<script setup lang="ts">
/**
 * 日志查看（一次性拉取 + 实时跟随）。
 *
 * 三个刻意的设计：
 * 1. grep 是**字面量**匹配，不是正则 —— 后端刻意不做正则（ReDoS）。UI 措辞必须说清。
 * 2. 行数上限由服务端强制（2000），UI 只做提示不做承诺。
 * 3. 实时跟随走 SSE（`/api/v1/logs/stream`，服务端先补历史再推增量），
 *    断开即关连接；前端只保留最近 2000 行，避免长时间跟随把内存吃光。
 */
import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface Src { id: string; label: string; kind: string }
interface Line { ts: number | null; level: string | null; text: string }

const MAX_KEEP = 2000

const auth = useAuthStore()
const sources = ref<Src[]>([])
const cur = ref('')
const lines = ref<Line[]>([])
const grep = ref('')
const count = ref(200)
const error = ref('')
const capped = ref(false)
const follow = ref(false)
const viewEl = ref<HTMLElement | null>(null)

let es: EventSource | null = null

async function loadSources() {
  try {
    const r = await api.get<{ sources: Src[] }>(API.logs.sources())
    sources.value = r.sources
    if (r.sources.length && !cur.value) { cur.value = r.sources[0].id; load() }
  } catch (e) { error.value = errorText(e) }
}

async function load() {
  if (!cur.value) return
  error.value = ''
  try {
    const r = await api.get<{ lines: Line[]; capped: boolean }>(API.logs.read(cur.value), {
      params: { lines: count.value, grep: grep.value || undefined },
    })
    lines.value = r.lines; capped.value = r.capped
  } catch (e) { error.value = errorText(e); lines.value = [] }
}

function closeStream() {
  if (es) { es.close(); es = null }
}

/** 下载当前日志源（沿用当前 grep 过滤——所见即所得；attachment 响应头触发保存，不离开页面） */
function downloadLog() {
  if (!cur.value) return
  const p = new URLSearchParams({ lines: String(count.value) })
  if (grep.value) p.set('grep', grep.value)
  window.location.href = `${API.logs.download(cur.value)}?${p.toString()}`
}

function scrollBottom() {
  nextTick(() => { if (viewEl.value) viewEl.value.scrollTop = viewEl.value.scrollHeight })
}

function openStream() {
  closeStream()
  if (!cur.value) return
  lines.value = []
  const url = API.logs.stream(cur.value, grep.value || undefined, count.value)
  es = new EventSource(url)
  es.addEventListener('log', (ev: MessageEvent) => {
    try {
      lines.value.push(JSON.parse(ev.data) as Line)
      if (lines.value.length > MAX_KEEP) lines.value.splice(0, lines.value.length - MAX_KEEP)
      scrollBottom()
    } catch { /* 忽略坏帧 */ }
  })
  // EventSource 断线会自动重连；此处只在关闭时清理
}

function toggleFollow() {
  follow.value = !follow.value
  if (follow.value) openStream()
  else { closeStream(); load() }
}

onMounted(loadSources)
watch(cur, () => { if (follow.value) openStream(); else load() })
onUnmounted(closeStream)

const canView = computed(() => auth.enabled(CAP.LOGS_READ, 'log.view'))
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">日志</h2>
        <p class="page-sub">字面量过滤（非正则）· 单次上限 2000 行 · 支持实时跟随</p>
      </div>
      <span class="spacer" />
      <select v-model="cur" :disabled="!canView" class="ctl">
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <input v-model="grep" class="ctl grep" placeholder="过滤（普通文本，非正则）" @keyup.enter="follow ? openStream() : load()" />
      <select v-model.number="count" class="ctl" :disabled="follow" @change="load">
        <option :value="100">100 行</option>
        <option :value="500">500 行</option>
        <option :value="2000">2000 行（上限）</option>
      </select>
      <button class="btn-primary" :class="{ active: follow }" :disabled="!canView" @click="toggleFollow">
        <Icon name="bolt" :size="15" /> {{ follow ? '停止跟随' : '实时跟随' }}
      </button>
      <button class="btn-ghost" :disabled="!canView || follow" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
      <button class="btn-ghost" :disabled="!canView || follow || !cur" title="按当前过滤条件下载（上限 10000 行 / 8MB）" @click="downloadLog">
        <Icon name="download" :size="15" /> 下载
      </button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.LOGS_READ)"
      title="当前环境不支持日志查看"
      :reason="auth.capabilities[CAP.LOGS_READ]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="capped" class="warn">已达服务端上限（单次最多 2000 行）</p>
      <p v-if="follow" class="live"><span class="dot live-dot" /> 实时跟随中…（新行自动追加）</p>

      <pre ref="viewEl" class="view"><code v-for="(l, i) in lines" :key="i" :class="l.level?.toLowerCase()">
<span class="ts">{{ l.ts ? new Date(l.ts * 1000).toLocaleTimeString() : '—' }}</span> {{ l.text }}</code></pre>
      <EmptyState v-if="!lines.length && !error" :title="follow ? '等待新日志…' : '无匹配日志'" />
    </template>
  </div>
</template>

<style scoped>
.ctl { width: auto; min-width: 0; }
.live { display: flex; align-items: center; gap: 7px; color: var(--c-ok, #3fb950); font-size: 12.5px; margin: 0 0 8px; }
.live-dot { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>

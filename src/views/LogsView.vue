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

interface LogStatsResp {
  source: string
  scanned: number
  capped: boolean
  buckets: number
  levels: { error: number; warn: number; info: number; debug: number; other: number }
  histogram: { start: number; end: number; count: number }[]
  top_patterns: { pattern: string; count: number }[]
}
const stats = ref<LogStatsResp | null>(null)
const showStats = ref(false)
const statBusy = ref(false)

/** 聚合统计：服务端单次最多扫 2000 行，结果是**概览**（pattern 归一化为启发式） */
async function loadStats() {
  if (!cur.value) return
  statBusy.value = true
  error.value = ''
  try {
    stats.value = await api.get<LogStatsResp>(API.logs.stats(cur.value), {
      params: { lines: count.value, grep: grep.value || undefined },
    })
  } catch (e) { error.value = errorText(e); stats.value = null }
  finally { statBusy.value = false }
}

function toggleStats() {
  showStats.value = !showStats.value
  if (showStats.value) loadStats()
}

// 直方图按当前最大桶归一，避免单一尖峰把其余柱压平
const histMax = computed(() => Math.max(1, ...(stats.value?.histogram ?? []).map(b => b.count)))
const levelRows = computed(() => {
  const lv = stats.value?.levels
  if (!lv) return [] as { name: string; n: number }[]
  return ([['error', lv.error], ['warn', lv.warn], ['info', lv.info], ['debug', lv.debug], ['other', lv.other]] as const)
    .map(([name, n]) => ({ name, n }))
})
const levelTotal = computed(() => levelRows.value.reduce((s, r) => s + r.n, 0))

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
      <button class="btn-ghost" :class="{ active: showStats }" :disabled="!canView || follow || !cur" title="聚合统计：level 分布 + 时间直方图 + 高频模式（最多扫 2000 行）" @click="toggleStats">
        <Icon name="chart" :size="15" /> 统计
      </button>
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

      <section v-if="showStats" class="stats">
        <div v-if="statBusy" class="muted">统计中…</div>
        <template v-else-if="stats">
          <div class="stats-head">
            <span>扫描 <b>{{ stats.scanned }}</b> 行<span v-if="stats.capped">（已触 2000 行上限）</span></span>
            <span class="muted">来源 {{ stats.source }}</span>
          </div>
          <div class="lv-rows">
            <div v-for="r in levelRows" :key="r.name" class="lv-row" :class="r.name">
              <span class="lv-name">{{ r.name }}</span>
              <span class="lv-bar"><i :style="{ width: levelTotal ? (r.n / levelTotal * 100) + '%' : '0%' }" /></span>
              <span class="lv-n">{{ r.n }}</span>
            </div>
          </div>
          <div v-if="stats.histogram.length" class="hist">
            <div v-for="(b, i) in stats.histogram" :key="i" class="hist-bar"
                 :title="`${new Date(b.start * 1000).toLocaleString()} → ${new Date(b.end * 1000).toLocaleString()}：${b.count} 行`">
              <i :style="{ height: Math.max(2, (b.count / histMax) * 100) + '%' }" />
            </div>
          </div>
          <p v-else class="muted">该日志源无时间戳，无法生成时间分布</p>
          <div v-if="stats.top_patterns.length" class="pats">
            <div class="pats-title">高频消息模式（数字/引号内容已归一）</div>
            <div v-for="(p, i) in stats.top_patterns" :key="i" class="pat">
              <span class="pat-n">{{ p.count }}×</span>
              <code class="pat-t">{{ p.pattern }}</code>
            </div>
          </div>
          <p v-else class="muted">无出现 ≥2 次的消息模式</p>
        </template>
      </section>

      <pre ref="viewEl" class="view"><code v-for="(l, i) in lines" :key="i" :class="l.level?.toLowerCase()">
<span class="ts">{{ l.ts ? new Date(l.ts * 1000).toLocaleTimeString() : '—' }}</span> {{ l.text }}</code></pre>
      <EmptyState v-if="!lines.length && !error" :title="follow ? '等待新日志…' : '无匹配日志'" />
    </template>
  </div>
</template>

<style scoped>
/* 日志视图主体：此前无任何规则，2000 行直接撑开整页，scrollBottom() 对
   不可滚动元素无效（实时跟随失效）。限定高度 + 自身滚动后跟随才生效。 */
.view {
  max-height: 58vh;
  overflow: auto;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-surface-2);
  font-size: 12px;
  line-height: 1.55;
}
.ctl { width: auto; min-width: 0; }
.live { display: flex; align-items: center; gap: 7px; color: var(--c-ok, #3fb950); font-size: 12.5px; margin: 0 0 8px; }
.stats { border: 1px solid var(--c-border); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
.stats .muted { color: var(--c-text-mute); font-size: 12.5px; }
.stats-head { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 10px; }
.lv-rows { display: grid; gap: 5px; margin-bottom: 12px; }
.lv-row { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; gap: 8px; font-size: 12px; }
.lv-name { text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-mute); }
.lv-bar { height: 6px; border-radius: 999px; background: var(--c-border); overflow: hidden; }
.lv-bar > i { display: block; height: 100%; border-radius: 999px; background: #4cd07d; }
.lv-row.error .lv-name { color: var(--c-danger); }
.lv-row.error .lv-bar > i { background: var(--c-danger); }
.lv-row.warn .lv-name { color: var(--c-warn); }
.lv-row.warn .lv-bar > i { background: var(--c-warn); }
.lv-row.info .lv-name { color: #4ea1ff; }
.lv-row.info .lv-bar > i { background: #4ea1ff; }
.lv-row.debug .lv-name { color: #b48cff; }
.lv-row.debug .lv-bar > i { background: #b48cff; }
.lv-n { text-align: right; font-variant-numeric: tabular-nums; }
.hist { display: flex; align-items: flex-end; gap: 3px; height: 64px; margin-bottom: 12px; }
.hist-bar { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.hist-bar > i { display: block; width: 100%; background: linear-gradient(180deg, #4ea1ff, #36c5d6); border-radius: 2px 2px 0 0; }
.pats-title { font-size: 12px; color: var(--c-text-mute); margin-bottom: 6px; }
.pat { display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 3px 0; }
.pat-n { flex: 0 0 38px; text-align: right; color: var(--c-warn); font-variant-numeric: tabular-nums; }
.pat-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--c-text-mute); }
.live-dot { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>

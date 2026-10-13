<script setup lang="ts">
/**
 * 日志查看（一次性拉取 + 实时跟随）。
 *
 * 四个刻意的设计：
 * 1. grep 是**字面量**匹配，不是正则 —— 后端刻意不做正则（ReDoS）。UI 措辞必须说清。
 * 2. 行数上限由服务端强制（2000），UI 只做提示不做承诺。
 * 3. 实时跟随走 SSE（`/api/v1/logs/stream`，服务端先补历史再推增量），
 *    断开即关连接；前端只保留最近 2000 行，避免长时间跟随把内存吃光。
 * 4. 级别 / 时间筛选与「聚合统计」**同口径**：筛选条件（level/since）会一并传给
 *    stats 端点，统计的 level 分布、直方图、高频模式都反映当前筛选结果。
 */
import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, fmtTime as fmtClock } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface Src { id: string; label: string; kind: string }
interface Line { ts: number | null; level: string | null; text: string }

const MAX_KEEP = 2000

/** 级别筛选选项（值与后端归一桶名一致：error/warn/info/debug） */
const LEVELS = [
  { v: '', label: '全部级别' },
  { v: 'error', label: 'Error' },
  { v: 'warn', label: 'Warn' },
  { v: 'info', label: 'Info' },
  { v: 'debug', label: 'Debug' },
] as const

/** 时间筛选预设（相对窗口）。自文件源无时间戳，该控件会被禁用。 */
const SINCE_PRESETS = [
  { k: '', label: '全部时间', sec: 0 },
  { k: '15m', label: '最近 15 分钟', sec: 900 },
  { k: '1h', label: '最近 1 小时', sec: 3600 },
  { k: '6h', label: '最近 6 小时', sec: 21600 },
  { k: '24h', label: '最近 24 小时', sec: 86400 },
  { k: '7d', label: '最近 7 天', sec: 604800 },
] as const
const FILE_KINDS = ['site-access', 'site-error', 'custom-file'] as const

const auth = useAuthStore()
const sources = ref<Src[]>([])
const cur = ref('')
const lines = ref<Line[]>([])
const grep = ref('')
// 初值与下拉选项对齐（审计 F22）：此前 200 不在 100/500/2000 选项内，
// 首屏下拉无匹配项，显示行数与实际请求行数不符
const count = ref(100)
const error = ref('')
const capped = ref(false)
const follow = ref(false)
const viewEl = ref<HTMLElement | null>(null)

// A8 筛选状态
const level = ref('')
const since = ref('')
// A8 重复行折叠
const foldRepeats = ref(true)
const expandedGroups = ref<Set<number>>(new Set())

const curSource = computed(() => sources.value.find(s => s.id === cur.value))
const isFileSource = computed(() => FILE_KINDS.includes((curSource.value?.kind ?? '') as typeof FILE_KINDS[number]))
/** 时间筛选只在 journald 源有意义；文件源行没有时间戳 → 禁用并诚实说明 */
const sinceUnix = computed<number | undefined>(() => {
  const p = SINCE_PRESETS.find(x => x.k === since.value)
  if (!p || !p.sec) return undefined
  return Math.floor(Date.now() / 1000) - p.sec
})

let es: EventSource | null = null
/** SSE 重连计数与上限（审计 P7）：EventSource 自动重连，连续失败超限后放弃并明确提示 */
const esRetries = ref(0)
const MAX_ES_RETRIES = 5

async function loadSources() {
  // 请求级门控：无可用日志源时 logs.read=no，源列表端点返 501
  if (!auth.supported(CAP.LOGS_READ)) return
  try {
    const r = await api.get<{ sources: Src[] }>(API.logs.sources())
    // 兜底后再取 .length：此前直接 `r.sources.length`，后端返 null 会抛
    // TypeError，被 catch 吞成一句错误文案，连"无日志源"都显示不出来
    const list = r.sources ?? []
    sources.value = list
    if (list.length && !cur.value) { cur.value = list[0].id }   // cur 变更由 watch 触发 load
  } catch (e) { error.value = errorText(e) }
}

// 请求序号：快速切换日志源/改过滤条件时，旧请求可能后到并覆盖新结果——
// 表现为"切到了 B 源，显示的却是 A 的内容"，且不会有任何报错提示。
let loadSeq = 0
async function load() {
  if (!cur.value) return
  // 同上：直接读日志内容也受同一能力位守卫
  if (!auth.supported(CAP.LOGS_READ)) return
  const seq = ++loadSeq
  error.value = ''
  expandedGroups.value = new Set()
  try {
    const r = await api.get<{ lines: Line[]; capped: boolean }>(API.logs.read(cur.value), {
      params: {
        lines: count.value,
        grep: grep.value || undefined,
        level: level.value || undefined,
        since: sinceUnix.value,
      },
    })
    if (seq !== loadSeq) return   // 已有更新的请求在途，丢弃本次结果
    lines.value = r.lines ?? []; capped.value = r.capped
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = errorText(e); lines.value = []
  }
}

function closeStream() {
  if (es) { es.close(); es = null }
  esRetries.value = 0
  if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = undefined }
}

/**
 * 滚动跟随节流（审计 P6）：高频日志下每条 SSE 事件都 nextTick 读
 * scrollHeight 是每秒数十次强制重排。改为 trailing 节流——100ms 内
 * 的多次新行只触发一次真实滚动。
 */
let scrollTimer: number | undefined
function scrollBottom() {
  if (scrollTimer) return
  scrollTimer = window.setTimeout(() => {
    scrollTimer = undefined
    nextTick(() => { if (viewEl.value) viewEl.value.scrollTop = viewEl.value.scrollHeight })
  }, 100)
}

/** 下载当前日志源（沿用当前 grep/level/since 过滤——所见即所得；attachment 响应头触发保存，不离开页面） */
function downloadLog() {
  if (!cur.value) return
  const p = new URLSearchParams({ lines: String(count.value) })
  if (grep.value) p.set('grep', grep.value)
  if (level.value) p.set('level', level.value)
  if (sinceUnix.value) p.set('since', String(sinceUnix.value))
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

/** 聚合统计：服务端单次最多扫 2000 行，结果是**概览**（pattern 归一化为启发式）。
 *  与筛选同口径：传入 level/since，统计结果反映当前筛选。 */
async function loadStats() {
  if (!cur.value) return
  statBusy.value = true
  error.value = ''
  try {
    stats.value = await api.get<LogStatsResp>(API.logs.stats(cur.value), {
      params: {
        lines: count.value,
        grep: grep.value || undefined,
        level: level.value || undefined,
        since: sinceUnix.value,
      },
    })
  } catch (e) { error.value = errorText(e); stats.value = null }
  finally { statBusy.value = false }
}

function toggleStats() {
  showStats.value = !showStats.value
  if (showStats.value) loadStats()
}

/**
 * A8 重复行折叠：把相邻、文本完全相同的行归并为一段。
 * - repeat===1：原样渲染。
 * - repeat>1 且未展开：只渲染首行 + 「×N 展开」徽标。
 * - repeat>1 且已展开（点击徽标）：把该段逐行铺开。
 * 纯前端、零契约变更；折叠发生在「已按 level/since/grep 过滤后的 lines」之上，
 * 与统计口径天然一致。live 跟随模式下 expandedGroups 以首行下标为键，
 * 仅追加不插队，键在追加过程中稳定，仅在 openStream/load 时整体清空。
 */
interface DispRow { line: Line; repeat: number; start: number; collapsed: boolean }
const display = computed<DispRow[]>(() => {
  const ls = lines.value
  if (!foldRepeats.value) {
    return ls.map((l, i) => ({ line: l, repeat: 1, start: i, collapsed: false }))
  }
  const out: DispRow[] = []
  let i = 0
  while (i < ls.length) {
    let j = i + 1
    while (j < ls.length && ls[j].text === ls[i].text) j++
    const repeat = j - i
    const collapsed = repeat > 1 && !expandedGroups.value.has(i)
    out.push({ line: ls[i], repeat, start: i, collapsed })
    if (!collapsed && repeat > 1) {
      for (let k = i + 1; k < j; k++) out.push({ line: ls[k], repeat: 1, start: k, collapsed: false })
    }
    i = j
  }
  return out
})
function toggleGroup(start: number) {
  const s = new Set(expandedGroups.value)
  if (s.has(start)) s.delete(start); else s.add(start)
  expandedGroups.value = s
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

function openStream() {
  closeStream()
  if (!cur.value) return
  lines.value = []
  expandedGroups.value = new Set()
  const url = API.logs.stream(cur.value, grep.value || undefined, count.value, level.value || undefined, sinceUnix.value)
  es = new EventSource(url)
  // 连接恢复即清零重连计数（审计 P7）
  es.onopen = () => { esRetries.value = 0 }
  es.addEventListener('log', (ev: MessageEvent) => {
    try {
      lines.value.push(JSON.parse(ev.data) as Line)
      if (lines.value.length > MAX_KEEP) {
        lines.value.splice(0, lines.value.length - MAX_KEEP)
        expandedGroups.value = new Set()
      }
      scrollBottom()
    } catch { /* 忽略坏帧 */ }
  })
  // EventSource 断线会自动重连，但要给失败反馈与重连上限（审计 P7）：
  // 此前无 onerror，断网/后端重启时 UI 长期停在「实时跟随中…」无任何提示
  es.onerror = () => {
    esRetries.value += 1
    if (esRetries.value > MAX_ES_RETRIES) {
      const src = cur.value
      closeStream()
      follow.value = false
      error.value = `实时跟随已断开（连续 ${MAX_ES_RETRIES} 次重连失败）。请检查连接后重新点击「实时跟随」${src ? `（来源：${src}）` : ''}`
    }
  }
}

function toggleFollow() {
  follow.value = !follow.value
  if (follow.value) openStream()
  else { closeStream(); load() }
}

onMounted(loadSources)
// 切源：跟随中重开流，否则重新拉取
watch(cur, () => { if (follow.value) openStream(); else load() })
// A8：改级别 / 时间筛选 → 重新拉取（筛选条件一并带进 stats 与 stream，口径一致）
watch([level, since], () => {
  expandedGroups.value = new Set()
  if (showStats.value) loadStats()
  if (follow.value) openStream()
  else if (cur.value) load()
})

const canView = computed(() => auth.enabled(CAP.LOGS_READ, 'log.view'))
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <select v-model="cur" :disabled="!canView" class="ctl">
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <select v-model="level" class="ctl" :disabled="!canView" title="按级别筛选（与统计同口径）">
        <option v-for="o in LEVELS" :key="o.v" :value="o.v">{{ o.label }}</option>
      </select>
      <select v-model="since" class="ctl" :disabled="!canView || isFileSource"
              :title="isFileSource ? '该日志源无时间戳，时间筛选不适用' : '按相对时间窗口筛选（仅 journald 源有效）'">
        <option v-for="o in SINCE_PRESETS" :key="o.k" :value="o.k">{{ o.label }}</option>
      </select>
      <input v-model="grep" class="ctl grep" placeholder="过滤（普通文本，非正则）" @keyup.enter="follow ? openStream() : load()" />
      <select v-model.number="count" class="ctl" :disabled="follow" @change="load">
        <option :value="100">100 行</option>
        <option :value="500">500 行</option>
        <option :value="2000">2000 行（上限）</option>
      </select>
      <label class="ctl chk" :class="{ on: foldRepeats }" title="折叠相邻重复行">
        <input type="checkbox" v-model="foldRepeats" /> 折叠重复
      </label>
      <button class="btn-primary" :class="{ active: follow }" :disabled="!canView" @click="toggleFollow">
        <Icon name="bolt" :size="15" /> {{ follow ? '停止跟随' : '实时跟随' }}
      </button>
      <button class="btn-ghost" :disabled="!canView || follow" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
      <button class="btn-ghost" :class="{ active: showStats }" :disabled="!canView || follow || !cur" title="聚合统计：level 分布 + 时间直方图 + 高频模式（最多扫 2000 行，随当前筛选）" @click="toggleStats">
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
      <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
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
                 :title="`${fmtDateTime(b.start)} → ${fmtDateTime(b.end)}：${b.count} 行`">
              <i :style="{ height: Math.max(2, (b.count / histMax) * 100) + '%' }" />
            </div>
          </div>
          <p v-else class="muted">该日志源无时间戳，无法生成时间分布</p>
          <div v-if="stats.top_patterns.length" class="pats">
            <div class="pats-title">高频消息模式（数字/引号内容已归一）</div>
            <div v-for="(p, i) in stats.top_patterns" :key="i" class="pat">
              <span class="pat-n">{{ p.count }}×</span>
              <!-- pattern 通常很长且被 ellipsis 截断，完整值走 title 悬停 -->
              <code class="pat-t" :title="p.pattern">{{ p.pattern }}</code>
            </div>
          </div>
          <p v-else class="muted">无出现 ≥2 次的消息模式</p>
        </template>
      </section>

      <pre ref="viewEl" class="view"><code v-for="d in display" :key="d.start" :class="d.line.level?.toLowerCase()">
<span class="ts">{{ fmtClock(d.line.ts) }}</span> {{ d.line.text }}<button v-if="d.repeat > 1 && d.collapsed" class="fold-badge" type="button" @click="toggleGroup(d.start)" :title="`展开重复的 ${d.repeat} 行`">×{{ d.repeat }} 展开</button></code></pre>
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
  font-size: var(--fs-12);
  line-height: 1.55;
}
/* 重复行折叠徽标：行内小按钮，点击铺开该段 */
.fold-badge {
  margin-left: 8px;
  padding: 0 7px;
  height: 18px;
  line-height: 18px;
  border-radius: 999px;
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-dim);
  font-size: var(--fs-12);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.fold-badge:hover { border-color: var(--c-primary); color: var(--c-primary); }
.ctl { width: auto; min-width: 0; }
.ctl.chk { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-12); color: var(--c-text-dim); user-select: none; }
.ctl.chk.on { color: var(--c-text); }
.ctl.chk input { width: auto; }
.live { display: flex; align-items: center; gap: 7px; color: var(--c-ok, #3fb950); font-size: var(--fs-12-5); margin: 0 0 8px; }
.stats { border: 1px solid var(--c-border); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
.stats .muted { color: var(--c-text-mute); font-size: var(--fs-12-5); }
.stats-head { display: flex; justify-content: space-between; font-size: var(--fs-12-5); margin-bottom: 10px; }
.lv-rows { display: grid; gap: 5px; margin-bottom: 12px; }
.lv-row { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; gap: 8px; font-size: var(--fs-12); }
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
.pats-title { font-size: var(--fs-12); color: var(--c-text-mute); margin-bottom: 6px; }
.pat { display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-12); padding: 3px 0; }
.pat-n { flex: 0 0 38px; text-align: right; color: var(--c-warn); font-variant-numeric: tabular-nums; }
.pat-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--c-text-mute); }
.live-dot { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>

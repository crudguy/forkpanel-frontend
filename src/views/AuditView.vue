<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, auditResultLabel, fmtDateTime } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { useAsync } from '@/composables/useAsync'

/**
 * 审计日志（操作日志）。
 *
 * 契约对齐：后端 `/api/v1/audit` 现返回分页对象 `{ items, page, page_size, total }`
 * （此前只支持 `limit` 一次性拉取，行数打满即被静默截断，容易误导合规判断）。
 * 筛选（actor/action/result/q/since/until）全部下推到服务端，前端只负责呈现当前页。
 */

const auth = useAuthStore()

/** 对应后端 `AuditEntry`（routes/audit.rs）。此前用 `any[]`，字段名拼错无从发现。 */
interface AuditEntry {
  id: number
  /** Unix 秒 */
  ts: number
  actor: string
  /** 来源 IP；后端 2026-10-03 起真实写入（此前恒为空串），进程重启前的记录仍为空 */
  actor_ip: string
  action: string
  target: string
  /** ok / changed / unchanged / queued / denied / error / fail */
  result: string
  /** JSON 字符串；后端多为 "{}"，用 prettyDetail 容错解析 */
  detail_json: string | null
}

const rows = ref<AuditEntry[]>([])
const { loading, error, run } = useAsync(true)
const onError = (e: unknown) => { error.value = errorText(e) }

// ── 筛选条件（空值不下传，等价于"不过滤"）──
const f = ref({ actor: '', action: '', result: '', q: '', since: '', until: '' })

/** 动作候选（datalist 建议）：从已加载的真实记录里累积去重——比手写词表诚实，
 *  也不会随后端新增动作而过时（评估 C5：自由文本无法枚举） */
const knownActions = ref<string[]>([])

// ── 快捷时间区间（评估 C5）──：datetime-local 空值无法用 placeholder 说明，
// 看上去像坏掉的控件；一键填常用的三个区间，比手选两次日历快。
function pad2(n: number) { return String(n).padStart(2, '0') }
/** Date → datetime-local 输入值（本地时区）。**绝不用 toISOString**——它按 UTC 输出，会平移时区。 */
function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function quickRange(kind: 'today' | '7d' | '30d') {
  const now = new Date()
  const start = new Date(now)
  if (kind === 'today') start.setHours(0, 0, 0, 0)
  else start.setDate(start.getDate() - (kind === '7d' ? 7 : 30))
  f.value.since = toLocalInput(start)
  f.value.until = toLocalInput(now)
  applyFilters()
}
function clearTime() {
  f.value.since = ''; f.value.until = ''
  applyFilters()
}

// ── 分页 ──
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

// ── 详情展开：同一时刻只展开一行 ──
const expanded = ref<number | null>(null)

const canView = computed(() => auth.enabled(CAP.LOGS_READ, 'audit.view'))

/** `datetime-local` 字符串 → Unix 秒；无效返回 undefined（不参与下传） */
function toTs(s: string): number | undefined {
  if (!s) return undefined
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

async function load() {
  await run(async () => {
    expanded.value = null
    const since = toTs(f.value.since)
    const until = toTs(f.value.until)
    // 客户端先拦一次（服务端也会校验，这里是即时反馈，省一次往返）
    if (since != null && until != null && since > until) {
      error.value = '起始时间不能晚于截止时间'
      return
    }
    const params: Record<string, any> = { page: page.value, page_size: pageSize.value }
    if (f.value.actor.trim()) params.actor = f.value.actor.trim()
    if (f.value.action.trim()) params.action = f.value.action.trim()
    if (f.value.result) params.result = f.value.result
    if (f.value.q.trim()) params.q = f.value.q.trim()
    if (since != null) params.since = since
    if (until != null) params.until = until

    const r = await api.get<{ items: AuditEntry[]; page: number; page_size: number; total: number }>(API.audit(), { params })
    rows.value = r?.items ?? []
    total.value = r?.total ?? 0
    // 动作候选：从真实记录累积（datalist 建议）
    if (rows.value.length) {
      knownActions.value = [...new Set([...knownActions.value, ...rows.value.map((x) => x.action)])].sort()
    }
    // 筛选后总页数可能变小：越界则回退到最后一页
    if (page.value > totalPages.value) { page.value = totalPages.value; await load(); return }
  }, onError)
}

function applyFilters() { page.value = 1; load() }
function reset() {
  f.value = { actor: '', action: '', result: '', q: '', since: '', until: '' }
  page.value = 1; load()
}
function goto(p: number) {
  const n = Math.min(Math.max(1, p), totalPages.value)
  if (n !== page.value) { page.value = n; load() }
}
function changeSize() { page.value = 1; load() }
function toggle(i: number) { expanded.value = expanded.value === i ? null : i }

function fmt(ts?: number) { return fmtDateTime(ts) }
function resClass(r: string) {
  if (r === 'ok') return 'b-ok'
  if (r === 'queued') return 'b-wait'
  if (r === 'denied' || r === 'error' || r === 'fail') return 'b-bad'
  return ''
}
function prettyDetail(s?: string | null): string {
  if (!s) return ''
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

onMounted(load)
</script>

<template>
  <div>
    <EmptyState v-if="!canView" title="无审计查看权限" reason="需要 audit.view" />

    <template v-else>
      <!-- 筛选栏：条件全部下推服务端。时间列给显式「起始 / 截止」标签与快捷区间（评估 C5：
           datetime-local 空值呈现为「年/月/日 -:-」，看起来像坏掉的控件） -->
      <div class="card filters">
        <input v-model="f.actor" placeholder="操作人" @keyup.enter="applyFilters" />
        <input v-model="f.action" placeholder="动作（可下拉选）" list="audit-actions" @keyup.enter="applyFilters" />
        <datalist id="audit-actions">
          <option v-for="a in knownActions" :key="a" :value="a" />
        </datalist>
        <select v-model="f.result">
          <option value="">全部结果</option>
          <option value="ok">ok</option>
          <option value="queued">queued</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
        <input v-model="f.q" placeholder="关键词（目标 / 详情）" @keyup.enter="applyFilters" />
        <label class="dt">起始<input v-model="f.since" type="datetime-local" title="起始时间（留空 = 不限）" /></label>
        <label class="dt">截止<input v-model="f.until" type="datetime-local" title="截止时间（留空 = 不限）" /></label>
        <span class="quick">
          <button class="btn-ghost btn-sm" :disabled="loading" @click="quickRange('today')">今天</button>
          <button class="btn-ghost btn-sm" :disabled="loading" @click="quickRange('7d')">近 7 天</button>
          <button class="btn-ghost btn-sm" :disabled="loading" @click="quickRange('30d')">近 30 天</button>
          <button v-if="f.since || f.until" class="btn-ghost btn-sm" :disabled="loading" @click="clearTime">清除时间</button>
        </span>
        <button class="btn-primary btn-sm" :disabled="loading" @click="applyFilters">筛选</button>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <div v-if="loading" class="skeleton box" />

      <template v-else>
        <!-- 动作收进卡片顶栏（同 ProcessesView 范式）：去掉只放「重置 / 刷新」的
             页面级 page-head 横条，工具条紧贴它操作的表；横滚交给内部 .t-scroll。 -->
        <div class="card flush toolbar-card">
          <div class="card-toolbar">
            <span class="spacer" />
            <button class="btn-ghost btn-sm" :disabled="loading" @click="reset"><Icon name="refresh" :size="14" /> 重置</button>
            <RefreshBtn :disabled="loading" sm @click="load" />
          </div>
          <div class="t-scroll">
          <table class="fixed" v-table-nav>
            <!-- 列宽：目标为唯一弹性列；时间/结果/箭头列定宽，避免 19 字符时间戳换行。 -->
            <colgroup>
              <col class="w-atime" /><col class="w-aactor" /><col class="w-aaction" /><col class="w-atarget" /><col class="w-aresult" /><col class="w-achev" />
            </colgroup>
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="(a, i) in rows" :key="a.id ?? i">
                <tr class="data-row" @click="toggle(i)">
                  <td class="muted nowrap">{{ fmt(a.ts) }}</td>
                  <td class="ellipsis" :title="a.actor">{{ a.actor }}</td>
                  <td class="mono">{{ a.action }}</td>
                  <td class="muted ellipsis" :title="a.target || ''">{{ a.target || '—' }}</td>
                  <td><span class="badge" :class="resClass(a.result)">{{ auditResultLabel(a.result) }}</span></td>
                  <td class="nowrap chev-cell">
                    <Icon name="chevron" :size="14" :class="{ rot: expanded === i }" />
                  </td>
                </tr>
                <tr v-if="expanded === i" class="detail-row">
                  <td colspan="6">
                    <div class="detail">
                      <div><span class="k">记录 ID</span><span class="mono">{{ a.id ?? '—' }}</span></div>
                      <div><span class="k">来源 IP</span><span class="mono">{{ a.actor_ip || '—' }}</span></div>
                      <div v-if="prettyDetail(a.detail_json)">
                        <span class="k">详情</span>
                        <pre class="mono detail-json">{{ prettyDetail(a.detail_json) }}</pre>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!rows.length">
                <td colspan="6"><EmptyState title="暂无匹配的审计记录" /></td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <!-- 分页 -->
        <div class="pager">
          <span class="muted">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
          <span class="spacer" />
          <select v-model.number="pageSize" @change="changeSize">
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
          </select>
          <button class="btn-ghost btn-sm" :disabled="page <= 1" @click="goto(page - 1)">上一页</button>
          <button class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goto(page + 1)">下一页</button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: var(--fs-13); margin: 0 0 12px; }
.box { height: 300px; border-radius: var(--radius); }
.muted { color: var(--c-text-dim); }
.nowrap { white-space: nowrap; }

/* 筛选栏 */
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.filters input, .filters select {
  background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 7px 10px; font-size: var(--fs-13); font-family: inherit; }
.filters input { flex: 1 1 150px; min-width: 130px; }
/* 时间列：显式「起始 / 截止」标签——datetime-local 空值无法用 placeholder 说明（评估 C5）。
   nowrap 必要：flex 收缩会把两个字断成两行（实测「起/始」竖排）。 */
.filters .dt { display: flex; align-items: center; gap: 6px; flex: 0 1 auto;
  font-size: var(--fs-12); color: var(--c-text-dim); white-space: nowrap; }
.filters .dt input[type=datetime-local] { flex: 0 1 170px; }
.filters .quick { display: flex; align-items: center; gap: 6px; }

/* 表格。⚠️ 行类名不得用 .row：main.css 的 .row 是表单行布局（display:flex），
   会把 tr 变成 flex 容器——整行内容叠挤、不按列对齐（实测 trDisp=flex）。 */
.data-row { cursor: pointer; }
.data-row:hover { background: var(--c-hover, rgba(255,255,255,.04)); }
/* chev 列宽由 colgroup（w-achev 40px）决定；此前 scoped 的 width:1% 叠加在
   fixed 布局上把该列压到 26px，icon 溢出（scrollWidth 40 > clientWidth 26）。 */
.chev-cell { color: var(--c-text-dim); }
/* chevron 默认朝右；展开时转 90° 朝下（ICONS 无 chevron-down，复用同一个） */
.rot { transform: rotate(90deg); transition: transform .15s ease; }
.detail-row td { background: var(--c-surface-2, transparent); }
.detail { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.detail > div { display: flex; gap: 10px; align-items: flex-start; }
.k { color: var(--c-text-dim); font-size: var(--fs-12-5); min-width: 64px; }
.detail-json {
  margin: 0; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--c-bg); border: 1px solid var(--c-border);
  font-size: var(--fs-12); white-space: pre-wrap; word-break: break-all; flex: 1; }

/* 结果徽标 */
.b-ok { color: var(--c-ok); }
.b-bad { color: var(--c-danger); }
.b-wait { color: var(--c-warn); }

/* 分页 */
.pager { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: var(--fs-13); }
.pager select {
  background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: var(--fs-13); font-family: inherit; }
/* 审计表列宽（站点表范式）：目标为唯一弹性列；时间/结果/箭头列定宽不换行。 */
col.w-atime { width: 170px; }
col.w-aactor { width: 11%; }
col.w-aaction { width: 13%; }
col.w-atarget { width: auto; }
col.w-aresult { width: 90px; }
col.w-achev { width: 40px; }
</style>

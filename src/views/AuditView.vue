<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, AUDIT_RESULT_KEYS, auditResultLabel, fmtDateTime } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import TablePager from '@/components/TablePager.vue'
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

/** 日期框只读化：拦掉所有会改值的键，但放行导航/无障碍键（Tab、Shift+Tab、Enter、Esc、
 *  以及 Ctrl/Meta/Alt 组合），否则键盘用户会被困在框里。方向键在 datetime-local 里会改值，需拦。
 *  抽成纯函数便于单测钉住放行集合；接线只有模板 @keydown 一处。 */
function shouldBlockDateKey(e: KeyboardEvent): boolean {
  if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape') return false
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  return true
}
function onDateKeydown(e: KeyboardEvent) { if (shouldBlockDateKey(e)) e.preventDefault() }

/** 点框任意位置（含中文占位覆盖层、原生日历图标区）都弹出原生日期选择卡。
 *  showPicker 是浏览器标准 API，须在用户手势里调用；图标区点击浏览器本就会弹，
 *  再调一次是幂等的。不支持/无手势时抛错，吞掉即可——原生图标仍可照常弹。 */
function openDatePicker(e: MouseEvent) {
  try { (e.currentTarget as HTMLInputElement).showPicker?.() } catch { /* 浏览器不支持时退回原生图标 */ }
}

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

let loadSeq = 0

/**
 * 组装筛选参数。**列表与导出共用**——两边各写一份必然漂移，用户会拿着
 * 导出的 CSV 与页面上的列表对不上，取证时这是最糟糕的一类不一致。
 */
function filterParams(): Record<string, any> {
  const since = toTs(f.value.since)
  const until = toTs(f.value.until)
  const params: Record<string, any> = {}
  if (f.value.actor.trim()) params.actor = f.value.actor.trim()
  if (f.value.action.trim()) params.action = f.value.action.trim()
  if (f.value.result) params.result = f.value.result
  if (f.value.q.trim()) params.q = f.value.q.trim()
  if (since != null) params.since = since
  if (until != null) params.until = until
  return params
}

/** 时间窗反了要拦下；返回错误文案，合法返回 null */
function timeWindowError(): string | null {
  const since = toTs(f.value.since)
  const until = toTs(f.value.until)
  return since != null && until != null && since > until
    ? '起始时间不能晚于截止时间'
    : null
}

async function load() {
  const seq = ++loadSeq
  await run(async () => {
    expanded.value = null
    // 客户端先拦一次（服务端也会校验，这里是即时反馈，省一次往返）
    const twErr = timeWindowError()
    if (twErr) { error.value = twErr; return }
    const params: Record<string, any> = { page: page.value, page_size: pageSize.value, ...filterParams() }

    const r = await api.get<{ items: AuditEntry[]; page: number; page_size: number; total: number }>(API.audit(), { params })
    if (seq !== loadSeq) return   // 已有更新的筛选/翻页在途，丢弃本次结果
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
function changeSize(n: number) { pageSize.value = n; page.value = 1; load() }
function toggle(i: number) { expanded.value = expanded.value === i ? null : i }

function resClass(r: string) {
  if (r === 'ok' || r === 'changed') return 'b-ok'
  if (r === 'queued') return 'b-wait'
  if (r === 'denied' || r === 'error' || r === 'fail') return 'b-bad'
  return ''
}
function prettyDetail(s?: string | null): string {
  if (!s) return ''
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

// ── 导出 CSV ──
//
// 走 `api.download` 而不是 `window.open`：后者拿不到 4xx 响应体，
// 无权限/参数错误时会变成"点了没反应"，用户只能反复点击。
const exporting = ref(false)
async function exportCsv() {
  const twErr = timeWindowError()
  if (twErr) { error.value = twErr; return }
  exporting.value = true
  error.value = ''
  try {
    // 与服务端上限一致：导出不翻页，按当前筛选条件取全量（后端硬顶 5 万行）
    const blob = await api.download(API.auditExport(), { params: filterParams() })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 文件名由后端 Content-Disposition 决定时浏览器会用它；这里给个兜底名，
    // 因为 download 拿到的是 Blob，创建 a 标签必须自带 download 属性。
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 必须撤销：objectURL 不撤会一直占着这份 Blob 的内存直到页面卸载
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    exporting.value = false
  }
}

// ── 哈希链校验 ──
//
// 三种结果必须区分清楚，尤其 `not_chained`（有库但尚未上链）不能被说成"通过"：
// 那会让运维误以为历史记录也受保护。
type ChainState = { status: string; checked: number; unchained: number; broken_at_id: number | null; reason: string | null }
const chain = ref<ChainState | null>(null)
const verifying = ref(false)
async function verifyChain() {
  verifying.value = true
  error.value = ''
  try {
    chain.value = await api.get<ChainState>(API.auditVerify())
  } catch (e) {
    chain.value = null
    error.value = errorText(e)
  } finally {
    verifying.value = false
  }
}

/** 校验结论的展示口径（纯函数，便于测试） */
function chainLabel(c: ChainState): string {
  if (c.status === 'intact') {
    return c.unchained > 0
      ? `链完整（已校验 ${c.checked} 条；另有 ${c.unchained} 条为启用前历史，未上链）`
      : `链完整（已校验 ${c.checked} 条）`
  }
  if (c.status === 'broken') {
    return `发现篡改：id=${c.broken_at_id} — ${c.reason ?? ''}`
  }
  return '尚未上链（无带链值的记录）'
}
function chainClass(c: ChainState) {
  // 用全局 `.badge-*` 药丸类（彩色底），而不是 `.b-ok/.b-bad` 这类纯文字色工具类——
  // 后者配 `.badge` 只会得到灰底彩字，不是项目约定的状态徽章样式。
  if (c.status === 'intact') return 'badge-ok'
  if (c.status === 'broken') return 'badge-danger'
  return 'badge-warn'
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
          <option v-for="r in AUDIT_RESULT_KEYS" :key="r" :value="r">{{ auditResultLabel(r) }}</option>
        </select>
        <input v-model="f.q" placeholder="关键词（目标 / 详情）" @keyup.enter="applyFilters" />
        <label class="dt">起始<span class="dt-field">
          <input v-model="f.since" type="datetime-local" title="起始时间（留空 = 不限；点框选择）"
            @keydown="onDateKeydown" @click="openDatePicker" aria-label="起始时间，点框任意位置选择" />
          <span v-if="!f.since" class="dt-ph">年/月/日</span>
        </span></label>
        <label class="dt">截止<span class="dt-field">
          <input v-model="f.until" type="datetime-local" title="截止时间（留空 = 不限；点框选择）"
            @keydown="onDateKeydown" @click="openDatePicker" aria-label="截止时间，点框任意位置选择" />
          <span v-if="!f.until" class="dt-ph">年/月/日</span>
        </span></label>
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
            <!-- 校验结论贴在这里而非弹窗：它是"历史有没有被动过"的常驻结论，
                 弹窗关掉就没了，而这张表本身就是要被反复核对的材料 -->
            <span v-if="chain" class="badge chain-chip" :class="chainClass(chain)" :title="chainLabel(chain)">
              {{ chainLabel(chain) }}
            </span>
            <span class="spacer" />
            <button class="btn-ghost btn-sm" :disabled="verifying" @click="verifyChain">
              <Icon name="shield" :size="14" /> {{ verifying ? '校验中…' : '校验完整性' }}
            </button>
            <button class="btn-ghost btn-sm" :disabled="exporting || total === 0" @click="exportCsv">
              <Icon name="download" :size="14" /> {{ exporting ? '导出中…' : '导出 CSV' }}
            </button>
            <button class="btn-ghost btn-sm" :disabled="loading" @click="reset"><Icon name="refresh" :size="14" /> 重置</button>
            <RefreshBtn :disabled="loading" sm @click="load" />
          </div>
          <div class="t-scroll">
          <table class="fixed" v-table-nav>
            <!-- 列宽：目标为唯一弹性列；时间/结果/箭头列定宽，避免 16 字符时间戳换行。 -->
            <colgroup>
              <col class="w-atime" /><col class="w-aactor" /><col class="w-aaction" /><col class="w-atarget" /><col class="w-aresult" /><col class="w-achev" />
            </colgroup>
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="(a, i) in rows" :key="a.id ?? i">
                <tr class="data-row" @click="toggle(i)">
                  <td class="muted nowrap">{{ fmtDateTime(a.ts) }}</td>
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

        <!-- 分页（共享 TablePager：每页条数 10/20/50/100 回传后端 page_size；服务端分页故无「全部」） -->
        <TablePager :total="total" :page="page" :size="pageSize" :page-count="totalPages" :allow-all="false"
          @update:page="goto" @update:size="changeSize" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.box { height: 300px; border-radius: var(--radius); }
.muted { color: var(--c-text-dim); }
.nowrap { white-space: nowrap; }

/* 筛选栏 */
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.filters input, .filters select {
  background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 7px 10px; font-size: var(--fs-13); font-family: inherit;
  /* main.css 的 input,select{width:100%} 会把筛选框拉满整行；flex 条里须显式收回。
     box-sizing 让 padding/border 计入 flex-basis，宽度即所见。 */
  width: auto; box-sizing: border-box; }
/* 不再让文本框 grow 吸收整行余量（实测 1920 下各被撑到 792px、下拉到 1594px）。
   固定基准、窄屏可收缩后换行；datetime 仍由下方 .dt 规则单独定 170px。 */
.filters input { flex: 0 1 180px; min-width: 140px; }
.filters select { flex: 0 1 140px; min-width: 120px; }
/* 时间列：显式「起始 / 截止」标签——datetime-local 空值无法用 placeholder 说明（评估 C5）。
   nowrap 必要：flex 收缩会把两个字断成两行（实测「起/始」竖排）。 */
.filters .dt { display: flex; align-items: center; gap: 6px; flex: 0 1 auto;
  font-size: var(--fs-12); color: var(--c-text-dim); white-space: nowrap; }
.filters .dt-field { position: relative; display: inline-flex; flex: 0 1 170px; }
.filters .dt-field input[type=datetime-local] { width: 100%; }
/* 占位覆盖层：datetime-local 原生占位符由浏览器 locale 画（本机 zh-CN 是「年/月/日 --:--」，
   部分环境画成 yyyy/mm/日），placeholder 属性 / color / lang 均改不动它。空值时用
   pointer-events:none 的层物理盖住，统一显示中文「年/月/日」；点击穿过它仍可点右侧日历图标选日期。
   键盘编辑已由 onDateKeydown 拦掉（放行 Tab/Enter/Esc 保证可导航），故无需聚焦/敲键状态机——值非空才撤层。 */
.filters .dt-field .dt-ph {
  position: absolute; left: 1px; top: 1px; bottom: 1px; right: 30px;
  display: flex; align-items: center; padding: 0 10px;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: var(--fs-13); white-space: nowrap; pointer-events: none; }
.filters .quick { display: flex; align-items: center; gap: 6px; }

/* 表格。⚠️ 行类名不得用 .row：main.css 的 .row 是表单行布局（display:flex），
   会把 tr 变成 flex 容器——整行内容叠挤、不按列对齐（实测 trDisp=flex）。 */
.data-row { cursor: pointer; }
.data-row:hover { background: var(--c-hover); }
/* chev 列宽由 colgroup（w-achev 40px）决定；此前 scoped 的 width:1% 叠加在
   fixed 布局上把该列压到 26px，icon 溢出（scrollWidth 40 > clientWidth 26）。 */
.chev-cell { color: var(--c-text-dim); }
/* chevron 默认朝右；展开时转 90° 朝下（ICONS 无 chevron-down，复用同一个） */
.rot { transform: rotate(90deg); transition: transform .15s ease; }
.detail-row td { background: var(--c-surface-2); }
.detail { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.detail > div { display: flex; gap: 10px; align-items: flex-start; }
.k { color: var(--c-text-dim); font-size: var(--fs-12-5); min-width: 64px; }
.detail-json {
  margin: 0; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--c-bg); border: 1px solid var(--c-border);
  font-size: var(--fs-12); white-space: pre-wrap; word-break: break-all; flex: 1; }

/* 校验结论徽标：结论可能较长（含条数与说明），允许换行但别撑破工具条 */
.chain-chip { white-space: normal; max-width: 46ch; line-height: 1.45; }

/* 结果徽标 */
.b-ok { color: var(--c-ok); }
.b-bad { color: var(--c-danger); }
.b-wait { color: var(--c-warn); }

/* 审计表列宽（站点表范式）：目标为唯一弹性列；时间/结果/箭头列定宽不换行。 */
col.w-atime { width: 170px; }
col.w-aactor { width: 11%; }
col.w-aaction { width: 13%; }
col.w-atarget { width: auto; }
col.w-aresult { width: 90px; }
col.w-achev { width: 40px; }
</style>

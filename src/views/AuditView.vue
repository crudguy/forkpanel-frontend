<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, auditResultLabel, fmtDateTime } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

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
const error = ref('')
const loading = ref(true)

// ── 筛选条件（空值不下传，等价于"不过滤"）──
const f = ref({ actor: '', action: '', result: '', q: '', since: '', until: '' })

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
  error.value = ''; loading.value = true; expanded.value = null
  const since = toTs(f.value.since)
  const until = toTs(f.value.until)
  // 客户端先拦一次（服务端也会校验，这里是即时反馈，省一次往返）
  if (since != null && until != null && since > until) {
    error.value = '起始时间不能晚于截止时间'
    loading.value = false
    return
  }
  try {
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
    // 筛选后总页数可能变小：越界则回退到最后一页
    if (page.value > totalPages.value) { page.value = totalPages.value; await load(); return }
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
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
    <div class="page-head">
      <span class="spacer" />
      <button class="btn-ghost" :disabled="loading" @click="reset"><Icon name="refresh" :size="15" /> 重置</button>
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!canView" title="无审计查看权限" reason="需要 audit.view" />

    <template v-else>
      <!-- 筛选栏：条件全部下推服务端 -->
      <div class="card filters">
        <input v-model="f.actor" placeholder="操作人" @keyup.enter="applyFilters" />
        <input v-model="f.action" placeholder="动作，如 auth.login" @keyup.enter="applyFilters" />
        <select v-model="f.result">
          <option value="">全部结果</option>
          <option value="ok">ok</option>
          <option value="queued">queued</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
        <input v-model="f.q" placeholder="关键词（目标 / 详情）" @keyup.enter="applyFilters" />
        <input v-model="f.since" type="datetime-local" title="起始时间" />
        <input v-model="f.until" type="datetime-local" title="截止时间" />
        <button class="btn-primary btn-sm" :disabled="loading" @click="applyFilters">筛选</button>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <div v-if="loading" class="skeleton box" />

      <template v-else>
        <div class="card flush">
          <table>
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="(a, i) in rows" :key="a.id ?? i">
                <tr class="row" @click="toggle(i)">
                  <td class="muted nowrap">{{ fmt(a.ts) }}</td>
                  <td>{{ a.actor }}</td>
                  <td class="mono">{{ a.action }}</td>
                  <td class="muted">{{ a.target || '—' }}</td>
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
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.box { height: 300px; border-radius: var(--radius); }
.muted { color: var(--c-text-dim); }
.nowrap { white-space: nowrap; }

/* 筛选栏 */
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.filters input, .filters select {
  background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 7px 10px; font-size: 13px; font-family: inherit; }
.filters input { flex: 1 1 150px; min-width: 130px; }
.filters input[type=datetime-local] { flex: 0 1 170px; }

/* 表格 */
.row { cursor: pointer; }
.row:hover { background: var(--c-hover, rgba(255,255,255,.04)); }
.chev-cell { color: var(--c-text-dim); width: 1%; }
/* chevron 默认朝右；展开时转 90° 朝下（ICONS 无 chevron-down，复用同一个） */
.rot { transform: rotate(90deg); transition: transform .15s ease; }
.detail-row td { background: var(--c-surface-2, transparent); }
.detail { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.detail > div { display: flex; gap: 10px; align-items: flex-start; }
.k { color: var(--c-text-dim); font-size: 12.5px; min-width: 64px; }
.detail-json {
  margin: 0; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--c-bg); border: 1px solid var(--c-border);
  font-size: 12px; white-space: pre-wrap; word-break: break-all; flex: 1; }

/* 结果徽标 */
.b-ok { color: var(--c-ok); }
.b-bad { color: var(--c-danger); }
.b-wait { color: var(--c-warn); }

/* 分页 */
.pager { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 13px; }
.pager select {
  background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: 13px; font-family: inherit; }
</style>

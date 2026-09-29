<script setup lang="ts">
/**
 * 安全中心：只读安全基线（契约 SecurityBaselineItem[]）+ 活跃会话。
 *
 * 分级：applicable=false → 灰（该环境不适用，**非通过**）；ok=true → 绿；ok=false → 红。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'

interface BaselineItem {
  key: string; title: string; ok: boolean
  current: string; expected: string; advice: string; applicable: boolean
}

/** 在线会话（后端内存快照；ip 刻意不采集——后端返回 null，界面不展示该列） */
interface SessionInfo {
  id: string
  user: string
  role: string
  ip: null
  created_at: number
  last_seen: number
  expires_at: number
  idle_secs: number
  current: boolean
}

const baseline = ref<BaselineItem[]>([])
const sessions = ref<SessionInfo[]>([])
const error = ref('')
const loading = ref(true)

async function load() {
  error.value = ''; loading.value = true
  try {
    const b = await api.get<BaselineItem[]>(API.security.baseline()).catch(() => null)
    baseline.value = Array.isArray(b) ? b : []
    const s = await api.get<{ sessions: SessionInfo[] }>(API.security.sessions()).catch(() => null)
    sessions.value = s?.sessions ?? []
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
onMounted(load)

const passed = computed(() => baseline.value.filter(c => c.applicable && c.ok).length)
const risks = computed(() => baseline.value.filter(c => c.applicable && !c.ok).length)
const naCount = computed(() => baseline.value.filter(c => !c.applicable).length)

async function revoke(s: SessionInfo) {
  const tag = s.current ? '这将登出你自己的当前会话。' : '其持有者将被强制下线。'
  if (!window.confirm(`确认吊销 ${s.user} 的会话？${tag}`)) return
  try { await api.del(API.security.revokeSession(s.id)); await load() }
  catch (e) { error.value = errorText(e) }
}

function fmtTime(unix: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false })
}

function blClass(c: BaselineItem) {
  return !c.applicable ? 'na' : (c.ok ? 'ok' : 'danger')
}
function blText(c: BaselineItem) {
  if (!c.applicable) return '不适用'
  return c.ok ? c.current : `${c.current} → 期望 ${c.expected}`
}
</script>

<template>
  <div>
    <div class="page-head">
      <div><h2 class="page-title">安全中心</h2><p class="page-sub">基线检查与活跃会话</p></div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <div v-if="loading" class="skeleton box" />
    <div v-else class="grid cols-2">
      <section class="card">
        <div class="sec-head">
          <Icon name="shield" :size="16" /><span>安全基线</span>
          <span class="spacer" />
          <span v-if="baseline.length" class="muted summary">
            通过 <b class="s-ok">{{ passed }}</b> · 风险 <b class="s-risk">{{ risks }}</b> · 不适用 {{ naCount }}
          </span>
        </div>
        <ul class="checks">
          <li v-for="c in baseline" :key="c.key" :title="c.advice">
            <span class="dot" :class="blClass(c)" />
            <span class="c-name">{{ c.title }}</span>
            <span class="c-detail muted">{{ blText(c) }}</span>
          </li>
          <li v-if="!baseline.length"><span class="dot warn" /> 安全基线模块尚未接入</li>
        </ul>
      </section>

      <section class="card">
        <div class="sec-head"><Icon name="users" :size="16" /><span>活跃会话</span></div>
        <table v-if="sessions.length">
          <thead><tr><th>用户</th><th>角色</th><th>创建于</th><th>空闲</th><th /></tr></thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.id">
              <td>
                {{ s.user }}
                <span v-if="s.current" class="cur-badge">当前</span>
              </td>
              <td class="muted">{{ s.role }}</td>
              <td class="muted">{{ fmtTime(s.created_at) }}</td>
              <td class="muted mono">{{ s.idle_secs < 60 ? `${s.idle_secs}s` : `${Math.floor(s.idle_secs / 60)}m` }}</td>
              <td class="nowrap">
                <button class="btn-danger btn-sm" @click="revoke(s)"><Icon name="logout" :size="14" /> 吊销</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">暂无活跃会话信息</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.page-sub { margin: 2px 0 0; color: var(--c-text-dim); font-size: 13px; }
.box { height: 220px; border-radius: var(--radius); }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
.checks li { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.c-name { font-weight: 500; }
.c-detail { margin-left: auto; font-size: 12.5px; text-align: right; }
.summary { font-size: 12.5px; }
.s-ok { color: var(--c-ok, #3fb950); }
.s-risk { color: var(--c-danger, #f85149); }
.dot.na { background: var(--c-text-dim, #8b949e); opacity: .55; }
.cur-badge { margin-left: 6px; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--c-ok-soft, rgba(63,185,80,.15)); color: var(--c-ok, #3fb950); }
.muted { color: var(--c-text-mute); }
.mono { font-family: var(--mono); }
.nowrap { white-space: nowrap; }
</style>

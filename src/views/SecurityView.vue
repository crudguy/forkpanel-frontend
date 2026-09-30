<script setup lang="ts">
/**
 * 安全中心：只读安全基线（契约 SecurityBaselineItem[]）+ 活跃会话。
 *
 * 分级：applicable=false → 灰（该环境不适用，**非通过**）；ok=true → 绿；ok=false → 红。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
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
const auth = useAuthStore()
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

// ─────────────── 基线一键修复 ───────────────
// 后端白名单：仅 sshd 三项可自动修（其余写入系统配置风险过高，不做）
const FIXABLE = ['ssh.permit_root_login', 'ssh.password_auth', 'ssh.pubkey_auth']
const notice = ref('')
const acting = ref(false)

function canFix(c: BaselineItem): boolean {
  return c.applicable && !c.ok && FIXABLE.includes(c.key)
}

async function fix(c: BaselineItem) {
  if (!window.confirm(
    `将修改系统配置：${c.title}\n\n` +
    '后端流程：先备份原文件 → 写入 → sshd -t 校验 → 校验不通过自动回滚。\n' +
    '若本机没有 sshd，后端会拒绝修改（不会写坏配置把你锁在门外）。\n\n确认继续？')) return
  const word = window.prompt('请输入「确认修复」以继续：')
  if (word === null) return
  error.value = ''; notice.value = ''
  acting.value = true
  try {
    const r = await api.post<{ changed: boolean; backup: string | null; validated: boolean }>(
      API.security.baselineApply(), { key: c.key, confirm_token: word.trim() })
    notice.value = r.changed
      ? `已修复${r.backup ? `；原文件备份：${r.backup}` : ''}`
      : '该项已符合预期，未做改动'
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { acting.value = false }
}

// ─────────────── 两步验证（MFA / TOTP） ───────────────
interface MfaEnroll { secret: string; otpauth_uri: string; recovery_codes: string[] }

const mfaEnrolling = ref<MfaEnroll | null>(null)
const mfaCode = ref('')
// 初值来自 /auth/me 权威下发（审计 F8）。此前初值恒为 false 且挂载时无查询，
// 已启用 MFA 的用户刷新后显示「未启用」；后来靠「重复 enroll 的 400 文案含
// 「已启用」」反推——后端改文案即失效。
const mfaEnabled = ref(auth.me?.mfa_enabled ?? false)

async function doEnroll() {
  error.value = ''; notice.value = ''
  acting.value = true
  try {
    mfaEnrolling.value = await api.post<MfaEnroll>(API.auth.mfaEnroll())
    mfaCode.value = ''
  } catch (e) { error.value = errorText(e) } finally { acting.value = false }
}

async function doVerify() {
  error.value = ''; notice.value = ''
  acting.value = true
  try {
    await api.post(API.auth.mfaVerify(), { code: mfaCode.value.trim() })
    mfaEnabled.value = true
    if (auth.me) auth.me.mfa_enabled = true
    mfaEnrolling.value = null
    mfaCode.value = ''
    notice.value = 'MFA 已启用：下次登录需额外输入动态口令。'
  } catch (e) { error.value = errorText(e) }
  finally { acting.value = false }
}

async function doDisable() {
  // 关闭必须出示第二因子：否则一个被劫持的会话就能顺手关掉受害者账户的 MFA
  const code = window.prompt('关闭 MFA 需要出示动态口令或一次性恢复码：')
  if (!code) return
  error.value = ''; notice.value = ''
  acting.value = true
  try {
    await api.post(API.auth.mfaDisable(), { code: code.trim() })
    mfaEnabled.value = false
    if (auth.me) auth.me.mfa_enabled = false
    notice.value = 'MFA 已关闭。'
  } catch (e) { error.value = errorText(e) }
  finally { acting.value = false }
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
    <p v-if="notice" class="notice">{{ notice }}</p>
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
            <button
              v-if="canFix(c)"
              class="btn-ghost btn-sm"
              :disabled="acting"
              title="先备份 → 写 → sshd -t 校验 → 不通过自动回滚"
              @click="fix(c)"
            >修复</button>
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

      <section class="card">
        <div class="sec-head"><Icon name="shield" :size="16" /><span>两步验证（MFA）</span></div>

        <p class="muted">当前状态：<b :class="mfaEnabled ? 's-ok' : 's-risk'">{{ mfaEnabled ? '已启用' : '未启用' }}</b></p>

        <div v-if="!mfaEnabled && !mfaEnrolling" class="ops-row">
          <button class="btn-primary btn-sm" :disabled="acting" @click="doEnroll">启用 MFA</button>
          <span class="muted small">登录时除密码外，还需验证器生成的 6 位动态口令</span>
        </div>

        <div v-else-if="mfaEnrolling" class="mfa-box">
          <p class="muted">用验证器 App 扫码，或手动录入下面的密钥：</p>
          <p class="mono secret">{{ mfaEnrolling.secret }}</p>
          <details>
            <summary class="muted small">otpauth 地址（扫码用）</summary>
            <p class="mono small break">{{ mfaEnrolling.otpauth_uri }}</p>
          </details>
          <p class="warn-tip">
            以下恢复码<b>只显示这一次</b>，请立即保存——手机丢失时它们是唯一的登录途径。
          </p>
          <ul class="codes">
            <li v-for="c in mfaEnrolling.recovery_codes" :key="c" class="mono">{{ c }}</li>
          </ul>
          <div class="ops-row">
            <input v-model="mfaCode" class="inp" placeholder="6 位动态口令" maxlength="6" />
            <button
              class="btn-primary btn-sm"
              :disabled="acting || mfaCode.trim().length !== 6"
              @click="doVerify"
            >验证并启用</button>
          </div>
        </div>

        <div v-else class="ops-row">
          <button class="btn-danger btn-sm" :disabled="acting" @click="doDisable">关闭 MFA</button>
          <span class="muted small">关闭需出示动态口令或恢复码</span>
        </div>
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
.notice { color: var(--c-ok, #3fb950); font-size: 13px; margin: 0 0 12px; }
.ops-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.small { font-size: 12px; }
.mfa-box { margin-top: 8px; }
.secret { font-size: 13px; padding: 6px 8px; border-radius: var(--radius, 6px); background: rgba(127,127,127,.12); user-select: all; }
.codes { list-style: none; margin: 8px 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; font-size: 12.5px; }
.warn-tip { margin: 8px 0 4px; font-size: 12.5px; color: var(--c-warn, #d29922); }
.inp { padding: 4px 8px; border: 1px solid var(--c-border, #444); border-radius: var(--radius, 6px); background: transparent; color: inherit; font-family: var(--mono); }
.break { word-break: break-all; }
</style>

<script setup lang="ts">
/**
 * 安全中心：只读安全基线（契约 SecurityBaselineItem[]）+ 活跃会话。
 *
 * 分区（A9）：本页拆成三块清晰分区——
 *   1. 汇总卡：通过 / 风险 / 不适用 三张指标卡（顶部 KPI 行，替代原卡片头里的内联文字摘要）；
 *   2. 清单：安全基线逐项检查清单（系统级配置，如 sshd）；
 *   3. 账号：账号安全分区，聚合「活跃会话」与「两步验证 MFA」两件账号/会话相关事项。
 *
 * 分级：applicable=false → 灰（该环境不适用，**非通过**）；ok=true → 绿；ok=false → 红。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { fmtDateTime, fmtAgo, roleLabel } from '@/api/types'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import MetricCard from '@/components/MetricCard.vue'
import { type MetricItem } from '@/components/MetricHeader.vue'
import { toast } from '@/composables/useToast'
import { useModal } from '@/composables/useModal'
import { useAsync } from '@/composables/useAsync'

interface BaselineItem {
  key: string; title: string; ok: boolean
  current: string; expected: string; advice: string; applicable: boolean
}

/** 在线会话（后端内存快照）。`ip` 后端仍不采集、恒返回 null，
 *  故类型标成 `string | null` 而不是 `null` —— 硬编码成字面量 null 会让
 *  后端将来开始返回 IP 时**编译报错**（本该静默通过后逐步展示），
 *  反而阻碍上游补齐。 */
interface SessionInfo {
  id: string
  user: string
  role: string
  ip: string | null
  created_at: number
  last_seen: number
  expires_at: number
  idle_secs: number
  current: boolean
}

const baseline = ref<BaselineItem[]>([])
const auth = useAuthStore()
const sessions = ref<SessionInfo[]>([])
const { loading, error, run } = useAsync(true)

async function load() {
  await run(async () => {
    const b = await api.get<BaselineItem[]>(API.security.baseline()).catch(() => null)
    baseline.value = Array.isArray(b) ? b : []
    const s = await api.get<{ sessions: SessionInfo[] }>(API.security.sessions()).catch(() => null)
    sessions.value = s?.sessions ?? []
  })
}
onMounted(load)

const passed = computed(() => baseline.value.filter(c => c.applicable && c.ok).length)
const risks = computed(() => baseline.value.filter(c => c.applicable && !c.ok).length)
const naCount = computed(() => baseline.value.filter(c => !c.applicable).length)

/** 汇总卡（A9）：把原卡片头里「通过 X · 风险 Y · 不适用 Z」的内联文字升级为
 *  独立的指标卡行，与全局 MetricCard 范式一致；合规率走 progress 条。 */
const summaryCards = computed<MetricItem[]>(() => {
  const total = passed.value + risks.value + naCount.value
  const rate = total ? Math.round((passed.value / total) * 100) : 0
  return [
    { label: '通过', value: String(passed.value), icon: 'check', tone: 'ok',
      sub: total ? `合规率 ${rate}%` : undefined, progress: rate },
    { label: '风险', value: String(risks.value), icon: 'alert', tone: 'danger',
      sub: risks.value ? '需处理' : '无风险项' },
    { label: '不适用', value: String(naCount.value), icon: 'info', tone: 'neutral',
      sub: '当前环境未覆盖' },
  ]
})

/** 待吊销会话（审计 U5：window.confirm → ConfirmDialog） */
const revokeTarget = ref<SessionInfo | null>(null)
function askRevoke(s: SessionInfo) { revokeTarget.value = s }

async function revoke(s: SessionInfo) {
  try {
    await api.del(API.security.revokeSession(s.id))
    revokeTarget.value = null
    await load()
  }
  catch (e) { error.value = errorText(e) }
}


/** 会话列表用相对时间更直观（"3 分钟前"比时间戳更容易判断是否该踢）。 */
function fmtAgoTime(unix: number): string {
  return fmtAgo(unix)
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
const acting = ref(false)

function canFix(c: BaselineItem): boolean {
  return c.applicable && !c.ok && FIXABLE.includes(c.key)
}

/** 待确认修复的基线项（审计 U5：window.confirm/prompt → ConfirmDialog 确认词模式） */
const pendingFix = ref<BaselineItem | null>(null)
function askFix(c: BaselineItem) { pendingFix.value = c }

async function fix(c: BaselineItem) {
  error.value = ''
  acting.value = true
  try {
    const r = await api.post<{ changed: boolean; backup: string | null; validated: boolean }>(
      API.security.baselineApply(), { key: c.key, confirm_token: '确认修复' })
    toast(r.changed
      ? `已修复${r.backup ? `；原文件备份：${r.backup}` : ''}`
      : '该项已符合预期，未做改动')
    pendingFix.value = null
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
  error.value = ''
  acting.value = true
  try {
    mfaEnrolling.value = await api.post<MfaEnroll>(API.auth.mfaEnroll())
    mfaCode.value = ''
  } catch (e) { error.value = errorText(e) } finally { acting.value = false }
}

async function doVerify() {
  error.value = ''
  acting.value = true
  try {
    await api.post(API.auth.mfaVerify(), { code: mfaCode.value.trim() })
    mfaEnabled.value = true
    if (auth.me) auth.me.mfa_enabled = true
    mfaEnrolling.value = null
    mfaCode.value = ''
    toast('MFA 已启用：下次登录需额外输入动态口令。')
  } catch (e) { error.value = errorText(e) }
  finally { acting.value = false }
}

/** 关闭 MFA 需出示第二因子（动态口令/恢复码）——这是真实凭据而非确认词，
 *  不能用 ConfirmDialog 确认词模式，用专用输入弹窗（审计 U5：替代 window.prompt） */
const disableMfa = ref(false)
// Esc 关闭 + Tab 焦点陷阱 + 打开聚焦 + 关闭后焦点返还（此前本弹窗三者皆无）。
// X / 点遮罩 / 取消按钮统一走 closeMfa。
const mfaBox = ref<HTMLElement | null>(null)
const { close: closeMfa } = useModal(() => disableMfa.value, mfaBox, () => { disableMfa.value = false })
const mfaDisableCode = ref('')

async function doDisable() {
  const code = mfaDisableCode.value.trim()
  if (!code) return
  error.value = ''
  acting.value = true
  try {
    await api.post(API.auth.mfaDisable(), { code })
    mfaEnabled.value = false
    if (auth.me) auth.me.mfa_enabled = false
    toast('MFA 已关闭。')
    disableMfa.value = false
    mfaDisableCode.value = ''
  } catch (e) { error.value = errorText(e) }
  finally { acting.value = false }
}
</script>

<template>
  <div>
    <p v-if="error" class="err">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
    <div v-if="loading" class="skeleton box" />
    <template v-else>
      <!-- ① 汇总卡：通过 / 风险 / 不适用 -->
      <div class="grid cols-3 summary">
        <MetricCard v-for="c in summaryCards" :key="c.label" v-bind="c" />
      </div>

      <!-- ② 清单：安全基线逐项检查 -->
      <section class="card">
        <!-- 刷新并到卡片标题右侧（同 ProcessesView「动作收进卡片顶栏」范式）：
             去掉只放一个按钮的页面级 page-head 横条，动作紧贴它刷新的清单。 -->
        <div class="sec-head">
          <Icon name="shield" :size="16" /><span>安全基线清单</span>
          <span class="spacer" />
          <RefreshBtn :disabled="loading" sm @click="load" />
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
              @click="askFix(c)"
            >修复</button>
          </li>
          <li v-if="!baseline.length"><span class="dot warn" /> 安全基线模块尚未接入</li>
        </ul>
      </section>

      <!-- ③ 账号：账号安全分区（活跃会话 + 两步验证 MFA） -->
      <div class="part">
        <div class="part-head">
          <Icon name="users" :size="15" /><span>账号安全</span>
        </div>
        <div class="grid cols-2">
          <section class="card">
            <div class="sec-head"><Icon name="users" :size="16" /><span>活跃会话</span></div>
            <div class="t-scroll" v-if="sessions.length">
            <table class="fixed" v-table-nav>
              <!-- 列宽（站点表范式）：用户为唯一弹性列；吊销按钮列定宽 100px。 -->
              <colgroup>
                <col class="w-suser" /><col class="w-srole" /><col class="w-sctime" /><col class="w-sidle" /><col class="w-sacts" />
              </colgroup>
              <thead><tr><th>用户</th><th>角色</th><th>创建于</th><th>空闲</th><th /></tr></thead>
              <tbody>
                <tr v-for="s in sessions" :key="s.id">
                  <td>
                    {{ s.user }}
                    <span v-if="s.current" class="cur-badge">当前</span>
                  </td>
                  <td class="muted">{{ roleLabel(s.role) }}</td>
                  <td class="muted" :title="fmtDateTime(s.created_at)">{{ fmtAgoTime(s.created_at) }}</td>
                  <td class="muted mono">{{ s.idle_secs < 60 ? `${s.idle_secs}s` : `${Math.floor(s.idle_secs / 60)}m` }}</td>
                  <td class="nowrap">
                    <button class="btn-ghost btn-sm danger" @click="askRevoke(s)"><Icon name="logout" :size="14" /> 吊销</button>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
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
              <button class="btn-ghost btn-sm danger" :disabled="acting" @click="disableMfa = true">关闭 MFA</button>
              <span class="muted small">关闭需出示动态口令或恢复码</span>
            </div>
          </section>
        </div>
      </div>
    </template>

    <!-- 吊销会话（审计 U5 收尾：全项目最后一处 window.confirm） -->
    <ConfirmDialog
      :open="!!revokeTarget" danger title="吊销会话"
      :detail="revokeTarget ? `确认吊销 ${revokeTarget.user} 的会话？${revokeTarget.current ? '这将登出你自己的当前会话。' : '其持有者将被强制下线。'}` : ''"
      @confirm="revokeTarget && revoke(revokeTarget)" @cancel="revokeTarget = null"
    />

    <!-- 基线修复确认（审计 U5：confirm+prompt → ConfirmDialog 确认词） -->
    <ConfirmDialog
      :open="!!pendingFix" danger title="修复安全基线"
      :detail="pendingFix ? `将修改系统配置：${pendingFix.title}。后端流程：先备份原文件 → 写入 → sshd -t 校验 → 校验不通过自动回滚。若本机没有 sshd，后端会拒绝修改（不会写坏配置把你锁在门外）。` : ''"
      confirm-word="确认修复" @confirm="pendingFix && fix(pendingFix)" @cancel="pendingFix = null"
    />

    <!-- 关闭 MFA：出示第二因子（动态口令或恢复码） -->
    <div v-if="disableMfa" class="mask" @click.self="closeMfa">
      <div ref="mfaBox" class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">关闭 MFA</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeMfa">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <!-- 内联 style 一律收进公共类（.modal-lead）：散落的 style 属性无法统一维护 -->
        <p class="modal-lead">
          关闭需出示第二因子，否则一个被劫持的会话就能顺手关掉账户的 MFA。
        </p>
        <label class="blk">动态口令（6 位）或一次性恢复码
          <input v-model="mfaDisableCode" autocomplete="off" @keyup.enter="doDisable" />
        </label>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeMfa">取消</button>
            <!-- 关闭 MFA 是安全敏感动作 → 实心 .btn-danger -->
            <button class="btn-danger" :disabled="acting || !mfaDisableCode.trim()" @click="doDisable">
              {{ acting ? '提交中…' : '确认关闭' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.box { height: 220px; border-radius: var(--radius); }
/* 汇总卡与分区之间留足竖向间距（原 grid.cols-2 整页混排 → 三块分区清晰分层） */
.summary { margin-bottom: 16px; }
.part { margin-top: 16px; }
.part-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-size: var(--fs-15); font-weight: 600; color: var(--c-text); }
.part-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-size: var(--fs-15); font-weight: 600; color: var(--c-text); }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
.checks li { display: flex; align-items: center; gap: 10px; font-size: var(--fs-13-5); }
.c-name { font-weight: 500; }
.c-detail { margin-left: auto; font-size: var(--fs-12-5); text-align: right; }
.summary { font-size: var(--fs-12-5); }
.s-ok { color: var(--c-ok, #3fb950); }
.s-risk { color: var(--c-danger, #f85149); }
.dot.na { background: var(--c-text-dim, #8b949e); opacity: .55; }
.cur-badge { margin-left: 6px; font-size: var(--fs-12); padding: 1px 7px; border-radius: 999px; background: var(--c-ok-soft, rgba(63,185,80,.15)); color: var(--c-ok, #3fb950); }
.muted { color: var(--c-text-mute); }
.mono { font-family: var(--mono); }
.nowrap { white-space: nowrap; }
.ops-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.small { font-size: var(--fs-12); }
.mfa-box { margin-top: 8px; }
.secret { font-size: var(--fs-13); padding: 6px 8px; border-radius: var(--radius, 6px); background: rgba(127,127,127,.12); user-select: all; }
.codes { list-style: none; margin: 8px 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; font-size: var(--fs-12-5); }
.warn-tip { margin: 8px 0 4px; font-size: var(--fs-12-5); color: var(--c-warn, #d29922); }
.inp { padding: 4px 8px; border: 1px solid var(--c-border, #444); border-radius: var(--radius, 6px); background: transparent; color: inherit; font-family: var(--mono); }
.break { word-break: break-all; }
/* 关闭 MFA 输入弹窗（与其他视图同形态）：遮罩 / 弹窗框 / 标题行 / 关闭按钮 /
   字段 / 操作条一律取 main.css 的公共式样（.muted 也是公共工具类，不再私抄） */
/* 会话表列宽（站点表范式）：用户为唯一弹性列；吊销按钮列 100px。 */
col.w-suser { width: auto; }
col.w-srole { width: 100px; }
col.w-sctime { width: 110px; }
col.w-sidle { width: 80px; }
col.w-sacts { width: 100px; }
</style>

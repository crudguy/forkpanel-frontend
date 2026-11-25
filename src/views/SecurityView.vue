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
import { fmtDateTime, fmtAgo, roleLabel, CAP } from '@/api/types'
import Icon from '@/components/Icon.vue'
import QrCode from '@/components/QrCode.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import MetricCard from '@/components/MetricCard.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { type MetricItem } from '@/components/MetricHeader.vue'
import { toast } from '@/composables/useToast'
import { useModal } from '@/composables/useModal'
import { useAsync } from '@/composables/useAsync'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import {
  SSH_PORT_CONFIRM_WORD, validatePortInput, portSummary, riskNotice,
  canSubmit, changeMessage, type SshPortState, type SshPortChange,
} from '@/composables/sshPort'
import {
  baselineStatus, BASELINE_STATUS_LABEL, canFixBaseline, baselineOpNote, baselineAdvice,
  sshResultLabel, sshRiskLabel, sshRiskBadge, sshLogTime, banIpIssue, BAN_IP_HINT,
  type SshLoginEvent,
} from '@/composables/securityBaseline'

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

// 全站表格约定：会话表是记录列表（行数随登录会话增长），接客户端分页 + 表头排序。
// 默认按用户升序（主标识列，与用户表同口径，顺序稳定）；created_at 时间降序，
// idle_secs 数值降序——点开空闲列即「最久没动」在前，便于判断该吊销哪个会话。
const sessionSortCols: SortColumn<SessionInfo>[] = [
  { key: 'user', dir: 'asc', compare: (a, b) => (a.user ?? '').localeCompare(b.user ?? '') },
  { key: 'role', dir: 'asc', compare: (a, b) => (a.role ?? '').localeCompare(b.role ?? '') },
  { key: 'created_at', dir: 'desc', compare: (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) },
  { key: 'idle_secs', dir: 'desc', compare: (a, b) => (a.idle_secs ?? 0) - (b.idle_secs ?? 0) },
]
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<SessionInfo>({
    rows: sessions, defaultSize: 100, defaultSort: { key: 'user', dir: 'asc' },
    columns: sessionSortCols, persistKey: 'security.sessions',
  })
/** 区分「加载失败」与「动作失败」：前者不渲染汇总卡（否则显示风险 0），后者保留页面内容 */
const loadFailed = ref(false)

// ─────────────── SSH 端口（P1-7） ───────────────
// 端口现状单独用一个 ref：它读的是 sshd 配置文件，与基线扫描失败互不牵连
// （基线挂了不该连带把端口区也藏起来，反之亦然）。
const sshPort = ref<SshPortState | null>(null)
const sshPortErr = ref('')
const editingPort = ref(false)
const portInput = ref('')
const portConfirm = ref('')
const keepOld = ref(true)
/** 弹窗内的错误位：页面级 error 会被 .mask 挡住 */
const portDialogErr = ref('')
/** 确认词校验错误：显示在确认输入框下方，底部条只留给服务端错误。 */
const confirmErr = ref('')
const portBox = ref<HTMLElement | null>(null)
const { close: closePort } = useModal(
  () => editingPort.value, portBox,
  () => { editingPort.value = false; portDialogErr.value = ''; confirmErr.value = '' },
)

const portInvalid = computed(() => {
  if (!editingPort.value) return ''
  return validatePortInput(portInput.value, sshPort.value?.effective ?? null)
})
const portSubmittable = computed(() => canSubmit(
  portInput.value, sshPort.value?.effective ?? null, portConfirm.value,
))

async function loadSshPort() {
  sshPortErr.value = ''
  try {
    sshPort.value = await api.get<SshPortState>(API.security.sshPort())
  }
  // 单独失败只标这一块，不让整页进入错误态
  catch (e) { sshPortErr.value = errorText(e) }
}

function askEditPort() {
  portInput.value = String(sshPort.value?.effective ?? 22)
  portConfirm.value = ''
  portDialogErr.value = ''; confirmErr.value = ''
  keepOld.value = true
  editingPort.value = true
}

async function submitPort() {
  const msg = validatePortInput(portInput.value, sshPort.value?.effective ?? null)
  // 端口错误由下方 portInvalid 就近显示，不再往弹窗底部堆同一句话。
  if (msg) return
  if (portConfirm.value.trim() !== SSH_PORT_CONFIRM_WORD) {
    confirmErr.value = `请输入确认词「${SSH_PORT_CONFIRM_WORD}」`
    return
  }
  confirmErr.value = ''
  portDialogErr.value = ''
  acting.value = true
  try {
    const r = await api.put<SshPortChange>(API.security.sshPort(), {
      port: Number(portInput.value.trim()),
      keep_old: keepOld.value,
      confirm_token: portConfirm.value.trim(),
    })
    toast(changeMessage(r))
    editingPort.value = false
    await loadSshPort()
  }
  // 失败留在弹窗里：端口被占用之类的错误必须让用户在还能改输入的地方看到
  catch (e) { portDialogErr.value = errorText(e) }
  finally { acting.value = false }
}

// ─────────────── SSH 登录 / 爆破记录 ───────────────
interface SshLogResult {
  rows: SshLoginEvent[]
  total: number
  source: 'journald' | 'unavailable'
  truncated: boolean
}
const sshLogRows = ref<SshLoginEvent[]>([])
const sshLogTotal = ref(0)
const sshLogSource = ref<'journald' | 'unavailable'>('unavailable')
const sshLogTruncated = ref(false)
const sshLogErr = ref('')
const sshLogLoading = ref(false)
const sshLogQ = ref({ ip: '', user: '', result: '', risk: '' })

async function loadSshLogins() {
  sshLogLoading.value = true
  sshLogErr.value = ''
  try {
    const r = await api.get<SshLogResult>(API.security.sshLogins(sshLogQ.value))
    sshLogRows.value = Array.isArray(r?.rows) ? r.rows : []
    sshLogTotal.value = r?.total ?? 0
    sshLogSource.value = r?.source ?? 'unavailable'
    sshLogTruncated.value = !!r?.truncated
  }
  // 日志分区独立失败：不牵连基线 / 会话 / 端口三块的展示
  catch (e) { sshLogErr.value = errorText(e); sshLogRows.value = [] }
  finally { sshLogLoading.value = false }
}

function resetSshLogFilter() {
  sshLogQ.value = { ip: '', user: '', result: '', risk: '' }
  loadSshLogins()
}

// 从日志 IP 直接封禁：能力位 + 权限双门控；后端还会再复核并严格校验 IP。
// 这里先拦是为了把失败原因留在用户还能看到的地方，而不是一次注定失败的往返。
const canBanIp = computed(() => auth.can('firewall.manage') && auth.supported(CAP.FAIL2BAN))
const banBusy = ref('')
const banErr = ref('')

async function banFromLog(ip: string) {
  if (!canBanIp.value) return
  const target = ip.trim()
  const issue = banIpIssue(target)
  if (issue) {
    banErr.value = `无法封禁 ${target}：${issue}`
    toast(banErr.value, 'warn')
    return
  }
  banErr.value = ''
  banBusy.value = target
  try {
    const r = await api.post<{ jail: string; ip: string; already_banned: boolean }>(
      API.firewall.fail2banBan(), { ip: target })
    toast(r?.already_banned
      ? `${target} 已在封禁列表，未重复下发`
      : `已封禁 ${target}（jail: ${r?.jail ?? '—'}）`,
      r?.already_banned ? 'info' : 'ok')
  } catch (e) {
    banErr.value = `封禁 ${target} 失败：${errorText(e)}`
    toast(banErr.value, 'err')
  } finally {
    banBusy.value = ''
  }
}

async function load() {
  await run(async () => {
    // ⚠ 不得 `.catch(() => null)`：基线接口一旦失败，run 无法感知、error 永不设置，
    // baseline.value 仍是 [] ⇒ 汇总算出 risks=0 直接显示「无风险项」——把故障渲染成
    // 合规（二轮审计 P0-10）。交给 useAsync 捕获：失败会如实显示错误态 + 重试，
    // 而不是用「无风险」掩盖。
    const b = await api.get<BaselineItem[]>(API.security.baseline())
    baseline.value = Array.isArray(b) ? b : []
    const s = await api.get<{ sessions: SessionInfo[] }>(API.security.sessions())
    sessions.value = s?.sessions ?? []
    loadFailed.value = false
  }, (e) => { loadFailed.value = true; error.value = errorText(e) })
  // 端口现状与 SSH 日志各自独立加载：前者读 sshd 配置、后者读 journald，
  // 任一失败都只标自己那一块，不牵连基线 / 会话。
  await loadSshPort()
  await loadSshLogins()
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
  // 失败也关框：否则确认框继续盖着、错误在遮罩后，用户只看到「点了没反应」
  catch (e) { revokeTarget.value = null; toast(`吊销会话失败：${errorText(e)}`, 'err') }
}


function blClass(c: BaselineItem) { return baselineStatus(c) }
function blText(c: BaselineItem) { return baselineAdvice(c) }
function blStatusText(c: BaselineItem) { return BASELINE_STATUS_LABEL[baselineStatus(c)] }
function blBadge(c: BaselineItem) {
  const s = baselineStatus(c)
  return s === 'ok' ? 'badge-ok' : s === 'danger' ? 'badge-danger' : ''
}

// ─────────────── 状态筛选 ───────────────
// 三种状态都必须能单独查看：汇总卡与清单共用同一套 baselineStatus 判据，
// 不再出现「卡上有数字但点不进去、清单里也筛不出来」。
type BlFilter = 'all' | 'ok' | 'danger' | 'na'
const blFilter = ref<BlFilter>('all')
const blCardFilters: BlFilter[] = ['ok', 'danger', 'na']
const blTabs = computed(() => [
  { key: 'all' as const, label: '全部', count: baseline.value.length },
  { key: 'ok' as const, label: BASELINE_STATUS_LABEL.ok, count: passed.value },
  { key: 'danger' as const, label: BASELINE_STATUS_LABEL.danger, count: risks.value },
  { key: 'na' as const, label: BASELINE_STATUS_LABEL.na, count: naCount.value },
])
const visibleBaseline = computed(() => baseline.value.filter(
  c => blFilter.value === 'all' || baselineStatus(c) === blFilter.value,
))
const blEmptyText = computed(() => blFilter.value === 'all'
  ? '安全基线模块尚未接入'
  : `没有「${BASELINE_STATUS_LABEL[blFilter.value]}」状态的检查项`)

// ─────────────── 基线一键修复 ───────────────
// 白名单与文案判定统一下沉到 composable，避免前端两处手写清单各自漂移。
const acting = ref(false)

function canFix(c: BaselineItem): boolean { return canFixBaseline(c) }

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
  } catch (e) { pendingFix.value = null; toast(`修复失败：${errorText(e)}`, 'err') }
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
const { close: closeMfa } = useModal(() => disableMfa.value, mfaBox, () => { disableMfa.value = false; mfaDisableError.value = '' })
const mfaDisableCode = ref('')
/** MFA 关闭弹窗内的错误位：页面级 error 会被 .mask 挡住 */
const mfaDisableError = ref('')

async function doDisable() {
  const code = mfaDisableCode.value.trim()
  if (!code) return
  error.value = ''
  mfaDisableError.value = ''
  acting.value = true
  try {
    await api.post(API.auth.mfaDisable(), { code })
    mfaEnabled.value = false
    if (auth.me) auth.me.mfa_enabled = false
    toast('MFA 已关闭。')
    disableMfa.value = false
    mfaDisableCode.value = ''
  } catch (e) { mfaDisableError.value = errorText(e) }
  finally { acting.value = false }
}
</script>

<template>
  <div>
    <p v-if="error" class="err">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
    <div v-if="loading" class="skeleton box" />
    <template v-else-if="!loadFailed">
      <!-- ① 汇总卡：三张卡都可点击直达对应状态的清单（状态项不再「有数字却看不到」） -->
      <div class="grid cols-3 summary">
        <div v-for="(c, i) in summaryCards" :key="c.label" class="stat-click"
             role="button" tabindex="0" :title="`点击只看「${c.label}」`"
             @click="blFilter = blCardFilters[i]" @keydown.enter="blFilter = blCardFilters[i]">
          <MetricCard v-bind="c" />
        </div>
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
        <!-- 状态筛选：通过 / 风险 / 不适用各自可单独查看，计数与汇总卡同源 -->
        <div class="bl-tabs" role="tablist" aria-label="按状态筛选安全基线">
          <button v-for="t in blTabs" :key="t.key" type="button" class="bl-tab"
                  :class="{ active: blFilter === t.key }" :aria-selected="blFilter === t.key"
                  @click="blFilter = t.key">
            {{ t.label }}<span class="tab-count">{{ t.count }}</span>
          </button>
        </div>
        <ul class="checks">
          <li v-for="c in visibleBaseline" :key="c.key" class="bl-item" :title="c.advice">
            <div class="bl-info">
              <div class="bl-title-row">
                <span class="dot" :class="blClass(c)" />
                <span class="c-name">{{ c.title }}</span>
                <span class="badge" :class="blBadge(c)">{{ blStatusText(c) }}</span>
              </div>
              <p class="bl-desc muted">说明：{{ blText(c) }}</p>
              <p v-if="c.applicable" class="bl-values mono">
                当前 <b>{{ c.current || '—' }}</b><span class="arr">→</span>期望 <b>{{ c.expected || '—' }}</b>
              </p>
            </div>
            <div class="bl-op">
              <button v-if="canFix(c)" class="btn-ghost btn-sm" :disabled="acting"
                      title="先备份 → 写 → sshd -t 校验 → 不通过自动回滚"
                      @click="askFix(c)">修复</button>
              <span v-else class="muted small">{{ baselineOpNote(c) }}</span>
            </div>
          </li>
          <li v-if="!visibleBaseline.length" class="bl-empty">
            <span class="dot" :class="blFilter" /> {{ blEmptyText }}
          </li>
        </ul>
      </section>

      <!-- ③ SSH 端口：当前端口 / 修改入口 / 风险提示 / 关键操作分区呈现 -->
      <section class="card port-card">
        <div class="sec-head">
          <Icon name="terminal" :size="16" /><span>SSH 端口</span>
          <span class="spacer" />
          <RefreshBtn :disabled="loading" sm @click="loadSshPort" />
        </div>
        <p v-if="sshPortErr" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ sshPortErr }}</span>
        </p>
        <template v-else-if="sshPort">
          <div class="port-hero">
            <div class="port-now">
              <span class="port-cap">当前生效端口</span>
              <strong class="port-num">{{ sshPort.effective }}</strong>
              <span class="port-from muted small">{{ portSummary(sshPort) }}</span>
            </div>
            <div class="port-entry">
              <button v-if="sshPort.sshd_present" class="btn-primary" :disabled="acting" @click="askEditPort">修改端口</button>
              <span v-else class="muted small">未检测到 sshd，无需修改端口</span>
              <span class="muted small">需确认词「{{ SSH_PORT_CONFIRM_WORD }}」；先检查占用 → 备份 → sshd -t，失败自动回滚</span>
            </div>
          </div>
          <p class="warn-tip port-risk">
            <Icon name="alert" :size="15" class="ic" /><span>{{ riskNotice() }}</span>
          </p>
        </template>
        <p v-else class="muted">未读取到 SSH 配置</p>
      </section>

      <!-- ③-b SSH 登录 / 爆破记录：来源 IP、时间、用户、结果、风险类型 + 查询筛选 -->
      <section class="card ssh-log-card">
        <div class="sec-head">
          <Icon name="terminal" :size="16" /><span>SSH 登录记录</span>
          <span class="spacer" />
          <span class="muted small">来源 {{ sshLogSource === 'journald' ? 'journald' : '不可用' }}</span>
          <RefreshBtn :disabled="sshLogLoading" sm @click="loadSshLogins" />
        </div>
        <div class="log-filter">
          <input v-model="sshLogQ.ip" class="filter log-inp" placeholder="来源 IP" @keyup.enter="loadSshLogins" />
          <input v-model="sshLogQ.user" class="filter log-inp" placeholder="用户名" @keyup.enter="loadSshLogins" />
          <select v-model="sshLogQ.result" class="filter log-sel" @change="loadSshLogins">
            <option value="">全部结果</option><option value="success">成功</option><option value="failed">失败</option>
          </select>
          <select v-model="sshLogQ.risk" class="filter log-sel" @change="loadSshLogins">
            <option value="">全部风险</option>
            <option value="brute_force">疑似爆破</option>
            <option value="root_login">root 登录成功</option>
            <option value="root_attempt">尝试 root 登录</option>
            <option value="invalid_user">无效用户</option>
            <option value="failed_password">密码错误</option>
            <option value="none">无</option>
          </select>
          <button class="btn-ghost btn-sm" :disabled="sshLogLoading" @click="loadSshLogins">查询</button>
          <button class="btn-ghost btn-sm" :disabled="sshLogLoading" @click="resetSshLogFilter">重置</button>
        </div>
        <p v-if="sshLogErr" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ sshLogErr }}</span>
        </p>
        <p v-if="banErr" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ banErr }}</span>
        </p>
        <div v-else-if="sshLogRows.length" class="t-scroll">
          <table class="fixed" v-table-nav>
            <colgroup>
              <col class="w-ltime" /><col class="w-lip" /><col class="w-luser" />
              <col class="w-lres" /><col class="w-lrisk" /><col class="w-ldetail" />
              <col class="w-lact" />
            </colgroup>
            <thead><tr>
              <th>时间</th><th>来源 IP</th><th>用户</th><th>结果</th><th>风险类型</th><th>详情</th><th>操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="(e, i) in sshLogRows" :key="`${e.ts_unix}-${e.ip}-${i}`">
                <td class="muted nowrap">{{ sshLogTime(e.ts_unix, fmtDateTime) }}</td>
                <td class="mono">{{ e.ip }}</td>
                <td>{{ e.user }}</td>
                <td>
                  <span class="badge" :class="e.result === 'success' ? 'badge-ok' : 'badge-danger'">
                    {{ sshResultLabel(e.result) }}
                  </span>
                </td>
                <td><span class="badge" :class="sshRiskBadge(e.risk)">{{ sshRiskLabel(e.risk) }}</span></td>
                <td class="muted" :title="e.detail">{{ e.detail.length > 80 ? `${e.detail.slice(0, 80)}…` : e.detail }}</td>
                <td class="col-actions">
                  <button v-if="canBanIp" class="btn-ghost btn-sm" type="button"
                    :title="BAN_IP_HINT" :disabled="banBusy === e.ip"
                    @click="banFromLog(e.ip)">
                    {{ banBusy === e.ip ? '封禁中…' : '封禁' }}
                  </button>
                  <span v-else class="muted tiny" :title="BAN_IP_HINT">不可管理</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">暂无 SSH 登录记录{{ sshLogSource === 'unavailable' ? '（日志源不可用）' : '' }}</p>
        <p class="muted small log-total">
          共 {{ sshLogTotal }} 条{{ sshLogTruncated ? '（已达读取上限，仅展示最近 2000 条）' : '' }}
        </p>
      </section>

      <!-- ④ 账号：账号安全分区（活跃会话 + 两步验证 MFA） -->
      <div class="part">
        <div class="part-head">
          <Icon name="users" :size="15" /><span>账号安全</span>
        </div>
        <div class="grid cols-2">
          <section class="card">
            <div class="sec-head"><Icon name="users" :size="16" /><span>活跃会话</span></div>
            <div class="t-scroll" v-if="total">
            <table class="fixed" v-table-nav>
              <!-- 列宽（站点表范式）：用户为唯一弹性列；吊销按钮列定宽 100px。 -->
              <colgroup>
                <col class="w-suser" /><col class="w-srole" /><col class="w-sctime" /><col class="w-sidle" /><col class="w-sacts" />
              </colgroup>
              <thead><tr>
                <SortTh label="用户" :active="isSorted('user')" :dir="sortDir" @sort="toggleSort('user')" />
                <SortTh label="角色" :active="isSorted('role')" :dir="sortDir" @sort="toggleSort('role')" />
                <SortTh label="创建于" :active="isSorted('created_at')" :dir="sortDir" @sort="toggleSort('created_at')" />
                <SortTh label="空闲" :active="isSorted('idle_secs')" :dir="sortDir" @sort="toggleSort('idle_secs')" />
                <th />
              </tr></thead>
              <tbody>
                <tr v-for="s in pageRows" :key="s.id">
                  <td>
                    {{ s.user }}
                    <span v-if="s.current" class="cur-badge">当前</span>
                  </td>
                  <td class="muted">{{ roleLabel(s.role) }}</td>
                  <td class="muted" :title="fmtDateTime(s.created_at)">{{ fmtAgo(s.created_at) }}</td>
                  <td class="muted mono">{{ s.idle_secs < 60 ? `${s.idle_secs}s` : `${Math.floor(s.idle_secs / 60)}m` }}</td>
                  <td class="nowrap">
                    <button class="btn-ghost btn-sm danger" @click="askRevoke(s)"><Icon name="logout" :size="14" /> 吊销</button>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
              @update:page="gotoPage" @update:size="changeSize" />
            <p v-if="!total" class="muted">暂无活跃会话信息</p>
          </section>

          <section class="card">
            <div class="sec-head"><Icon name="shield" :size="16" /><span>两步验证（MFA）</span></div>

            <p class="muted">当前状态：<b :class="mfaEnabled ? 's-ok' : 's-risk'">{{ mfaEnabled ? '已启用' : '未启用' }}</b></p>

            <div v-if="!mfaEnabled && !mfaEnrolling" class="ops-row">
              <button class="btn-primary" :disabled="acting" @click="doEnroll">启用 MFA</button>
              <span class="muted small">登录时除密码外，还需验证器生成的 6 位动态口令</span>
            </div>

            <div v-else-if="mfaEnrolling" class="mfa-box">
              <div class="mfa-enroll">
                <!-- 扫码卡片带品牌头：验证器 App 内的条目标徽由 App 自己按 issuer
                     首字母生成（Microsoft Authenticator 取 "Fo"），协议层无法替换成
                     面板 logo，所以品牌露出放在面板侧这张卡片上。 -->
                <div class="qr-tile">
                  <div class="qr-tile-head">
                    <span class="qr-tile-logo"><Icon name="dog" :size="18" /></span>
                    <span class="qr-tile-name">ForkPanel</span>
                  </div>
                  <QrCode :text="mfaEnrolling.otpauth_uri" :size="168" />
                </div>
                <div class="mfa-enroll-side">
                  <p class="muted">用验证器 App 扫左边的二维码；扫不了就在 App 里手动录入密钥：</p>
                  <p class="mono secret">{{ mfaEnrolling.secret }}</p>
                  <details>
                    <summary class="muted small">otpauth 地址（手动导入用）</summary>
                    <p class="mono small break">{{ mfaEnrolling.otpauth_uri }}</p>
                  </details>
                </div>
              </div>
              <p class="warn-tip">
                以下恢复码<b>只显示这一次</b>，请立即保存。手机丢失时，它们是唯一的登录途径。
              </p>
              <ul class="codes">
                <li v-for="c in mfaEnrolling.recovery_codes" :key="c" class="mono">{{ c }}</li>
              </ul>
              <div class="ops-row">
                <input v-model="mfaCode" class="inp" placeholder="6 位动态口令" maxlength="6" />
                <button
                  class="btn-primary"
                  :disabled="acting || mfaCode.trim().length !== 6"
                  @click="doVerify"
                >验证并启用</button>
              </div>
            </div>

            <div v-else class="ops-row">
              <button class="btn-ghost btn-sm danger" :disabled="acting" @click="mfaDisableError = ''; disableMfa = true">关闭 MFA</button>
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
    <Teleport to="body">
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
          关闭时需验证第二因子，防止会话被劫持后账户被关闭。
        </p>
        <p v-if="mfaDisableError" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ mfaDisableError }}</span>
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
    </Teleport>
    <!-- 修改 SSH 端口：高危写，需确认词 -->
    <Teleport to="body">
    <div v-if="editingPort" class="mask" @click.self="closePort">
      <div ref="portBox" class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">修改 SSH 端口</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closePort">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p class="modal-lead">{{ riskNotice() }}</p>
        <!-- 仅服务端 / 归属不到输入框的错误走整段条；字段校验见各输入框下方。 -->
        <p v-if="portDialogErr" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ portDialogErr }}</span>
        </p>
        <label class="blk" :class="{ 'has-err': !!portInvalid }">新端口（1-65535）
          <input v-model="portInput" inputmode="numeric" autocomplete="off" />
          <span v-if="portInvalid" class="field-err" role="alert">{{ portInvalid }}</span>
        </label>
        <label class="chk-row">
          <input v-model="keepOld" type="checkbox" />
          <span>过渡期同时保留旧端口 {{ sshPort?.effective }}（推荐：新端口连不上时可从这里回退）</span>
        </label>
        <label class="blk" :class="{ 'has-err': !!confirmErr }">输入「{{ SSH_PORT_CONFIRM_WORD }}」以确认
          <input v-model="portConfirm" autocomplete="off" @keyup.enter="submitPort" />
          <span v-if="confirmErr" class="field-err" role="alert">{{ confirmErr }}</span>
        </label>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closePort">取消</button>
            <button class="btn-danger" :disabled="acting || !portSubmittable" @click="submitPort">
              {{ acting ? '提交中…' : '确认修改' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.box { height: 220px; border-radius: var(--radius); }
/* 汇总卡与分区之间留足竖向间距（原 grid.cols-2 整页混排 → 三块分区清晰分层） */
.summary { margin-bottom: 16px; }
.part { margin-top: 16px; }
.part-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-size: var(--fs-15); font-weight: 600; color: var(--c-text); }
/* 汇总卡可点：状态筛选直达清单。wrapper 而非给子组件根挂 class——
   Vue3.5 scoped 不给子组件根补父级 data-v，直接写 class 样式恒不命中。 */
.stat-click { cursor: pointer; min-width: 0; }
.stat-click:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; border-radius: var(--radius); }
.stat-click :deep(.card) { height: 100%; }
.stat-click:hover :deep(.card) { border-color: var(--c-primary); }
.bl-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 6px; }
.bl-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px;
  border-radius: 999px; border: 1px solid var(--c-border); background: transparent;
  color: var(--c-text-mute); font-size: var(--fs-12-5); cursor: pointer; }
.bl-tab:hover { border-color: var(--c-primary); color: var(--c-text); }
.bl-tab.active { background: var(--c-primary-soft); border-color: var(--c-primary);
  color: var(--c-primary); font-weight: 600; }
.tab-count { font-variant-numeric: tabular-nums; opacity: .8; }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.checks li { font-size: var(--fs-13-5); }
.checks li.bl-item { display: flex; align-items: flex-start; gap: 12px;
  padding: 9px 0; border-bottom: 1px solid var(--c-border); }
.checks li.bl-item:last-child { border-bottom: none; }
.bl-info { min-width: 0; flex: 1; }
.bl-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bl-desc { margin: 5px 0 0; font-size: var(--fs-12-5); line-height: 1.5; }
.bl-values { margin: 3px 0 0; font-size: var(--fs-12); color: var(--c-text-mute); }
.bl-values b { color: var(--c-text); font-weight: 600; }
.arr { margin: 0 5px; color: var(--c-text-dim); }
.bl-op { flex: none; min-width: 100px; display: flex; justify-content: flex-end; align-items: flex-start; }
.badge.na { background: color-mix(in srgb, var(--c-text-dim) 14%, transparent); color: var(--c-text-dim); }
.bl-empty { display: flex; align-items: center; gap: 8px; padding: 14px 0; color: var(--c-text-mute); }
.c-name { font-weight: 500; }
.summary { font-size: var(--fs-12-5); }
/* 语义色一律只用 token，不给 var() 写第二参数兜底：这些 token 在 main.css 里
   全都已定义，兜底永远不生效，只是把一屏之外的旧色值抄进本文件——
   亮色主题切换时它们不会跟着变，还会被「硬编码色值」棘轮误计。 */
.s-ok { color: var(--c-ok); }
.s-risk { color: var(--c-danger); }
.dot.na { background: var(--c-text-dim); opacity: .55; }
.cur-badge { margin-left: 6px; font-size: var(--fs-12); padding: 1px 7px; border-radius: 999px; background: var(--c-ok-soft); color: var(--c-ok); }
.muted { color: var(--c-text-mute); }
.mono { font-family: var(--mono); }
.nowrap { white-space: nowrap; }
.ops-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.small { font-size: var(--fs-12); }
.mfa-box { margin-top: 8px; }
/* 二维码与「密钥/URI 备选路径」并排；容器太窄时（手机）自动折成上下，
   不用 fixed 宽度，避免 320px 下把密钥挤出可视区 */
.mfa-enroll { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin: 4px 0 12px; }
.mfa-enroll-side { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
/* 扫码卡片：底色取二维码静区同款 --qr-bg（两主题同值恒白），文字只能配
   --qr-fg——正文色在亮色主题下是深灰、在这张白卡上会与暗色主题的白字互相打架。 */
.qr-tile {
  flex: none; padding: 7px 7px 4px; border-radius: var(--radius-md);
  display: flex; flex-direction: column; gap: 4px;
  background: var(--qr-bg); border: 1px solid var(--c-border);
}
.qr-tile-head { display: flex; align-items: center; gap: 7px; }
.qr-tile-logo {
  width: 24px; height: 24px; border-radius: var(--radius-chip); flex: none;
  display: grid; place-items: center; color: var(--c-on-accent);
  background: var(--gradient);
}
.qr-tile-name { font-size: var(--fs-13); font-weight: 700; color: var(--qr-fg); letter-spacing: .2px; }
.mfa-enroll-side p { margin: 0; }
.secret { font-size: var(--fs-13); padding: 6px 8px; border-radius: var(--radius); user-select: all;
  background: color-mix(in srgb, var(--c-text-dim) 12%, transparent); }
.codes { list-style: none; margin: 8px 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; font-size: var(--fs-12-5); }
.warn-tip { margin: 8px 0 4px; font-size: var(--fs-12-5); color: var(--c-warn); }
.inp { padding: 4px 8px; border: 1px solid var(--c-border); border-radius: var(--radius); background: transparent; color: inherit; font-family: var(--mono); }
.break { word-break: break-all; }
/* 关闭 MFA 输入弹窗（与其他视图同形态）：遮罩 / 弹窗框 / 标题行 / 关闭按钮 /
   字段 / 操作条一律取 main.css 的公共式样（.muted 也是公共工具类，不再私抄） */
/* 会话表列宽（站点表范式）：用户为唯一弹性列；吊销按钮列 100px。 */
col.w-suser { width: auto; }
col.w-srole { width: 100px; }
col.w-sctime { width: 110px; }
col.w-sidle { width: 80px; }
col.w-sacts { width: 100px; }
/* SSH 端口：大数字突出当前生效端口；修改入口与关键操作成列；风险提示独立一行。 */
.port-hero { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.port-now { display: flex; flex-direction: column; gap: 3px; min-width: 190px; }
.port-cap { font-size: var(--fs-12); color: var(--c-text-dim); }
.port-num { font-size: var(--fs-26); line-height: 1; font-variant-numeric: tabular-nums; color: var(--c-text); }
.port-from { line-height: 1.5; word-break: break-word; }
.port-entry { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-left: auto; }
.port-risk { display: flex; align-items: flex-start; gap: 7px; margin: 12px 0 0; }
.port-risk .ic { flex: none; margin-top: 2px; }
/* SSH 登录记录：筛选条复用全站 .filter，只覆盖宽度；表格详情列吃剩余宽度。 */
.log-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.log-inp { width: 150px; }
.log-sel { width: 140px; flex: none; }
.log-total { margin: 8px 0 0; }
col.w-ltime { width: 150px; }
col.w-lip { width: 130px; }
col.w-luser { width: 110px; }
col.w-lres { width: 84px; }
col.w-lrisk { width: 132px; }
col.w-ldetail { width: auto; }
col.w-lact { width: 92px; }
</style>

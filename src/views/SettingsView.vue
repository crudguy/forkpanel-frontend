<script setup lang="ts">
/**
 * 设置页 = 系统与功能模块的配置与开关中心（2026-10-30 重构定位）。
 *
 * 只保留「可编辑 / 可执行」的内容，纯只读系统信息展示全部移除：
 * - AI 助手 LLM 接入：四键（endpoint / model / api_key / narrative 独立开关），
 *   可改即生效；api_key 经主密钥加密，后端永不明文回传。narrative 缺省关——
 *   关时后端不外发任何诊断数据（diagnose 回退纯规则报告），与未配置同路
 * - 角色与权限（RBAC）：创建/删除自定义角色；「我的权限」徽章并入本卡作参照
 *   （创建角色的规则 = 权限必须是自身权限的子集，徽章就是那个"自身权限"）
 * - 面板维护：重启 / 检查更新 / 执行升级 / 核准公网 IP（owner 门控）+ localhost_only 可达性引导
 * - 能力矩阵（#caps）：功能模块开关状态总览（只读），「设置 → 能力矩阵」页签入口
 *
 * 已移除的只读展示（勿复活，守卫 SettingsView.refocus.test.ts 钉住）：
 * 运行环境卡（平台/发行版/内核/档位/用户——topbar 徽标 tooltip 已有）、
 * 部署配置键值表、面板与安装键值表（安装落点在「系统 → 目录」页）、
 * 预留项（未接线）卡、独立权限徽章卡。
 * deployment / reserved 字段仍由 /settings API 下发（后端契约不动），前端只是不再渲染。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TabBar from '@/components/TabBar.vue'
import { useAuthStore } from '@/stores/auth'
import type { SettingsReport, LlmTestResult, UpgradeCheck } from '@/api/types'
import Icon from '@/components/Icon.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { toast, toastError } from '@/composables/useToast'
import { useAsync } from '@/composables/useAsync'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import { fetchAppVersion, waitForRecovery } from '@/composables/serviceResume'
import { llmTestBlockReason } from '@/utils/llmTestGate'
import EmptyState from '@/components/EmptyState.vue'
import PermMatrix from '@/components/PermMatrix.vue'
import { loadRoleCatalog, missingFromGranted, type RoleRow } from '@/composables/roleCatalog'

const auth = useAuthStore()
const route = useRoute()
const canManage = computed(() => auth.can('settings.manage'))
const clearKeyOpen = ref(false)
const restartOpen = ref(false)
const restarting = ref(false)
// 检查更新：后端只读探测 GitHub Releases；网络失败由 data.error 带回，不抛 5xx
const upgrade = ref<UpgradeCheck | null>(null)
const checkingUpgrade = ref(false)
const upgradeErr = ref('')
const upgradeOpen = ref(false)
const upgrading = ref(false)
const canCheckUpdate = computed(() => auth.can('system.manage'))

// ── 公网出口 IP（核准） ──
// 值来自 config.toml [info]（init 探测一次写入）；「核准 IP」重新探测并写回。
// owner 专属（写 config.toml，与重启同档）；admin 看得到值但看不到按钮。
const pubIp = ref<string | null>(null)
const pubIpBusy = ref(false)
const pubIpErr = ref('')
const canApproveIp = computed(() => auth.can('system.manage') && auth.me?.role === 'owner')

async function approvePublicIp() {
  if (pubIpBusy.value) return
  pubIpBusy.value = true
  pubIpErr.value = ''
  try {
    const r = await api.post<{ public_ip: string }>(API.system.publicIp(), {})
    pubIp.value = r.public_ip
    toast(`已核准公网 IP：${r.public_ip}`)
  } catch (e) {
    pubIpErr.value = errorText(e)
  } finally {
    pubIpBusy.value = false
  }
}

// 页签：按权限过滤后展示，默认落在「AI 接入」（本页重点配置）。
// 用 v-show 而非 v-if 承载内容：切换只改可见性，表单输入、测试连接结果、
// 表格分页/排序等状态原地保留（组件卸载会丢 DOM 焦点与滚动位置）。
type SettingsTab = 'llm' | 'maint' | 'roles' | 'caps'
const activeTab = ref<SettingsTab>(route.hash === '#caps' ? 'caps' : 'llm')
function setTab(v: string) { activeTab.value = v as SettingsTab }

// 深链定位（手动访问 /settings#caps）：
// 本页有 v-if="report" 的异步分区，路由 scrollBehavior 触发时它们尚未渲染，
// 内容补上后锚点会被顶偏，故在数据就绪后再定位一次。
// 能力矩阵现在位于独立页签：必须先切签再滚，否则锚点处于 display:none 滚不动。
function scrollToHash() {
  const id = route.hash ? route.hash.slice(1) : ''
  if (!id) return
  if (id === 'caps') activeTab.value = 'caps'
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
watch(() => route.hash, scrollToHash)

const caps = computed(() => Object.entries(auth.capabilities))
const supportedCount = computed(() => caps.value.filter(([, c]) => c.supported).length)

// ── 面板设置（三段）──
const report = ref<SettingsReport | null>(null)
const saving = ref(false)
const formError = ref('')

/** 安装与运行位置；旧后端缺该字段时按 null 处理，不伪造默认值。
 *  仍被维护操作消费：can_restart / can_upgrade / 升级确认框与 waitForUpgrade 的基准版本。 */
const installation = computed(() => report.value?.deployment.installation ?? null)

// ── 首屏面板设置加载：useAsync 收敛 loading/error 状态机 ──
// formError 被 save/clearKey/testConn 共享，故 onError 写回 formError（不改名）；
// 用 useAsync(false)：load 有 canManage 早退，权限不足时不应卡在「加载中…」。
const { loading, run } = useAsync(false)
const onError = (e: unknown) => { formError.value = errorText(e) }
const llmEndpoint = ref('')
const llmModel = ref('')
const llmKey = ref('')            // 留空 = 保持不变；输入 = 覆盖
// P0-2：叙事层独立开关。缺省关（后端 narrative_on 同款语义）——外发第三方端点
// 必须显式同意，不搞「配齐三键就自动外发」。关时后端 llm_config() 直接 None。
const llmNarrative = ref(false)
// chat 系统上下文开关。缺省关——自由对话默认不把任何系统数据带出本机；开启后
// 自由输入也能结合本机实况（脱敏）作答。仅当叙事开关已开时才有意义。
const llmChatContext = ref(false)
const showKey = ref(false)

// ── C10 测试连接：配模型时真实探测 /v1/chat/completions，否则 /v1/models ──
// F-02①：Endpoint 锁定已保存值（改动须先保存）；api_key 框留空时后端回退到
// 库里已存的密钥（Endpoint 已锁定，无外带风险），填了则优先用填的（先测后存），
// Model 一样可先测后存——避免"保存后才知道配置是否可用"。配模型时改打
// /chat/completions 是修复：部分服务商（如 Agnes）即便密钥有效也对 /v1/models
// 返回 401，却对 /chat/completions 正常，只探 /models 会误报 401。
// savedLlmEndpoint 是「后端已保存的 Endpoint」快照，比较基准不能取输入框自身。
const savedLlmEndpoint = ref('')
const testing = ref(false)
const testResult = ref<LlmTestResult | null>(null)
async function testConn() {
  if (testing.value) return
  // F-02①：后端会硬拒绝「临时改 Endpoint」，这里提前给出可操作的提示。
  const block = llmTestBlockReason(savedLlmEndpoint.value, llmEndpoint.value)
  if (block) {
    formError.value = block
    return
  }
  testing.value = true
  formError.value = ''
  testResult.value = null
  try {
    testResult.value = await api.post<LlmTestResult>(API.settings.llmTest(), {
      endpoint: llmEndpoint.value.trim() || undefined,
      model: llmModel.value.trim() || undefined,
      api_key: llmKey.value.trim() || undefined,
    })
  } catch (e) {
    // 400（未配置 / URL 非法）走这里；探测失败是 ok:false 而非异常
    formError.value = errorText(e)
  } finally {
    testing.value = false
  }
}

// ── 角色管理（RBAC 自定义角色）──
// 安全判断全在后端：防提权（权限必须是自身权限的子集）、内置角色名保留、
// 被用户引用的角色不可删。前端只把后端给的 known_permissions 渲染成勾选项，
// **绝不自己发明权限名**——前端多一个后端不认的名字，只会得到一次 400。
// RoleRow 类型唯一源在 composables/roleCatalog.ts（用户弹窗与本页共用）。
const roles = ref<RoleRow[]>([])
const rolesLoaded = ref(false)
const knownPerms = ref<string[]>([])
const roleName = ref('')
const rolePerms = ref<string[]>([])
const roleBusy = ref(false)
const roleErr = ref('')
const canRoles = computed(() => auth.can('user.manage'))

/** 权限明细展开：点角色行 / 行内「权限」按钮切换。默认收起，避免 28 项铺满表格。 */
const expandedRole = ref<string | null>(null)

/**
 * 正在编辑权限的自定义角色名（null = 未在编辑）。
 * 前端原先只有「建」和「删」——权限一旦建错就只能删了重建，而删又会因
 * 「仍被用户引用」被拒，实际等于**改不了**。后端 PATCH /roles/{name} 一直是通的。
 */
const editRole = ref<string | null>(null)
const editPerms = ref<string[]>([])
/** 编辑态的刷新基准：用于判断「没改就点保存」并给出准确反馈（而不是一律报成功）。 */
const editBaseline = ref<string[]>([])
const editErr = ref('')

/** 该角色里当前登录者没有的权限（非空 ⇒ 后端 check_permissions 会 400）。 */
function missingFor(perms: string[]): string[] {
  return missingFromGranted(perms, auth.me?.permissions ?? [])
}

// 可见页签随权限收敛；当前签若因权限变化消失，退回第一个可见签（能力矩阵恒在）。
const visibleTabs = computed(() => {
  const ts: { value: SettingsTab; label: string; icon: string }[] = []
  if (canManage.value) {
    ts.push({ value: 'llm', label: 'AI 接入', icon: 'sparkles' })
    ts.push({ value: 'maint', label: '面板维护', icon: 'gear' })
  }
  if (canRoles.value) ts.push({ value: 'roles', label: '角色权限', icon: 'users' })
  ts.push({ value: 'caps', label: '能力矩阵', icon: 'shield' })
  return ts
})
// immediate 必需：权限不足的用户可见签只有「能力矩阵」，而 activeTab 初值是 'llm'
// ——不立即跑一次的话四个 section 全被 v-show 隐藏，整页空白（首屏只渲染一次，
// 之后也没有任何东西会触发这个 watch）。
watch(visibleTabs, (ts) => {
  if (!ts.some((t) => t.value === activeTab.value)) activeTab.value = ts[0]?.value ?? 'caps'
}, { immediate: true })

// 全站表格约定：角色表是记录列表（自定义角色会随使用增长），接客户端分页 + 表头排序。
// 默认按角色名升序（主标识列）；权限数按条数降序（先看权限多的），来源按显示文本升序。
const roleSortCols: SortColumn<RoleRow>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'permissions', dir: 'desc', compare: (a, b) => (a.permissions?.length ?? 0) - (b.permissions?.length ?? 0) },
  { key: 'builtin', dir: 'asc', compare: (a, b) => (a.builtin ? '内置' : '自定义').localeCompare(b.builtin ? '内置' : '自定义') },
]
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<RoleRow>({
    rows: roles, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' },
    columns: roleSortCols, persistKey: 'settings.roles',
  })

async function loadRoles() {
  if (!canRoles.value) return
  try {
    // 与新建用户弹窗共用同一个加载器：两处各写一份解析，就会出现「这里能看到
    // 自定义角色、那里看不到」的漂移（正是本次的根因形态）。
    const cat = await loadRoleCatalog()
    roles.value = cat.roles
    knownPerms.value = cat.knownPermissions
  } catch (e) { roleErr.value = errorText(e) }
  finally { rolesLoaded.value = true }
}

async function createRole() {
  if (!roleName.value.trim() || !rolePerms.value.length) {
    roleErr.value = '需要角色名与至少一项权限'
    return
  }
  roleBusy.value = true; roleErr.value = ''
  try {
    await api.post(API.roles.create(), { name: roleName.value.trim(), permissions: rolePerms.value })
    roleName.value = ''; rolePerms.value = []
    await loadRoles()
  } catch (e) { roleErr.value = errorText(e) }
  finally { roleBusy.value = false }
}

/** 进入权限编辑：以当前落库权限为基准，取消时直接丢弃草稿。 */
function startEditPermissions(r: RoleRow) {
  editErr.value = ''
  editRole.value = r.name
  editPerms.value = [...r.permissions]
  editBaseline.value = [...r.permissions].sort()
}
function cancelEditPermissions() {
  editRole.value = null
  editPerms.value = []
  editBaseline.value = []
  editErr.value = ''
}

/**
 * 保存角色权限（PATCH /roles/{name}）。
 *
 * 为什么必须给「编辑」而不是只给「删除重建」：后端删角色时会拒绝「仍被用户引用」
 * 的角色，所以权限写错的自定义角色**实际改不动**——只能先把人都挪走再删再建。
 */
async function saveEditPermissions() {
  const name = editRole.value
  if (!name) return
  if (!editPerms.value.length) { editErr.value = '至少要保留一项权限'; return }
  const missing = missingFor(editPerms.value)
  if (missing.length) {
    editErr.value = `不能授予自己不具备的权限：${missing.join('、')}`
    return
  }
  const same = [...editPerms.value].sort().join(',') === editBaseline.value.join(',')
  if (same) { cancelEditPermissions(); toast('权限未改动'); return }
  roleBusy.value = true; editErr.value = ''
  try {
    await api.patch(API.roles.item(name), { permissions: editPerms.value })
    cancelEditPermissions()
    await loadRoles()
    toast(`角色 ${name} 的权限已更新`)
  } catch (e) { editErr.value = errorText(e) }
  finally { roleBusy.value = false }
}

/** 待删除角色（审计 U5：window.confirm → ConfirmDialog） */
const delRole = ref<string | null>(null)
async function deleteRole(name: string) {
  roleErr.value = ''
  try {
    await api.del(API.roles.item(name))
    delRole.value = null
    await loadRoles()
  } catch (e) { roleErr.value = errorText(e) }
}

async function load() {
  if (!canManage.value) return
  formError.value = ''
  await run(async () => {
    report.value = await api.get<SettingsReport>(API.settings.get())
    llmEndpoint.value = report.value.runtime.endpoint ?? ''
    savedLlmEndpoint.value = report.value.runtime.endpoint ?? ''
    llmModel.value = report.value.runtime.model ?? ''
    llmNarrative.value = report.value.runtime.narrative ?? false
    llmChatContext.value = report.value.runtime.chat_context ?? false
  }, onError)
}

async function save() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    // narrative 是布尔，其余三键是 string|null——类型如实反映后端白名单
    const patch: Record<string, string | boolean | null> = {
      'assistant.llm_endpoint': llmEndpoint.value.trim() || null,
      'assistant.llm_model': llmModel.value.trim() || null,
      'assistant.llm_narrative': llmNarrative.value,
      'assistant.llm_chat_context': llmChatContext.value,
    }
    if (llmKey.value.trim()) patch['assistant.llm_api_key'] = llmKey.value.trim()
    report.value = await api.patch<SettingsReport>(API.settings.patch(), { settings: patch })
    // 保存后基准要跟着更新，否则刚保存完点测试会被自己的前端误拦
    savedLlmEndpoint.value = report.value.runtime.endpoint ?? ''
    llmKey.value = ''
    toast('设置已保存并即时生效')
  } catch (e) {
    formError.value = errorText(e)
  } finally { saving.value = false }
}

async function clearKey() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    report.value = await api.patch<SettingsReport>(API.settings.patch(), {
      settings: { 'assistant.llm_api_key': null },
    })
    llmKey.value = ''
    toast('API 密钥已清除')
  } catch (e) {
    formError.value = errorText(e)
  } finally { saving.value = false }
}

/**
 * 重启后面板会短暂断连：请求本身失败是**预期**，不能据此报错。
 * 真正的判据是 `/api/v1/version` 重新可用——恢复后刷新页面即可拿到新进程。
 * 40 秒上限：Type=simple 单元通常 1~3 秒起来；超过说明没起来，必须让用户去查。
 */
async function waitForRestart() {
  await waitForRecovery({
    probe: fetchAppVersion,
    rule: { kind: 'any-response' },
    intervalMs: 1000,
    timeoutMs: 40_000,
    onTimeout: () => {
      restarting.value = false
      toast('面板 40 秒内未恢复：请用 SSH 执行 systemctl status panel 查看', 'err')
    },
  })
}

async function checkUpgrade() {
  if (checkingUpgrade.value) return
  checkingUpgrade.value = true
  upgradeErr.value = ''
  try {
    const r = await api.get<UpgradeCheck>(API.system.upgradeCheck())
    upgrade.value = r
    // 网络失败也是 200：不要把「检查失败」渲染成整块红色错误
    if (r.error) upgradeErr.value = r.error
  } catch (e) {
    upgradeErr.value = errorText(e)
  } finally {
    checkingUpgrade.value = false
  }
}

/** 升级期间服务会先退出再回来：等「见过断连」或「版本号变了」再刷新，避免旧进程
 *  刚一应答就 reload、页面看起来像没升级。3 分钟兜底。
 *  轮询骨架与判据在 `composables/serviceResume.ts`（顶栏同一份，别在这里改循环）。 */
async function waitForUpgrade(from: string) {
  await waitForRecovery({
    probe: fetchAppVersion,
    rule: { kind: 'version-changed', from },
    intervalMs: 2000,
    timeoutMs: 180_000,
    onTimeout: () => {
      upgrading.value = false
      toast('升级 3 分钟内未完成：请 SSH 执行 journalctl -u panel-upgrade -n 50 查看', 'err')
    },
  })
}

async function doUpgrade() {
  upgradeOpen.value = false
  if (upgrading.value) return
  upgrading.value = true
  try {
    await api.post(API.system.upgrade(), { version: upgrade.value?.latest ?? null })
    toast('升级已交给后台执行，页面会在服务恢复后刷新')
    await waitForUpgrade(installation.value?.app_version ?? '')
  } catch (e) {
    upgrading.value = false
    toastError(e)
  }
}

async function doRestart() {
  restartOpen.value = false
  if (restarting.value) return
  restarting.value = true
  try {
    await api.post(API.system.restart(), {})
  } catch {
    // 重启瞬间连接被切断是预期行为；是否真的起来由 /version 轮询判定
  }
  toast('重启已发起，页面会在服务恢复后自动刷新')
  await waitForRestart()
}

onMounted(async () => {
  await load()
  // 角色列表需要 user.manage；loadRoles 内部自判权限，非管理员直接跳过
  await loadRoles()
  // 公网 IP：只读展示（GET 失败静默显示「—」，不打红整页）
  api.get<{ public_ip: string | null }>(API.system.publicIp())
    .then((r) => { pubIp.value = r.public_ip })
    .catch(() => {})
  scrollToHash()
})
</script>

<template>
  <div>
    <div v-if="visibleTabs.length > 1" class="tabs-row">
      <TabBar :tabs="visibleTabs" :model-value="activeTab" @change="setTab" />
    </div>

    <!-- ── 面板设置（仅 settings.manage 可见）── -->
    <template v-if="canManage">
      <section v-show="activeTab === 'llm'" class="card">
        <div class="sec-head"><Icon name="sparkles" :size="16" /> AI 助手 · LLM 接入</div>
        <!-- 诚实文案（P0-2 改写）：叙事层**已接线**，但独立开关缺省关。
             改之前这里写的是"尚未接线"（那时后端确实没有消费点）；现在反过来了：
             配齐三键也**不会**自动外发，必须显式打开下面的开关。 -->
        <p class="sec-sub">
          AI 助手的诊断内核是内置规则引擎，开箱即用，不依赖此处配置。这里配置的是<strong>可选的 LLM 接入</strong>；
          叙事层已接线，但<strong>独立开关默认关闭</strong>——只有打开开关，诊断才会把（脱敏后的）数据发到上方配置的 Endpoint，否则一律回退纯规则报告。
        </p>
        <div v-if="loading" class="dim">加载中…</div>
        <template v-else-if="report">
          <div class="form">
            <label class="field">
              <span class="lbl">API Endpoint</span>
              <input v-model="llmEndpoint" class="inp" type="url" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="field">
              <span class="lbl">Model</span>
              <input v-model="llmModel" class="inp" type="text" placeholder="gpt-4o-mini / deepseek-chat …" />
            </label>
            <label class="field">
              <span class="lbl">API Key <span :class="report.runtime.api_key_set ? 'set-ok' : 'dim'">
                {{ report.runtime.api_key_set ? '已设置（加密存储，留空保持不变）' : '未设置' }}
              </span></span>
              <div class="key-row">
                <input v-model="llmKey" class="inp" :type="showKey ? 'text' : 'password'"
                  :placeholder="report.runtime.api_key_set ? '••••••••（留空保持不变）' : 'sk-…'" autocomplete="off" />
                <button class="btn-ghost" type="button" :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
                  <Icon :name="showKey ? 'lock' : 'key'" :size="14" />
                </button>
                <button v-if="report.runtime.api_key_set" class="btn-ghost danger" type="button" :disabled="saving" @click="clearKeyOpen = true">
                  清除
                </button>
              </div>
            </label>
            <div class="field">
              <label class="chk-inline"><input v-model="llmNarrative" type="checkbox" /> LLM 叙事层</label>
              <span class="dim">关闭（默认）时仅内置规则诊断，不外发任何数据</span>
            </div>
            <!-- 披露文案由后端 NARRATIVE_NOTE 单一维护、原样渲染——前端不改写，
                 杜绝「文档说已脱敏、代码没脱敏」的漂移。 -->
            <p v-if="report.runtime.narrative_note" class="sec-note">{{ report.runtime.narrative_note }}</p>
            <div class="field">
              <label class="chk-inline"><input v-model="llmChatContext" type="checkbox" /> 自由对话带上系统概要</label>
              <span class="dim">开启后，自由输入的问题也会结合本机实况（脱敏）作答；默认关</span>
            </div>
            <p v-if="report.runtime.chat_context_note" class="sec-note">{{ report.runtime.chat_context_note }}</p>
          </div>
          <p class="sec-note">密钥经主密钥 AES-GCM 加密落库，界面与接口均不回显明文。</p>
          <p v-if="formError" class="err" role="alert">{{ formError }}</p>

          <!-- C10 测试连接：结果必须**落在按钮下方**（出错处），而不是飘一条 toast 就没了。 -->
          <div v-if="testResult" class="test-out" :class="testResult.ok ? 'is-ok' : 'is-bad'" role="status">
            <Icon :name="testResult.ok ? 'check' : 'alert-circle'" :size="15" />
            <div class="to-body">
              <span class="to-detail">{{ testResult.detail }}</span>
              <span class="to-meta">
                耗时 {{ testResult.latency_ms }} ms<template v-if="testResult.status"> · HTTP {{ testResult.status }}</template><template v-if="testResult.model_count !== null"> · 可用模型 {{ testResult.model_count }} 个</template>
              </span>
            </div>
          </div>

          <div class="actions">
            <button class="btn-primary" :disabled="saving" @click="save">
              <Icon name="check" :size="15" /> {{ saving ? '保存中…' : '保存' }}
            </button>
            <button class="btn-ghost" :disabled="testing || saving" title="只请求已保存的 API Endpoint；密钥框留空即用已保存密钥测试" @click="testConn">
              <Icon name="bolt" :size="15" /> {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>
          <!-- 只留「先后顺序」这一条用户会踩错的规则。测试连接的具体行为
               （只请求已保存地址、留空沿用旧密钥）改由按钮 title 承担，不再两处讲。 -->
          <p class="sec-note">改动地址、模型或密钥后，先「保存」再「测试连接」。</p>
        </template>
        <p v-else-if="formError" class="err">{{ formError }}</p>
      </section>

      <section v-if="report" v-show="activeTab === 'maint'" class="card">
        <div class="sec-head"><Icon name="gear" :size="16" /> 面板维护</div>
        <p class="sec-sub">
          重启、升级与公网 IP 核准是本页仅有的系统级操作；部署级参数（监听、会话、审计、备份等）
          在面板内<strong>不可改</strong>，需按下方提示编辑 config.toml 后重启生效——
          那类只读数值不再在此罗列，安装落点见「系统 → 目录」页。
        </p>

        <!-- 操作行：重启是 owner 专属（后端 can_restart 判定），admin 只看到说明。 -->
        <div class="restart-row">
          <button v-if="installation?.can_restart" class="btn-ghost btn-sm" type="button"
            :disabled="restarting" @click="restartOpen = true">
            {{ restarting ? '重启中…' : '重启面板' }}
          </button>
          <button v-if="canCheckUpdate" class="btn-ghost btn-sm" type="button"
            :disabled="checkingUpgrade" @click="checkUpgrade">
            {{ checkingUpgrade ? '检查中…' : '检查更新' }}
          </button>
          <button v-if="upgrade?.available && installation?.can_upgrade" class="btn-ghost btn-sm" type="button"
            :disabled="upgrading" @click="upgradeOpen = true">
            {{ upgrading ? '升级中…' : '执行升级' }}
          </button>
          <span class="dim tiny">{{ installation?.can_restart ? '重启会中断当前连接；服务恢复后页面自动刷新。' : '仅 owner 可重启面板。' }}</span>
        </div>
        <!-- 公网 IP：展示性事实（config.toml [info]）；「核准 IP」重新探测一次并写回。
             owner 专属——写的是面板自身部署文件，与重启同档；admin 只读值。 -->
        <div class="restart-row">
          <span class="dim tiny">公网 IP</span>
          <code class="mono">{{ pubIp || '—' }}</code>
          <button v-if="canApproveIp" class="btn-ghost btn-sm" type="button"
            :disabled="pubIpBusy" @click="approvePublicIp">
            {{ pubIpBusy ? '核准中…' : '核准 IP' }}
          </button>
        </div>
        <p v-if="pubIpErr" class="sec-note">核准失败：{{ pubIpErr }}</p>
        <!-- 检查更新反馈：只在点过「检查更新」后出现（操作反馈，不是常驻系统信息）。 -->
        <p v-if="checkingUpgrade" class="sec-note">检查中…</p>
        <p v-else-if="upgradeErr" class="sec-note">检查失败：{{ upgradeErr }}</p>
        <p v-else-if="upgrade?.available" class="sec-note">
          有新版本 <b>{{ upgrade.latest }}</b>（当前 {{ upgrade.current }}）。命令行：<code class="mono">sudo panel upgrade</code>
          （下载 → 验签 → 失败自动回滚；配置与数据保留）。
        </p>
        <p v-else-if="upgrade" class="sec-note">已是最新（{{ upgrade.current }}）。</p>
        <p v-if="upgrade?.available && installation && !installation.can_upgrade" class="sec-note">
          Web 升级不可用：{{ installation.upgrade_blocked_reason }}
        </p>

        <p class="sec-note">{{ report.deployment.hint }}</p>

        <!-- 仅本机监听时的可达性引导：这段是"为什么局域网连不上"的唯一答案。
             此前后端一直返回 localhost_only，但页面从不展示它，用户只会看到
             "IP:端口 打不开"，既不知因也不知怎么改。 -->
        <div v-if="report.deployment.localhost_only" class="reach-hint">
          <div class="rh-head"><Icon name="globe" :size="15" /> 为什么局域网里其他设备连不上？</div>
          <p>
            面板以 root 运行且只提供明文 HTTP，监听所有网卡等于把管理入口和口令暴露在网络上。
            因此默认（也是推荐）<b>只监听本机</b>，通过外部通道访问。
          </p>
          <ul>
            <li>
              <b>临时远程（推荐，无需改配置）</b>：建立 SSH 端口转发
              <code class="mono">ssh -L &lt;端口&gt;:127.0.0.1:&lt;端口&gt; &lt;user&gt;@&lt;server&gt;</code>，
              再访问 <code class="mono">http://127.0.0.1:&lt;端口&gt;</code>。
            </li>
            <li>
              <b>长期对外</b>：用「公网访问」向导或站点反代，由外部服务终结 HTTPS，面板仍只监听本机。
            </li>
            <li>
              <b>确需局域网直连</b>：编辑 <code class="mono">/etc/forkpanel/config.toml</code>，把 <code class="mono">[server]</code> 下的
              <code class="mono">localhost_only</code> 设为 <code class="mono">false</code>、<code class="mono">bind</code> 设为
              <code class="mono">"0.0.0.0"</code>，再执行 <code class="mono">systemctl restart panel</code>。
              <b>只改 bind 不生效</b>（会被 localhost_only 覆盖）。仅在可信内网使用。
            </li>
          </ul>
        </div>
      </section>

    </template>

    <!-- 能力矩阵：功能模块的开关状态总览（菜单为什么置灰、功能为什么 501），
         挂在锚点 #caps 上，可由 /settings#caps 手动深链直达。 -->
    <section id="caps" v-show="activeTab === 'caps'" class="card">
      <div class="sec-head"><Icon name="shield" :size="16" /> 能力矩阵（{{ supportedCount }} / {{ caps.length }} 可用）</div>
      <table class="fixed" v-table-nav>
        <!-- 列宽：原因为唯一弹性列（ellipsis + title 悬停）。 -->
        <colgroup>
          <col class="w-capk" /><col class="w-capst" /><col class="w-capbk" /><col class="w-caprs" />
        </colgroup>
        <thead><tr><th>能力</th><th>状态</th><th>后端</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="[k, c] in caps" :key="k">
            <td class="mono ellipsis" :title="k">{{ k }}</td>
            <td><span class="badge" :class="c.supported ? 'badge-ok' : 'badge-danger'">{{ c.supported ? '可用' : '不可用' }}</span></td>
            <td class="dim">{{ c.backend ?? '—' }}</td>
            <td class="dim ellipsis" :title="c.reason ?? ''">{{ c.reason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="tip">不可用项会在对应菜单自动置灰。原因码来自后端能力探测。</p>
    </section>

    <!-- 角色管理（RBAC，需 user.manage） -->
    <section v-if="canRoles" v-show="activeTab === 'roles'" class="card">
      <div class="sec-head"><Icon name="users" :size="16" /> 角色与权限（RBAC）</div>
      <p class="sec-note">
        内置角色的权限由<strong>代码</strong>定义，不可改也不可删。自定义角色的权限必须是
        <strong>你自己拥有权限的子集</strong>——否则任何拿到用户管理权的人都能造出一个权限更大的角色
        再把自己升上去。另：角色权限变更对<strong>已登录会话</strong>需重新登录才生效（权限在登录时快照）。
      </p>
      <!-- 我的权限徽章（原独立只读卡并入）：就是上文"自身权限的子集"那个自身权限，
           放在创建表单旁边作对照，不再单独占一张卡。 -->
      <div class="myperms">
        <span class="lbl">我的权限（登录时快照）</span>
        <div class="perms">
          <code v-for="p in auth.me?.permissions ?? []" :key="p">{{ p }}</code>
        </div>
      </div>
      <p v-if="roleErr" class="err" role="alert">{{ roleErr }}</p>

      <div v-if="roles.length" class="card flush">
        <table class="fixed" v-table-nav>
          <!-- 列宽：角色名为唯一弹性列；删除按钮列定宽 90px。 -->
          <colgroup>
            <col class="w-rlname" /><col class="w-rlperm" /><col class="w-rlsrc" /><col class="w-rlacts" />
          </colgroup>
          <thead><tr>
            <SortTh label="角色" :active="isSorted('name')" :dir="sortDir" @sort="toggleSort('name')" />
            <SortTh class="num" label="权限" :active="isSorted('permissions')" :dir="sortDir" @sort="toggleSort('permissions')" />
            <SortTh label="来源" :active="isSorted('builtin')" :dir="sortDir" @sort="toggleSort('builtin')" />
            <th />
          </tr></thead>
          <tbody>
            <template v-for="r in pageRows" :key="r.name">
              <tr>
                <td class="mono ellipsis" :title="r.name">{{ r.name }}</td>
                <td class="num">
                  <button class="perm-toggle" type="button"
                    :aria-expanded="expandedRole === r.name"
                    @click="expandedRole = expandedRole === r.name ? null : r.name">
                    {{ r.permissions.length }} 项
                    <span v-if="!r.permissions.length" class="danger">（无法解析）</span>
                  </button>
                </td>
                <td>{{ r.builtin ? '内置' : '自定义' }}</td>
                <td class="nowrap">
                  <template v-if="!r.builtin">
                    <button class="btn-ghost btn-sm" :disabled="roleBusy" @click="startEditPermissions(r)">编辑权限</button>
                    <button class="btn-ghost btn-sm danger" @click="delRole = r.name">删除</button>
                  </template>
                </td>
              </tr>
              <!-- 权限明细：点「N 项」展开。没有这层，界面只告诉你"这个角色有几项权限"，
                   却看不出是哪几项——而"权限准不准"正是最需要自证的地方。 -->
              <tr v-if="expandedRole === r.name" class="perm-detail-row">
                <td colspan="4">
                  <div class="perm-tags">
                    <code v-for="p in r.permissions" :key="p" :class="{ missing: missingFor(r.permissions).includes(p) }"
                      :title="missingFor(r.permissions).includes(p) ? '该权限你自身没有，此角色无法分配给你能管的账号' : p">{{ p }}</code>
                    <span v-if="!r.permissions.length" class="muted">权限数据无法解析（疑似库中 JSON 损坏），请删除该角色后重建</span>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
          @update:page="gotoPage" @update:size="changeSize" />
      </div>

      <EmptyState v-else-if="rolesLoaded && !roleErr" title="暂无角色"
        hint="内置角色由后端初始化；列表为空时先确认后端版本与迁移是否正常。" />

      <!-- 编辑自定义角色权限（后端 PATCH /roles/{name}） -->
      <div v-if="editRole" class="form edit-role">
        <div class="sec-head">
          <Icon name="edit" :size="15" /> 编辑角色 <code class="mono">{{ editRole }}</code> 的权限
        </div>
        <p v-if="editErr" class="err" role="alert">{{ editErr }}</p>
        <PermMatrix v-model="editPerms" :all="knownPerms" :granted="auth.me?.permissions ?? []"
          empty-hint="权限清单为空，请刷新页面重试" />
        <div class="actions">
          <button class="btn-ghost" :disabled="roleBusy" @click="cancelEditPermissions">取消</button>
          <button class="btn-primary" :disabled="roleBusy || !editPerms.length" @click="saveEditPermissions">
            {{ roleBusy ? '保存中…' : '保存权限' }}
          </button>
        </div>
        <p class="sec-note">改完对已登录会话不生效，需要该账号重新登录（权限在登录时快照）。</p>
      </div>

      <div class="form" style="margin-top:12px">
        <div class="field">
          <span class="lbl">新角色名（小写字母开头，2~32 位，可用字母/数字/_/-）</span>
          <input v-model="roleName" class="inp" placeholder="ops-readonly" />
        </div>
        <div class="field">
          <span class="lbl">权限（勾选；列表来自后端白名单，前端不自行发明名字）</span>
          <PermMatrix v-model="rolePerms" :all="knownPerms" :granted="auth.me?.permissions ?? []"
            empty-hint="权限清单为空，请刷新页面重试" />
        </div>
        <div class="actions">
          <button class="btn-primary" :disabled="roleBusy || !roleName.trim() || !rolePerms.length" @click="createRole">
            {{ roleBusy ? '创建中…' : '创建角色' }}
          </button>
        </div>
      </div>
    </section>

    <ConfirmDialog
      :open="!!delRole" danger title="删除角色"
      :detail="delRole ? `删除角色「${delRole}」？此操作不可撤销。` : ''"
      @confirm="delRole && deleteRole(delRole)" @cancel="delRole = null"
    />

    <ConfirmDialog :open="clearKeyOpen" danger title="清除 API Key"
      detail="将删除加密存储的 API Key；AI 助手会退回纯规则诊断，重新启用需再次填写服务商密钥。"
      @confirm="clearKeyOpen = false; clearKey()" @cancel="clearKeyOpen = false" />

    <ConfirmDialog :open="restartOpen" danger title="重启面板"
      detail="将执行 systemctl restart panel：当前页面会短暂断连，服务恢复后自动刷新；正在运行的任务与上传会被中断。"
      @confirm="doRestart" @cancel="restartOpen = false" />

    <ConfirmDialog :open="upgradeOpen" danger title="执行升级" confirm-word="UPGRADE"
      :detail="`将从 ${installation?.app_version ?? '当前版本'} 升级到 ${upgrade?.latest ?? '最新版'}：下载签名包并验签后替换二进制并重启；失败会自动回滚旧版本。输入 UPGRADE 确认。`"
      @confirm="doUpgrade" @cancel="upgradeOpen = false" />
  </div>
</template>

<style scoped>
.sec-sub { color: var(--c-text-mute); font-size: var(--fs-12-5); margin: 4px 0 10px; }
.sec-note { color: var(--c-text-mute); font-size: var(--fs-13); margin: 8px 0 0; }
.myperms { margin: 12px 0 2px; display: flex; flex-direction: column; gap: 6px; }
.restart-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }

/* 「为什么连不上」引导块：仅 localhost_only 时出现。用 warn 底色而非再嵌一张卡片，
   与上方只读键值表区分开——它是操作指引，不是配置项。 */
.reach-hint {
  margin-top: 10px; padding: 12px 14px;
  background: color-mix(in srgb, var(--c-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-warn) 30%, transparent);
  border-radius: var(--radius-sm);
  font-size: var(--fs-12-5); color: var(--c-text-dim); line-height: 1.75;
}
.rh-head {
  display: flex; align-items: center; gap: 6px;
  font-weight: 600; color: var(--c-text); margin-bottom: 6px;
}
.reach-hint p { margin: 0 0 8px; }
.reach-hint ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.reach-hint code {
  font-family: var(--mono); background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 4px; border-radius: var(--radius-chip);
}
.form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: var(--fs-12-5); color: var(--c-text-dim); }
/* 勾选框与标签同行（与文件内 .perm-chk 同一套对齐思路）：默认 .field 是纵向堆叠，
   文本框那样正常，勾选框独占一行就脱离了标签、位置别扭。这里让勾选框 + 文字在一行，
   说明文字留在下方；accent-color 用主色，深色主题下比原生灰框更协调。 */
.chk-inline { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; font-size: var(--fs-12-5); color: var(--c-text); cursor: pointer; }
.chk-inline input { accent-color: var(--c-primary); margin: 0; }
.inp {
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  padding: 9px 12px; color: var(--c-text); font-size: var(--fs-13-5); font-family: var(--mono);
}
.inp:focus { outline: none; border-color: var(--c-primary); }
.key-row { display: flex; gap: 8px; align-items: center; }
.key-row .inp { flex: 1; }
.set-ok { color: var(--c-ok); }
.danger { color: var(--c-danger); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
/* C10 测试连接结果：紧贴按钮下方（出错处），成功/失败两态，不占用 toast */
.test-out { display: flex; align-items: flex-start; gap: 9px; margin: 10px 0 0;
  padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--c-border); background: var(--c-surface-2); }
.test-out.is-ok { border-color: color-mix(in srgb, var(--c-ok) 42%, transparent); background: var(--c-ok-soft); }
.test-out.is-bad { border-color: color-mix(in srgb, var(--c-danger) 42%, transparent); background: var(--c-danger-soft); }
.test-out :deep(.icon) { flex: none; margin-top: 2px; }
.test-out.is-ok :deep(.icon) { color: var(--c-ok); }
.test-out.is-bad :deep(.icon) { color: var(--c-danger); }
.to-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.to-detail { font-size: var(--fs-13-5); color: var(--c-text); word-break: break-word; }
.to-meta { font-size: var(--fs-12); color: var(--c-text-dim); font-family: var(--mono); }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 14px; }
.perm-chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-12-5); cursor: pointer; }
.perm-chk code { color: var(--c-text-dim); }
/* 权限明细展开行：整行内嵌，宽度交给 4 列 colspan，不再受 colgroup 限制。 */
.perm-toggle {
  border: none; background: transparent; cursor: pointer; font: inherit;
  color: var(--c-text-dim); padding: 0; text-decoration: underline dotted;
}
.perm-toggle:hover { color: var(--c-primary); }
.perm-detail-row > td {
  background: var(--c-bg); padding: 8px 12px;
  /* table.fixed 给所有 td 设了 overflow:hidden（配合 ellipsis 截断），
     展开行里的标签是整块换行的，必须放开，否则标签被裁掉一半。 */
  overflow: visible; white-space: normal;
}
.perm-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.perm-tags code {
  font-family: var(--mono); font-size: var(--fs-12);
  padding: 2px 7px; border-radius: var(--radius-chip);
  background: var(--c-surface-2); border: 1px solid var(--c-border); color: var(--c-text-dim);
}
.perm-tags code.missing { border-color: var(--c-danger); color: var(--c-danger); }
.edit-role {
  margin-top: 12px; padding: 12px 14px;
  border: 1px solid var(--c-primary-soft); border-radius: var(--radius-sm);
}
.edit-role .sec-head { margin-bottom: 8px; }
.edit-role .actions { display: flex; gap: 8px; margin-top: 10px; }
.perms { display: flex; flex-wrap: wrap; gap: 8px; }
.perms code { background: var(--c-primary-soft); color: var(--c-primary); padding: 3px 10px; border-radius: 999px; font-size: var(--fs-12); }
/* 能力矩阵表列宽：原因为唯一弹性列；角色表列宽：角色名为唯一弹性列。 */
col.w-capk { width: 26%; }
col.w-capst { width: 90px; }
col.w-capbk { width: 110px; }
col.w-caprs { width: auto; }
col.w-rlname { width: 26%; }
col.w-rlperm { width: 120px; }
col.w-rlsrc { width: 100px; }
col.w-rlacts { width: 190px; }   /* 自定义角色两个带文字按钮（编辑权限 + 删除） */

</style>

<script setup lang="ts">
/**
 * 服务详情（独立路由页 /services/:unit）。
 *
 * 为什么从「列表页里的模态弹窗」改成独立页：
 * 弹窗里同时塞了启停操作 + 日志 + 配置编辑三块内容，模态承载过重——
 * 配置编辑器在弹窗里只有半屏高、日志区更挤。改成独立路由页后：
 *  - 地址可分享、浏览器「返回」可用（弹窗两者都不支持）
 *  - 配置编辑/日志有完整高度
 *  - 仍保留列表页作为入口，点行即进详情
 *
 * 安全约束（沿用弹窗时期的设计，勿删）：
 * - sshd 禁止停止（防失联），后端也会拒绝，此处是双保险。
 * - 未托管服务的停止需二次确认。
 * - 配置写入默认单元文件本体，但**推荐 drop-in**：发行版单元文件会在包升级时被覆盖。
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import {
  CAP, PackageCatalogEntry, ServiceConfig, ServiceInfo, ServiceJournal, serviceStateLabel,
} from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { serviceAbout } from '@/composables/serviceAbout'
import { serviceActionDisabled } from '@/composables/serviceActionState'
import { findPkgByUnit, pkgAboutRows } from '@/composables/pkgUnitLookup'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import LinedTextarea from '@/components/LinedTextarea.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const unit = computed(() => String(route.params.unit ?? ''))
const canManage = computed(() => auth.enabled(CAP.SERVICE_MANAGE, 'service.manage'))

// 返回上一页面。深链直接进入时 window.history 里没有本站历史，
// router.back() 会退出应用——此时兜底回服务列表。
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'services-units' })
}

const svc = ref<ServiceInfo | null>(null)
const loading = ref(true)
const error = ref('')
const actError = ref('')
const busy = ref('')            // `${name}:${action}`（启停/改自启/保存配置；整组操作锁）
const notFound = ref(false)

/** 整组操作锁：任一启停/改自启操作进行中时为真。
 *  用于按钮 `:disabled`——操作在跑时不该再叠一次动作。 */
const anyOp = computed(() => !!busy.value)

/**
 * 「说明」区的展示模型（判定规则在 composables/serviceAbout.ts，有单测）。
 *
 * 为什么不能直接渲染 `svc.description`：
 *  - 本机大多数服务不是面板装的，Description 常常是空串或 "LSB: ..." 占位
 *    → 直接渲染会得到一行空白或一行看不懂的英文；
 *  - 它是 systemd 单元自带的元数据，不是"面板对这块功能的解释"。
 * 所以这里区分"有真描述 / 没有"，没有时**明确说没有**而不是留空。
 */
const about = computed(() =>
  serviceAbout(svc.value?.description, svc.value?.name ?? unit.value))

/**
 * 当前单元对应的白名单软件条目（查不到 = `null`，表示这个服务不是面板能说明的软件）。
 *
 * 为什么要有它：详情页原本给一个「去『软件』页点 ?」的跳转——等于把用户踢到另一个
 * 页面，还要他自己在 22 张卡片里重新找到同一个软件。说明本来就在 `catalog` 里
 * （随 `/packages` 下发过），没有理由不在本页直接展开。
 *
 * 反查键是**单元名**，而包名与单元名不是同一个字符串（mariadb-server→mariadb.service、
 * grafana→grafana-server.service、php-fpm→php8.4-fpm.service），所以映射由后端 `units`
 * 下发、这里只做精确查找——细节与单测见 composables/pkgUnitLookup.ts。
 */
const pkgCatalog = ref<PackageCatalogEntry[]>([])
const pkgEntry = computed(() =>
  findPkgByUnit(pkgCatalog.value, svc.value?.name ?? unit.value))
/** 说明行（用途 / 功能 / 场景 / 去哪配 / 怎么配），顺序固定，空行已过滤。 */
const pkgRows = computed(() => (pkgEntry.value ? pkgAboutRows(pkgEntry.value) : []))

/**
 * 拉 catalog 用于本页展开说明。
 *
 * 能力门控在请求前（与软件页同一条纪律：无包管理能力时 `/packages` 会 501）。
 * **失败静默**：catalog 只用于「锦上添花地展示说明」，它挂了不该让服务详情页报错
 * 或显示重试——服务本身的启停/日志/配置才是这页的主体，必须照常可用。
 */
async function loadPkgCatalog() {
  if (!auth.supported(CAP.PACKAGE_INSTALL)) { pkgCatalog.value = []; return }
  try {
    const r = await api.get<{ catalog: PackageCatalogEntry[] }>(API.packages.list())
    pkgCatalog.value = r.catalog ?? []
  } catch { pkgCatalog.value = [] }
}

// 优先用单服务端点（GET /services/{unit}）：它用 `systemctl show` 按需加载单元，
// 绕开 list 的 `list-units --all` 全量枚举——后者只含已加载进运行时的单元，
// 把 enabled 但从未启动（dead）的服务（典型：刚装好还没 start 的 nginx）整体漏掉，
// 之前导致这类服务点进详情就报"未找到该服务"。
// 请求序号：换 unit（路由参数变化）时前后两次加载会并发，
// 旧的那个若后到，会把新服务的详情覆盖掉（页面显示 A 的名字却配着 B 的数据）。
let svcSeq = 0
async function loadSvc() {
  const seq = ++svcSeq
  loading.value = true; error.value = ''
  try {
    const r = await api.get<{ service: ServiceInfo }>(
      API.services.show(unit.value),
    )
    if (seq !== svcSeq) return
    svc.value = r.service
    notFound.value = false
  } catch (e) {
    // 单服务端点失败（单元名非法 / 真不存在 / 网络抖）时退回列表反查兜底，
    // 保证 active 服务的老路径仍可用，且 notFound 语义不变。
    if (seq !== svcSeq) return
    try {
      const r2 = await api.get<{ services: ServiceInfo[] }>(API.services.list())
      if (seq !== svcSeq) return
      const found = (r2.services ?? []).find(s => s.name === unit.value) ?? null
      svc.value = found
      notFound.value = !found
    } catch (e2) { if (seq === svcSeq) error.value = errorText(e2) }
  }
  finally { if (seq === svcSeq) loading.value = false }
}

/**
 * 动作/刷新后回填服务信息：从 status 拿权威 state，从 show 拿 enabled/managed/description。
 * 修「svcAct 只改 state 留下 stale enabled」——停服务后自启态会跟旧值走；
 * 外部 systemd 改动同理。集中在此作为单一事实源，避免启停/自启各处再写一遍（重复且易漂）。
 */
async function reloadServiceInfo() {
  if (!svc.value) return
  const [st, show] = await Promise.all([
    api.get<{ name: string; state: string }>(API.services.status(svc.value.name)),
    api.get<{ service: ServiceInfo }>(API.services.show(svc.value.name)),
  ])
  if (svc.value) {
    svc.value.state = st.state
    const s = show.service
    svc.value.enabled = s.enabled
    svc.value.managed = s.managed
    svc.value.description = s.description
  }
}

async function svcAct(action: 'start' | 'stop' | 'restart') {
  if (!svc.value) return
  const name = svc.value.name
  busy.value = `${name}:${action}`; actError.value = ''
  try {
    const url = action === 'start' ? API.services.start(name)
      : action === 'stop' ? API.services.stop(name)
      : API.services.restart(name)
    await api.post(url)
    // 动作后回填：status 拿权威 state，show 拿 enabled/managed/description
    // （修 svcAct 只改 state 留下的 stale enabled——停服务后自启态会跟旧值走）。
    await reloadServiceInfo()
  } catch (e) { actError.value = errorText(e) }
  finally { busy.value = '' }
}

async function toggleEnable() {
  if (!svc.value) return
  const name = svc.value.name
  busy.value = `${name}:enable`; actError.value = ''
  try {
    await api.put(API.services.setEnabled(name), { enabled: !svc.value.enabled })
    if (svc.value) svc.value.enabled = !svc.value.enabled
  } catch (e) { actError.value = errorText(e) }
  finally { busy.value = '' }
}

/** 运行态判定（与 serviceStateLabel / serviceActionDisabled 同一套 systemd 口径）。
 *  详情页的状态徽标、按钮联动都从这里派生，避免散落各写 `state === 'active'`。 */
const isRunning = computed(() => svc.value?.state === 'active')
const isTransitioning = computed(() =>
  svc.value?.state === 'activating' || svc.value?.state === 'deactivating')

/**
 * 启停按钮的禁用矩阵（单一事实源在 composables/serviceActionState.ts，有单测）。
 *  运行中：启动禁用、停止/重启可用；已停止/失败：停止禁用、启动/重启可用；
 *  过渡态：三者统一禁用；sshd 永不许停止；无权限或正在执行时整组禁用。
 *  服务加载完成前（svc 为空）一律禁用，避免对未知状态误触。
 */
const actionDisabled = computed(() => svc.value
  ? serviceActionDisabled({
    name: svc.value.name, state: svc.value.state, managed: svc.value.managed,
    canManage: canManage.value, busy: anyOp.value,
  })
  : { start: true, stop: true, restart: true, ssh: false })

function stateBadge(s: string) {
  return s === 'active' ? 'badge-ok' : s === 'failed' ? 'badge-danger'
    : (s === 'activating' || s === 'deactivating') ? 'badge-info' : ''
}

/** 状态徽标前的小圆点配色：运行中绿、失败红、过渡态琥珀、其余（已停止/未知）中性灰。
 *  让「运行中 / 已停止」在视觉上一眼可辨，而不仅是文字。 */
function statusDot(s: string): string {
  return s === 'active' ? 'ok'
    : s === 'failed' ? 'danger'
    : (s === 'activating' || s === 'deactivating') ? 'warn'
    : ''
}

// ─────────────── 未托管服务停止的二次确认 ───────────────
const confirmStop = ref(false)
function askStop() {
  if (!svc.value) return
  if (svc.value.managed) svcAct('stop')
  else confirmStop.value = true
}

// ─────────────── 日志 ───────────────
const tab = ref<'log' | 'config'>('log')
const journal = ref<string[]>([])
const jLoading = ref(false)
const jError = ref('')
const logEl = ref<HTMLElement | null>(null)

/**
 * 日志容器自动滚底（trailing 节流，与 LogsView 同款）。
 * journalctl 按时间**从旧到新**输出，最新一条在底部；面板若不滚底，用户第一屏
 * 看到的是最旧的日志，会误以为「排序乱了」。100ms 内多次新行只滚一次，
 * 避免每条 SSE 事件都读 scrollHeight 造成强制重排。
 */
let logScrollTimer: number | undefined
function scrollLogBottom() {
  if (logScrollTimer) return
  logScrollTimer = window.setTimeout(() => {
    logScrollTimer = undefined
    nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight })
  }, 100)
}

// 日志请求比列表慢得多，换 unit 时最容易后到并覆盖新服务的日志
// （表现：切到 B 服务，日志区显示的仍是 A 的日志，还停留在"加载中"之后）。
let jSeq = 0
async function loadJournal() {
  if (!svc.value) return
  const seq = ++jSeq
  jLoading.value = true; jError.value = ''
  try {
    const r = await api.get<ServiceJournal>(API.services.journal(svc.value.name), { params: { lines: 200 } })
    if (seq !== jSeq) return
    journal.value = r.lines ?? []
    scrollLogBottom()
  } catch (e) {
    if (seq !== jSeq) return
    if (isUnsupported(e)) jError.value = '日志查看功能即将推出'
    else jError.value = errorText(e)
  } finally { if (seq === jSeq) jLoading.value = false }
}

// ── 日志跟随（SSE）──
// 底层 journalctl -f：连上先补最近 N 行历史，再持续推增量。
// 与一次性 journal 的区别是"不用反复点刷新才能看到新日志"。
const follow = ref(false)
const MAX_KEEP = 500
const MAX_ES_RETRIES = 5
let es: EventSource | null = null
let esRetries = 0

function closeFollow() { if (es) { es.close(); es = null } }

function openFollow() {
  closeFollow()
  esRetries = 0
  journal.value = []
  es = new EventSource(API.services.journalStream(unit.value, 200))
  es.onopen = () => { esRetries = 0 }
  es.addEventListener('log', (ev: MessageEvent) => {
    try {
      const d = JSON.parse(ev.data) as { line: string }
      journal.value.push(d.line)
      if (journal.value.length > MAX_KEEP) journal.value.splice(0, journal.value.length - MAX_KEEP)
      scrollLogBottom()
    } catch { /* 忽略坏帧 */ }
  })
  // EventSource 断线会自动重连，但要给失败反馈与重连上限（审计 P7）
  es.onerror = () => {
    esRetries += 1
    if (esRetries > MAX_ES_RETRIES) {
      closeFollow()
      follow.value = false
      jError.value = `实时跟随已断开（连续 ${MAX_ES_RETRIES} 次重连失败），已退回静态日志`
      void loadJournal()
    }
  }
}

function toggleFollow() {
  follow.value = !follow.value
  if (follow.value) openFollow()
  else { closeFollow(); void loadJournal() }
}

// ─────────────── 配置（单元文件 / drop-in） ───────────────
//
// 两种写入目标（后端 ConfigTarget）：
//  - unit：单元文件本体。位于 /lib、/usr/lib 的发行版文件**会被包升级覆盖**。
//  - dropin：/etc/systemd/system/<unit>.d/override.conf，与单元文件合并生效、
//    不被包升级覆盖——systemd 官方推荐做法，界面上标为「推荐」。
// 防呆：默认写入目标就是 drop-in（最安全，升级不受影响）；单元文件仅在「该单元本就
// 在 /etc」或用户明确要改本体时才用，且保存非可写（发行版目录）的单元文件会二次确认。
type CfgTarget = 'unit' | 'dropin'

// 新 drop-in 文件（尚不存在）预填的起步模板：只写要改的键，列表型指令默认追加（替换先空值）。
const DROPIN_TEMPLATE = `# 在此覆盖/补充厂商单元的配置（文件在 /etc，软件升级不会被覆盖）
# 只写你要改的键，其余继承主单元文件；需要哪个段就写哪个段头（如 [Service]）。
# 列表型指令（ExecStart= 等）默认是“追加”，要替换先写一次空值再赋值，例如：
#   ExecStart=
#   ExecStart=/your/path
[Service]

`

const cfgTarget = ref<CfgTarget>('dropin')
/** 配置请求序号：快速切 unit/drop-in 时丢弃旧响应，避免 A 的配置覆盖 B */
let cfgSeq = 0
const cfg = ref<ServiceConfig | null>(null)
const cfgDraft = ref('')
const cfgLoading = ref(false)
const cfgError = ref('')
const cfgSaving = ref(false)
const cfgRestart = ref(false)
const cfgSaved = ref(false)

async function loadConfig() {
  const seq = ++cfgSeq
  const target = cfgTarget.value
  const unitName = unit.value
  cfgLoading.value = true; cfgError.value = ''; cfg.value = null; cfgSaved.value = false
  try {
    const r = await api.get<ServiceConfig>(
      API.services.config(unitName), { params: { target } })
    if (seq !== cfgSeq || unit.value !== unitName) return   // 已切目标/单元，丢弃本次结果
    cfg.value = r
    // 新 drop-in 文件（尚不存在）预填起步模板，降低“空白框 + 忘写段头”的上手门槛
    cfgDraft.value = (target === 'dropin' && !r.exists) ? DROPIN_TEMPLATE : r.content
  } catch (e) {
    if (seq !== cfgSeq || unit.value !== unitName) return
    if (isUnsupported(e)) cfgError.value = '当前环境不支持在线编辑配置'
    else cfgError.value = errorText(e)
  } finally { if (seq === cfgSeq) cfgLoading.value = false }
}

function openConfigTab() {
  tab.value = 'config'
  if (!cfg.value) void loadConfig()
}

watch(cfgTarget, () => { if (tab.value === 'config') void loadConfig() })

// 防呆：直接编辑位于 /lib、/usr/lib 的发行版单元文件，软件升级会被覆盖——
// 保存前二次确认，避免用户把自定义配置塞进单元文件后于升级时悄悄丢失。
const confirmUnitEdit = ref(false)

async function saveConfig() {
  if (!cfg.value) return
  if (cfgTarget.value === 'unit' && !cfg.value.writable) {
    confirmUnitEdit.value = true
    return
  }
  await doSaveConfig()
}

async function doSaveConfig() {
  if (!cfg.value) return
  cfgSaving.value = true; cfgError.value = ''; cfgSaved.value = false
  try {
    await api.put(API.services.configUpdate(unit.value), {
      content: cfgDraft.value,
      restart: cfgRestart.value,
      target: cfgTarget.value,
    })
    cfgSaved.value = true
    await loadConfig()
    if (cfgRestart.value) await loadSvc()
  } catch (e) { cfgError.value = errorText(e) }
  finally { cfgSaving.value = false }
}

onMounted(async () => {
  void loadPkgCatalog()          // 与详情并行：catalog 慢不该拖住服务本身的渲染
  await loadSvc()
  if (svc.value) void loadJournal()
})

// 同一路由内换 unit 时组件会被复用，onMounted 不会重跑——不监听就会停在旧服务的数据
// 上（且上一个服务的日志跟随流还开着）。必须先关流再重载。
watch(() => route.params.unit, async () => {
  closeFollow()
  follow.value = false
  cfg.value = null          // 否则会带着上一个服务的配置内容进入新服务
  tab.value = 'log'
  await loadSvc()
  if (svc.value) void loadJournal()
})

onUnmounted(() => { closeFollow(); if (logScrollTimer) clearTimeout(logScrollTimer) })
</script>

<template>
  <div>
    <div class="tools-row">
      <!-- 返回**上一页面**而非硬编码跳服务页签：本页可从软件页、概览等多处进入，
           写死跳 services-units 会把用户送到一个他从没待过的地方。
           深链直接进入（无历史）时才兜底回服务列表。 -->
      <button class="btn-ghost btn-sm icon-only" title="返回上一页" aria-label="返回上一页"
              @click="goBack">
        <Icon name="chevron-left" :size="14" />
      </button>
      <!-- 服务名 + 状态徽标上提至页级工具行，与返回按钮同排：标题区一眼可见，
           不再与卡片内的说明/操作区叠在一起。 -->
      <h1 v-if="svc" class="page-title mono">{{ svc.name }}</h1>
      <span v-if="svc" class="badge status-badge" :class="stateBadge(svc.state)">
        <span class="dot" :class="statusDot(svc.state)" />
        {{ serviceStateLabel(svc.state) }}
      </span>
      <span v-if="svc && !svc.managed" class="badge"
        title="该服务非面板创建（不代表故障）：启停操作仍可用，停止前需二次确认">未托管</span>
      <span class="spacer" />
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="loadSvc">重试</button></p>

    <EmptyState v-if="!auth.supported(CAP.SERVICE_MANAGE)"
      title="当前环境不支持服务管理"
      :reason="auth.capabilities[CAP.SERVICE_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <div v-if="loading" class="skeleton" style="height:120px;border-radius:var(--radius)" />

      <EmptyState v-else-if="notFound || !svc" title="未找到该服务"
        :hint="`单元 ${unit} 不在服务列表中，可能已被移除或名称有误`" />

      <template v-else>
        <section class="card svc-head">
          <!-- 说明：点开一个服务，先看它是做什么的。
               分两层——systemd 单元自带的 Description（软件自己写的元数据，可能是空/英文），
               以及面板侧的用途说明（来自后端 catalog，按单元名反查）。
               缺失时**明说缺失**并给出"该看什么"，绝不渲染成空白行。 -->
          <div class="about">
            <div class="about-label">
              说明
              <span v-if="about.fromSystemd" class="about-src">取自 systemd 单元描述</span>
            </div>
            <p class="about-text" :class="{ dim: !about.fromSystemd }">{{ about.text }}</p>
            <p v-if="about.hint" class="about-hint">{{ about.hint }}</p>

            <!-- 面板侧说明：**在本页直接展开**，不再把用户送去「软件」页点 ?
                 （送去等于让他在 22 张卡片里重新找一遍同一个软件）。
                 只在反查到条目时渲染；系统组件（accounts-daemon 之类）没有对应软件，
                 连区块都不出现——比给一个点了没结果的入口更诚实。 -->
            <dl v-if="pkgRows.length" class="pkg-about">
              <template v-for="r in pkgRows" :key="r.key">
                <dt>{{ r.label }}</dt>
                <dd>{{ r.text }}</dd>
              </template>
            </dl>
          </div>

          <p v-if="actError" class="err">{{ actError }}</p>

          <div class="m-acts">
            <button class="btn-ghost" :disabled="actionDisabled.start"
              :title="actionDisabled.start && isRunning ? '服务已在运行中'
                : (actionDisabled.start && isTransitioning ? '服务状态切换中，请稍候' : '')"
              @click="svcAct('start')">
              {{ anyOp ? '执行中…' : '启动' }}
            </button>
            <button class="btn-ghost danger" :disabled="actionDisabled.stop"
              :title="actionDisabled.ssh ? '禁止停止 SSH 服务以防失联'
                : (actionDisabled.stop && !isRunning ? '服务已停止，无需停止' : '')" @click="askStop">
              {{ anyOp ? '执行中…' : '停止' }}
            </button>
            <button class="btn-ghost" :disabled="actionDisabled.restart" @click="svcAct('restart')">
              {{ anyOp ? '执行中…' : '重启' }}
            </button>
            <span class="spacer" />
            <label class="switch-row" :class="{ on: svc.enabled }">
              <span class="sl-label">开机自启</span>
              <span class="switch">
                <input type="checkbox" :checked="svc.enabled"
                  :disabled="!canManage || anyOp" @change="toggleEnable" /><i />
              </span>
              <span class="sl-state">{{ svc.enabled ? '已启用' : '已关闭' }}</span>
            </label>
          </div>

          <p v-if="!svc.managed" class="tip warn-tip">
            ⚠ 该服务不受面板托管，停止前请确认影响；sshd 的停止会被拒绝以防失联。
          </p>
        </section>

        <section class="card">
          <div class="m-tabs">
            <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">日志</button>
            <button class="tab" :class="{ active: tab === 'config' }" :disabled="!canManage"
              @click="openConfigTab">配置</button>
          </div>

          <!-- 日志 -->
          <div v-if="tab === 'log'" class="m-log">
            <div class="sec-head">
              最近日志
              <span v-if="follow" class="badge badge-ok">
                <span class="dot ok" /> 实时跟随中
              </span>
              <span class="spacer" />
              <button class="btn-ghost btn-sm" :class="{ 'tab-active': follow }" @click="toggleFollow">
                <Icon name="refresh" :size="14" /> {{ follow ? '停止跟随' : '实时跟随' }}
              </button>
              <RefreshBtn :disabled="jLoading || follow" sm @click="loadJournal" />
            </div>
            <p v-if="jError" class="err">{{ jError }}</p>
            <pre v-if="jLoading" class="skeleton" style="height:220px" />
            <pre v-else-if="journal.length" ref="logEl" class="out">{{ journal.join('\n') }}</pre>
            <p v-else class="tip dim" style="margin:0">暂无日志输出</p>
          </div>

          <!-- 配置 -->
          <div v-else class="m-config">
            <div class="cfg-target">
              <span class="seg-label">写入目标</span>
              <div class="seg">
                <button class="seg-btn" :class="{ active: cfgTarget === 'dropin' }"
                  @click="cfgTarget = 'dropin'">drop-in <span class="rec">推荐</span></button>
                <button class="seg-btn" :class="{ active: cfgTarget === 'unit' }"
                  @click="cfgTarget = 'unit'">单元文件</button>
              </div>
              <span class="spacer" />
              <button class="btn-ghost btn-sm" :disabled="cfgLoading" @click="loadConfig">重新读取</button>
            </div>

            <p v-if="cfgLoading" class="skeleton" style="height:260px" />
            <p v-else-if="cfgError && !cfg" class="err">{{ cfgError }}</p>
            <template v-else-if="cfg">
              <p class="tip dim cfg-path">{{ cfg.path }}</p>
              <p v-if="cfgTarget === 'dropin' && !cfg.exists" class="tip">
                该 drop-in 文件尚不存在，保存后将创建（systemd 会把它与单元文件合并生效）。
              </p>
              <p v-if="cfgTarget === 'unit' && !cfg.writable" class="tip warn-tip">
                ⚠ 该文件位于发行版目录，修改可能在软件包升级时被覆盖。建议改用上方的「drop-in」。
              </p>
              <p v-if="cfgError" class="err">{{ cfgError }}</p>
              <LinedTextarea
                v-model="cfgDraft"
                :min-height="'320px'"
                :disabled="cfgSaving"
                :filename="cfg.path"
                aria-label="服务配置文件内容"
              />
              <div class="cfg-foot">
                <label class="switch-row">
                  <span>保存后重启服务</span>
                  <span class="switch">
                    <input type="checkbox" v-model="cfgRestart" :disabled="cfgSaving" /><i />
                  </span>
                </label>
                <span class="spacer" />
                <span v-if="cfgSaved" class="badge badge-ok">已保存</span>
                <button class="btn-primary" :disabled="cfgSaving || !canManage" @click="saveConfig">
                  {{ cfgSaving ? '保存中…' : '保存配置' }}
                </button>
              </div>
            </template>
          </div>
        </section>
      </template>
    </template>

    <ConfirmDialog :open="confirmStop" danger title="停止服务"
      :detail="`${svc?.name ?? ''} 不受面板托管，停止可能影响依赖它的业务。请确认你了解此操作的后果。`"
      @confirm="() => { confirmStop = false; svcAct('stop') }" @cancel="confirmStop = false" />

    <ConfirmDialog :open="confirmUnitEdit" danger title="直接编辑单元文件"
      :detail="`${cfg?.path ?? ''} 位于发行版目录，软件包升级时会被覆盖，你在此的自定义配置可能丢失。确定仍要直接编辑单元文件吗？建议改用上方的「drop-in」（位于 /etc，升级不受影响）。`"
      @confirm="() => { confirmUnitEdit = false; doSaveConfig() }" @cancel="confirmUnitEdit = false" />
  </div>
</template>

<style scoped>
.svc-head { padding: 18px; margin-bottom: 14px; }
/* 返回按钮去掉文字后需保持可点击面积：固定为正方形，图标居中 */
.icon-only { display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; }
/* 页级工具行：返回 / 服务名 / 状态徽标同排。布局复用全局 .tools-row（无玻璃容器），
   此处不再私有重抄一份 .page-head —— check-page-head.mjs [1b] 要求全站清零。 */
.page-title { margin: 0; font-size: var(--fs-17); font-weight: 600; }
/* 状态徽标：圆点 + 文字一体化，让「运行中/已停止」一眼可辨（圆点配色见 statusDot） */
.status-badge { display: inline-flex; align-items: center; gap: 6px; }
.status-badge .dot { flex: none; }
/* 说明区：浅底分成一块，与操作按钮群之间有一条视觉分界。
   用左竖线而非整块边框——它属于头部卡片的一部分，不该再套一层盒子。 */
.about {
  margin-top: 10px; padding: 10px 0 10px 12px;
  border-left: 2px solid var(--c-border-strong);
}
.about-label {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-12); color: var(--c-text-dim); margin-bottom: 4px;
}
.about-src {
  padding: 1px 7px; border-radius: 999px; line-height: 1.4;
  background: var(--c-hover); color: var(--c-text-dim);
}
.about-text { margin: 0; font-size: var(--fs-13-5); line-height: 1.65; }
.about-hint {
  margin: 6px 0 0; font-size: var(--fs-12-5); line-height: 1.6;
  color: var(--c-text-dim);
}
/* 面板侧说明：左侧标签列固定宽度，右侧正文自动换行。
   用 dl/dt/dd 而不是 div+p —— 这是「标签: 内容」的语义结构，屏幕阅读器会念成
   定义列表；纯视觉排版用 div 也能做到，但没有语义。
   标签列 64px 是量过的：最长标签是「主要功能」4 个中文字（12.5px 字号 ≈ 50px），
   留出 14px 余量，四字标签不会折行。 */
.pkg-about {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 4px 10px;
  margin: 10px 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--c-border);
  font-size: var(--fs-13);
  line-height: 1.65;
}
.pkg-about dt {
  color: var(--c-text-dim);
  white-space: nowrap;
}
.pkg-about dd { margin: 0; }
/* 窄屏（≤720，与表格转 table-layout:auto 同一断点）改成单列堆叠：
   420px 视口下 64px 标签列会把正文压到 240px，五行说明折成 150px+ 高的一坨，
   而左侧标签此时只是"每段开头的四个字"——退化成标题更省空间也更好读。
   判据是真机量测：单列前正文列 240px、最长那行高 150px；单列后正文独占 314px。 */
@media (max-width: 720px) {
  .pkg-about { grid-template-columns: 1fr; gap: 2px; }
  .pkg-about dt { margin-top: 6px; }
  .pkg-about dt:first-child { margin-top: 0; }
}
.m-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.mono { font-family: var(--mono); }
.warn-tip { color: var(--c-warn); }
.dim { color: var(--c-text-dim); }

.m-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--c-border); }
.tab { background: none; border: none; padding: 8px 14px; font-size: var(--fs-13-5); color: var(--c-text-dim);
      cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover:not(:disabled) { color: var(--c-text); }
.tab.active { color: var(--seg-on-fg); border-bottom-color: var(--c-primary); font-weight: 600; }
.tab:disabled { opacity: .5; cursor: not-allowed; }

.m-log { padding-top: 14px; }
.m-log .sec-head { margin-bottom: 8px; }
.tab-active { color: var(--c-primary); border-color: var(--c-primary); }

.m-config { padding-top: 14px; }
.cfg-target { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.seg-label { font-size: var(--fs-13); color: var(--c-text-dim); }
.seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--seg-border); border-radius: var(--seg-radius); background: var(--seg-bg); }
.seg-btn { border: none; border-radius: var(--seg-item-radius); background: transparent; padding: 5px 12px; font-size: var(--fs-13); color: var(--seg-fg); }
.seg-btn:hover:not(.active) { background: var(--c-hover); transform: none; }
.seg-btn.active { background: var(--seg-on-bg); color: var(--seg-on-fg); font-weight: 600; }
.rec { font-size: var(--fs-12); color: var(--c-ok); margin-left: 4px; }
.cfg-path { font-family: var(--mono); word-break: break-all; margin: 0 0 8px; }
.cfg-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }

.out { margin: 0; padding: 12px 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: var(--fs-12-5);
       white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow: auto; }

.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--c-text-dim); cursor: pointer; user-select: none; }
.switch-row.on { color: var(--c-primary); font-weight: 600; }
.sl-label { line-height: 1; }
.sl-state { font-size: var(--fs-12); padding: 2px 9px; border-radius: 999px; line-height: 1.4; white-space: nowrap; }
.switch-row.on .sl-state { color: var(--c-primary); background: var(--c-primary-soft); }
.switch-row:not(.on) .sl-state { color: var(--c-text-dim); background: var(--c-hover); }
</style>

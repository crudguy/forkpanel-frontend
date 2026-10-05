<script setup lang="ts">
/**
 * 软件与服务（列表页）。
 *
 * 交互设计：
 * - 本页只负责**软件**（白名单安装/卸载）与**服务列表**概览。
 *   单个服务的启停、日志、配置编辑已移到独立详情页 `/services/:unit`
 *   （ServiceDetailView）——原先它们挤在一个模态弹窗里，配置编辑器与日志区
 *   都只有半屏高；改成独立页后地址可分享、浏览器「返回」可用、编辑区有完整高度。
 * - 服务表格**行点击 → 跳转详情页**（不再是弹窗）。
 * - 软件区展示白名单内已装列表（/packages），卸载需输入包名确认；
 *   安装/卸载走任务队列，进度由 SSE（/api/v1/events/tasks）推送并在顶部任务条展示。
 */
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
// ServiceConfig / ServiceJournal / fmtDateTime 随服务弹窗一并移出（现由详情页使用）
import { CAP, PackageInfo, ServiceInfo as Svc, TaskRun, TASK_FINISHED, serviceStateLabel, serviceStateBadge, taskStateBadge, taskStateLabel } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import InstallPackageDialog from '@/components/InstallPackageDialog.vue'
import Icon from '@/components/Icon.vue'
import TabBar from '@/components/TabBar.vue'

// Svc 直接取 types.ts 的 ServiceInfo（与服务详情页共用，避免两处各自定义漂移）；
// 以别名引入是为保留本文件既有的 Svc 写法、压低改动面。
interface TaskWatch { id: number; label: string; state: string; percent: number; out?: string[] }

const auth = useAuthStore()
const svcs = ref<Svc[]>([])
const loading = ref(true)        // 服务列表首次加载骨架
const pkgs = ref<PackageInfo[] | null>(null)
const init = ref('')
const error = ref('')
const pkgNote = ref('')
// svcError 随服务弹窗移除（服务操作的错误提示现由详情页承载）
// 注：此前有个 busy ref 名曰「软件安装/卸载提交中」，但全文件从未给它赋过值——
// 于是 :disabled="!!busy" 恒为 false，刷新按钮的禁用保护从来没生效过（假保护）。
// 已删除；按钮改用真实的加载态（服务 Tab 看 loading，软件 Tab 看 pkgs === null）。
const loadingPkg = ref('')      // 正在提交安装的包名
// 安装对话框状态：点「+ 安装」先弹窗选版本，再提交。
// 演进：行内版本输入框（25 行重复占位）→ 区块头总开关（易看漏）→ 现在的安装弹窗
// （选择入口就在操作路径上，且版本是下拉选项而非手输，避免输错）。
const dlgPkg = ref('')            // 弹窗当前包名；空=未打开
const dlgVersions = ref<string[]>([])
const dlgLoading = ref(false)
// 后端白名单随 /packages 下发的 name→label 映射（品牌名，如 apache2→Apache）。
// 单一事实源在后端，前端只消费，不在 CATEGORIES 里再维护一份标签。
const labelMap = ref<Map<string, string>>(new Map())
function labelOf(n: string): string { return labelMap.value.get(n) ?? n }

// 官方仓库通常不含、需先配第三方软件源才能安装的包（后端下发，前端只消费）。
// 这类包仍保留安装入口（配好源即可装），只是加提示避免用户白点一次才发现装不了。
const externalPkgs = ref<Set<string>>(new Set())
function needsExternalSource(n: string): boolean { return externalPkgs.value.has(n) }

// 注：此前这里另有一份 WHITELIST 数组，与 CATEGORIES 重复且与后端 ALLOWED_PACKAGES
// 三角漂移（改一处漏两处）。现在包集合的唯一事实源是下面的 CATEGORIES.pkgs，
// 与后端 ALLOWED_PACKAGES 的一致性由 ci/check-pkg-whitelist.sh 双向校验。
const canManage = computed(() => auth.enabled(CAP.SERVICE_MANAGE, 'service.manage'))
// 权限点必须是 package.manage（见后端 auth::perm::PACKAGE_MANAGE）——此前误传成
// 能力位名 package.install，而权限集合里根本没有这一项，导致 owner 也过不了
// `enabled = supported && can`，安装/卸载按钮被自己 disable（能力位 supported 是 true）。
const canPkg = computed(() => auth.enabled(CAP.PACKAGE_INSTALL, 'package.manage'))
const installedNames = computed(() => new Set(pkgs.value?.map(p => p.name) ?? []))

// 「软件 / 服务」两个 Tab 由**子路由**驱动（services-software / services-units 指向本组件）：
// 顶栏标题随路由 meta.title 变化、Tab 可深链可前进后退，与「主机监控」同范式。
// 故 tab 只是路由的投影，不再持有本地状态——避免 URL 与界面各说各话。
const route = useRoute()
const tab = computed<'software' | 'services'>(() =>
  route.name === 'services-units' ? 'services' : 'software')

// 供全站统一的分段控件 components/TabBar.vue 渲染（路由模式：点击即导航，
// 高亮按 route.path 精确比对）。顺序与侧边栏菜单名「软件与服务」对齐：
// 软件在前（默认 Tab）、服务在后。
const TABS = [
  { to: '/services/software', label: '软件' },
  { to: '/services/units', label: '服务' },
]

// 软件包按运维职责分组，顺序即展示顺序。
//
// 这里是**前端可安装/可卸载包集合的唯一事实源**（pkgs 的并集），不再另设 WHITELIST。
// 收窄说明：已去掉 curl/wget/git/unzip/tar 这类通用基础工具——它们与"服务管理"
// 无关，混进已安装清单只会制造噪声（面板以 root 运行，白名单本就该尽量小）。
// 与后端 ALLOWED_PACKAGES 的一致性由 ci/check-pkg-whitelist.sh 双向校验：
// 后端新增而前端没加 → 用户拿不到安装入口；前端新增而后端没加 → 点了被 400 拒绝。
const CATEGORIES: { key: string; label: string; pkgs: string[] }[] = [
  { key: 'web', label: 'Web 服务', pkgs: ['nginx', 'caddy', 'apache2', 'haproxy'] },
  { key: 'db', label: '数据库', pkgs: ['mysql-server', 'mariadb-server', 'postgresql'] },
  { key: 'cache', label: '缓存', pkgs: ['redis', 'memcached', 'valkey-server'] },
  { key: 'runtime', label: '运行环境', pkgs: ['php-fpm', 'nodejs', 'default-jdk'] },
  { key: 'storage', label: '存储', pkgs: ['minio'] },
  { key: 'monitor', label: '监控', pkgs: ['prometheus', 'grafana', 'netdata', 'uptime-kuma'] },
  { key: 'sec', label: '安全', pkgs: ['certbot', 'fail2ban', 'ufw'] },
  { key: 'network', label: '网络', pkgs: ['wireguard-tools'] },
]

// 软件（包）→ 服务（systemd 单元）的候选名。
//
// 用户想要的是"装上去的软件能管理"。但**包 ≠ 服务单元，名字也不总一致**：
// mariadb-server 包对应的是 mariadb.service，apache2 包在 RHEL 上叫 httpd.service，
// certbot 根本没有 service（它是 certbot.timer 定时器），ufw 也不是靠服务启停来管理。
// 所以不能假设"每个软件都有服务"去给通用按钮——那等于给用户一批点了必失败的入口。
//
// 做法：只在**本机真实服务列表**（svcs）里反查，查到才渲染入口与状态，查不到就不显示。
const UNIT_HINTS: Record<string, string[]> = {
  'mysql-server': ['mysql', 'mysqld', 'mariadb'],
  'mariadb-server': ['mariadb', 'mysql', 'mysqld'],
  redis: ['redis-server', 'redis'],
  apache2: ['apache2', 'httpd'],
  certbot: [],   // 靠定时器触发续期，没有常驻服务可管
  ufw: [],       // 规则由「防火墙」页管理
}

/** 找该软件包对应的服务单元；找不到返回 null（调用方据此决定是否渲染入口）。 */
function unitFor(pkg: string): Svc | null {
  for (const cand of [pkg, ...(UNIT_HINTS[pkg] ?? [])]) {
    // 后端服务的 name 是完整单元名（带 .service 后缀），也兼容无后缀形态
    const hit = svcs.value.find(s => s.name === `${cand}.service` || s.name === cand)
    if (hit) return hit
  }
  return null
}

// 已安装软件按类别分组：只保留确有包在 pkgs 里的类别（空类别不渲染小标题）。
const installedByCat = computed(() => {
  const all = pkgs.value ?? []
  return CATEGORIES.map(c => ({
    ...c,
    // unit 为 null 表示该软件没有可管理的服务（如 certbot/ufw）——UI 据此不渲染入口
    items: c.pkgs.map(n => all.find(x => x.name === n))
      .filter((x): x is PackageInfo => !!x)
      .map(p => ({ ...p, unit: unitFor(p.name) })),
  })).filter(c => c.items.length)
})

// 可安装软件按类别分组：白名单内、且尚未安装的包。
const installableByCat = computed(() => CATEGORIES.map(c => ({
  ...c,
  items: c.pkgs.filter(p => !installedNames.value.has(p)),
})).filter(c => c.items.length))

async function load(silent = false) {
  // silent=true 是轮询刷新：不能重置 loading（否则表格每轮闪一次骨架），
  // 也不清 error（否则常驻表格抖动）；失败不写 error——下一轮成功即自愈。
  if (!silent) { error.value = ''; loading.value = true }
  // 请求级门控：init 系统未知时后端返 501（service.manage=no）
  if (!auth.supported(CAP.SERVICE_MANAGE)) { if (!silent) loading.value = false; return }
  try {
    const r = await api.get<{ init_system: string; services: Svc[] }>(API.services.list())
    init.value = r.init_system
    // 兜底：services 缺失时保持空数组，后续 computed（filter/sort）不会崩
    svcs.value = r.services ?? []
  } catch (e) {
    if (!silent) error.value = errorText(e)
  }
  finally { if (!silent) loading.value = false }
}

// 包探测的真实成本：后端对白名单内每个候选都跑一次包管理器查询
// （Debian 上是 15 次 dpkg-query），不是一次廉价请求。Tab 来回切换若每次都全量探测，
// 很快就变成"切一下卡一下"。故给清单加软新鲜度：5s 内视为新鲜，除非显式 force。
let pkgLoadedAt = 0
async function loadPackages(force = false) {
  if (!force && pkgs.value && Date.now() - pkgLoadedAt < 5000) return
  pkgNote.value = ''
  // 同上：无包管理器时 package.install=no，枚举端点会 501
  if (!auth.supported(CAP.PACKAGE_INSTALL)) { pkgs.value = []; return }
  try {
    const r = await api.get<{ packages: PackageInfo[]; catalog: { name: string; label: string; external?: boolean }[] }>(API.packages.list())
    pkgs.value = r.packages ?? []
    labelMap.value = new Map((r.catalog ?? []).map(c => [c.name, c.label]))
    externalPkgs.value = new Set((r.catalog ?? []).filter(c => c.external).map(c => c.name))
    pkgLoadedAt = Date.now()
  } catch (e) {
    pkgs.value = []
    if (isUnsupported(e)) pkgNote.value = '软件包枚举功能即将推出（可先使用下方安装）'
    else pkgNote.value = errorText(e)
  }
}

// ─────────────── 自动刷新 ───────────────
// 服务的启停 / 开机自启状态会变（在详情页操作、或系统层面变化），手动刷新不及时；
// 加轮询让列表常驻最新。5s 比进程页 3s 更克制——服务状态变化频率低，无需高刷。
// 仍配 visibilitychange 暂停 + onUnmounted 清理，避免后台标签页空转拉请求。
let timer: number | undefined
function stop() { if (timer) { clearInterval(timer); timer = undefined } }
// 轮询只服务列表（软件区靠任务流/手动刷新）；且仅 services Tab 激活时才跑。
function start() {
  stop()
  if (tab.value === 'services' && auth.supported(CAP.SERVICE_MANAGE)) {
    timer = window.setInterval(() => load(true), 5000)
  }
}

/** Tab 切换由**路由变化**驱动（不再是点击 handler）：服务 → 立即拉一次并开轮询；
    软件 → 停轮询并加载软件清单。 */
watch(tab, (t) => {
  if (t === 'services') { load(); start() }
  // 软件卡片的「服务状态」取自服务列表，而轮询只在服务 Tab 跑；切过来时补一次
  // silent 刷新，避免停在几分钟前的旧状态上。
  else { stop(); load(true); loadPackages() }
})

/** 刷新当前 Tab：服务列表 reload，软件清单 reload（用户显式点刷新 → 强制，绕过新鲜度）。 */
function refresh() { if (tab.value === 'services') load() ; else loadPackages(true) }

/** 页面隐藏时停轮询：后台标签页持续拉服务列表纯属浪费。 */
function onVisibility() {
  if (document.hidden) { stop(); return }
  if (tab.value === 'services') { load(true); start() }
}

onMounted(() => {
  // 两个子数据都预加载：软件区是默认 Tab；服务列表虽非默认，但顶部 init 徽标
  // 取自 /services —— 不预拉的话，进软件 Tab 时那枚徽标会一直空着。
  // 轮询仍由 start() 按当前 tab 决定（默认 software → 不起轮询）。
  load()
  loadPackages()
  start()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  stopWatch()
  stop()
  document.removeEventListener('visibilitychange', onVisibility)
})

// ─────────────── 安装/卸载任务进度 ───────────────

// 进度改走 SSE（/api/v1/events/tasks，后端 sse.rs::task_stream 广播
// progress / log / finished 三类事件），不再每 1.5s 轮询 /tasks：
// 装包是分钟级任务，轮询会产生大量无谓请求，且百分比更新有 1.5s 滞后。
//
// 终态判定沿用共享词表：此前写死 ['done',...]，而后端成功终态是 'ok'
// （'done' 根本不会出现）→ 任务完成后进度条永不停止。
const FINISHED = TASK_FINISHED
const task = ref<TaskWatch | null>(null)
const MAX_ES_RETRIES = 5
let es: EventSource | null = null
let esRetries = 0
let taskSettled = false

function watchTask(id: number, label: string) {
  stopWatch()
  taskSettled = false
  task.value = { id, label, state: 'running', percent: 0, out: [] }
  openTaskStream()
  // 见 syncTaskOnce 注释：补一次状态同步，兜住"订阅前就已结束"的时间差
  void syncTaskOnce()
}
function stopWatch() { if (es) { es.close(); es = null } }
function dismissTask() { stopWatch(); task.value = null }

function openTaskStream() {
  stopWatch()
  esRetries = 0
  es = new EventSource(API.events.tasks())
  es.onopen = () => { esRetries = 0 }
  es.addEventListener('progress', (ev: MessageEvent) => {
    const d = parseEv<{ id: number; percent: number }>(ev)
    if (d && task.value && d.id === task.value.id) task.value.percent = d.percent ?? 0
  })
  es.addEventListener('log', (ev: MessageEvent) => {
    const d = parseEv<{ id: number; line: string }>(ev)
    if (!d || !task.value || d.id !== task.value.id) return
    const out = task.value.out ?? []
    out.push(d.line)
    task.value.out = out.slice(-10)   // 只留尾部：apt 输出很长，别把内存撑爆
  })
  es.addEventListener('finished', (ev: MessageEvent) => {
    const d = parseEv<{ id: number; state: string }>(ev)
    if (d && task.value && d.id === task.value.id) {
      task.value.state = d.state
      void onTaskFinished(d.state)
    }
  })
  // EventSource 断线会自动重连，但要给失败反馈与重连上限（同 LogsView 审计 P7）：
  // 此前无上限，断网/后端重启时 UI 会长期停在「执行中」而没有任何提示
  es.onerror = () => {
    esRetries += 1
    if (esRetries > MAX_ES_RETRIES) {
      const label = task.value?.label ?? ''
      stopWatch()
      task.value = null
      error.value = `任务进度实时推送已断开（连续 ${MAX_ES_RETRIES} 次重连失败）：${label} 可能仍在执行，可到任务中心查看`
    }
  }
}

/** 单帧解析：坏帧直接丢弃，不阻断后续事件 */
function parseEv<T>(ev: MessageEvent): T | null {
  try { return JSON.parse(ev.data) as T } catch { return null }
}

/** 入队 → 订阅之间存在时间差，极短的任务可能在连上 SSE 前就已结束；
    连上后补一次状态同步，避免进度条永远停在「执行中」。 */
async function syncTaskOnce() {
  const t = task.value
  if (!t) return
  try {
    const r = await api.get<TaskRun[] | { tasks: TaskRun[] }>(API.tasks.list())
    const list = Array.isArray(r) ? r : (r.tasks ?? [])
    const row = list.find(x => x.id === t.id)
    if (!row) return
    if (row.progress != null && task.value) task.value.percent = row.progress
    if (FINISHED.has(row.state)) {
      if (task.value) task.value.state = row.state
      await onTaskFinished(row.state)
    }
  } catch { /* 同步失败不致命：SSE 仍在工作 */ }
}

async function onTaskFinished(state: string) {
  if (taskSettled) return          // SSE 的 finished 与补同步可能同时命中终态
  taskSettled = true
  stopWatch()
  // log 事件已实时累积输出；若该任务没有产生日志事件，回落到 HTTP 读取
  if (task.value && !task.value.out?.length) {
    try {
      const o = await api.get<{ lines?: string[] }>(API.tasks.output(task.value.id) + '?lines=12')
      if (task.value) task.value.out = (o.lines ?? []).slice(-10)
    } catch { /* 输出读取失败不阻断状态展示 */ }
  }
  // 成功终态是 'ok'（不是 'done'，后端从不返回 done）——
  // 此处若写 'done' 则刷新分支永不命中，装完软件列表不更新
  if (state === 'ok') { loadPackages(true); load() }
}

// 徽标与文案统一走共享词表（src/api/types.ts），与任务中心口径一致
function taskBadge(s: string) { return taskStateBadge(s) }
function taskStateText(s: string) { return taskStateLabel(s) }

// ─────────────── 软件安装 / 卸载 ───────────────

// 点「+ 安装」：先开弹窗并按需拉该包的可用版本（不阻塞——查不到也能装最新版）。
// 版本查询失败不当错误：那只会让用户没法选版本，但装最新版仍然可用。
async function askInstall(p: string) {
  error.value = ''
  dlgPkg.value = p
  dlgVersions.value = []
  dlgLoading.value = true
  try {
    const r = await api.get<{ name: string; versions: string[] }>(API.packages.versions(p))
    dlgVersions.value = r.versions ?? []
  } catch {
    dlgVersions.value = []   // 查不到就只提供「最新版本」，弹窗仍可用
  } finally { dlgLoading.value = false }
}

function closeInstallDlg() { dlgPkg.value = ''; dlgVersions.value = [] }

// 弹窗确认后真正提交（version 为 undefined 表示装最新版）
async function doInstall(v: string | undefined) {
  const p = dlgPkg.value
  if (!p) return
  closeInstallDlg()
  loadingPkg.value = p; error.value = ''
  try {
    const r = await api.post<{ task_id: number; created: boolean }>(API.packages.install(), { name: p, version: v })
    if (!r.created) error.value = '该安装任务已在进行中（已复用已有任务）'
    watchTask(r.task_id, `安装 ${p}${v ? ' @ ' + v : ''}`)
  } catch (e) {
    if (isUnsupported(e)) error.value = '软件安装功能即将推出'
    else error.value = errorText(e)
  } finally { loadingPkg.value = '' }
}

async function removePkg(n: string) {
  error.value = ''
  try {
    const r = await api.del<{ task_id: number; created: boolean }>(API.packages.remove(n))
    if (!r.created) error.value = '该卸载任务已在进行中（已复用已有任务）'
    watchTask(r.task_id, `卸载 ${n}`)
  } catch (e) { error.value = errorText(e) }
}

// ─────────────── 跳转服务详情 ───────────────
// 服务的启停 / 日志 / 配置编辑都在独立详情页（/services/:unit）；本页只做入口。
// 原先这三块挤在模态弹窗里，配置编辑器与日志区都只有半屏高，且地址不可分享。
const router = useRouter()
function goDetail(s: Svc) {
  router.push({ name: 'service-detail', params: { unit: s.name } })
}
/** 软件卡片 → 对应服务的详情页（与点服务行走的是同一个入口）。 */
function goUnit(s: Svc) { router.push({ name: 'service-detail', params: { unit: s.name } }) }

// 状态徽标统一走共享 serviceStateBadge（src/api/types.ts），与任务中心口径一致

// ─────────────── 卸载软件确认（需输入包名） ───────────────

const confirmRemove = ref<string | null>(null)
const confirmTitle = computed(() => confirmRemove.value ? `卸载软件 ${labelOf(confirmRemove.value)}` : '')
const confirmDetail = computed(() => confirmRemove.value
  ? `将从系统中卸载 ${confirmRemove.value}（走任务队列执行包管理器 remove）。配置文件与用户数据一般会保留，请确认无正在进行的业务依赖。`
  : '')
const confirmWord = computed(() => confirmRemove.value ?? undefined)

function askRemove(n: string) { confirmRemove.value = n }

async function doConfirmed() {
  const n = confirmRemove.value
  confirmRemove.value = null
  if (n) await removePkg(n)
}
</script>

<template>
  <div>
    <!-- 头部单行：Tab 用全站统一的分段控件（components/TabBar.vue），
         本页专属信息（init 系统）与刷新按钮归拢到右侧，不再是三处各自孤立。 -->
    <div class="page-head">
      <TabBar :tabs="TABS" />
      <span class="spacer" />
      <span v-if="init" class="badge badge-primary"
            title="面板探测到的 init 系统，决定服务命令走 systemd 还是其它">init: {{ init }}</span>
      <!-- 禁用依据必须是真实加载态：此前用恒空的 busy，保护从未生效 -->
      <button class="btn-primary" :disabled="tab === 'services' ? loading : pkgs === null" @click="refresh()">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <!-- 安装/卸载任务进度条 -->
    <div v-if="task" class="card taskstrip">
      <div class="ts-head">
        <Icon name="terminal" :size="15" />
        <strong>{{ task.label }}</strong>
        <span class="badge" :class="taskBadge(task.state)">
          {{ taskStateText(task.state) }} {{ task.percent }}%
        </span>
        <span class="spacer" />
        <button class="btn-ghost btn-sm" @click="dismissTask">关闭</button>
      </div>
      <div class="progress"><i :style="{ width: task.percent + '%' }" /></div>
      <pre v-if="task.out?.length" class="out">{{ task.out.join('\n') }}</pre>
    </div>

    <!-- 服务 Tab：常驻轮询的列表 -->
    <div v-if="tab === 'services'">
      <EmptyState v-if="!auth.supported(CAP.SERVICE_MANAGE)"
        title="当前环境不支持服务管理"
        :reason="auth.capabilities[CAP.SERVICE_MANAGE]?.reason ?? undefined" />
      <div v-else class="card flush svc-card">
        <!-- 首次加载骨架；轮询(silent)不触发，表格不闪骨架 -->
        <div v-if="loading" class="skeleton box" />
        <template v-else>
          <table>
            <colgroup>
              <col class="w-name" /><col class="w-state" /><col class="w-enabled" /><col /><col class="w-acts" />
            </colgroup>
            <thead><tr>
              <th>服务</th><th>状态</th><th class="num">开机自启</th><th>说明</th><th class="acts-col">操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="s in svcs" :key="s.name" class="rowlink" @click="goDetail(s)">
                <td class="svc-name" :title="s.name">
                  {{ s.name }}
                  <span v-if="!s.managed" class="badge badge-warn">未托管</span>
                </td>
                <td><span class="badge" :class="serviceStateBadge(s.state)">{{ serviceStateLabel(s.state) }}</span></td>
                <td class="num">{{ s.enabled ? '是' : '否' }}</td>
                <td class="dim svc-desc">{{ s.description ?? '—' }}</td>
                <td class="acts-col nowrap"><button class="btn-ghost btn-sm">详情 ›</button></td>
              </tr>
              <tr v-if="!svcs.length"><td colspan="5"><EmptyState title="未发现服务" /></td></tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>

    <!-- 软件 Tab：按运维类别分组（Web/数据库/缓存/运行环境/安全），靠任务流/手动刷新 -->
    <div v-else>
      <EmptyState v-if="!auth.supported(CAP.PACKAGE_INSTALL)"
        title="当前环境不支持软件包管理"
        :reason="auth.capabilities[CAP.PACKAGE_INSTALL]?.reason ?? undefined" />
      <template v-else>
        <div v-if="pkgs === null" class="card"><div class="skeleton box" /></div>
        <template v-else>
          <p v-if="pkgNote" class="tip dim">{{ pkgNote }}</p>
          <!-- 已安装软件：按类别分组 -->
          <div v-if="installedByCat.length" class="card" style="margin-bottom:14px">
            <!-- 不再挂「（白名单内 N 个）」：
                 ① "白名单内"是实现概念，用户不关心这个限制条件；
                 ② 总数已被下面每个类别标题的「已装 1/3 」分项表达，更直观且带分母。 -->
            <div class="sec-head">
              <Icon name="database" :size="16" /> 已安装软件
            </div>
            <template v-for="cat in installedByCat" :key="cat.key">
              <div class="cat-head">
                {{ cat.label }}
                <span class="cat-count">已装 {{ cat.items.length }}/{{ cat.pkgs.length }}</span>
              </div>
              <div class="pkg-grid">
                <div v-for="p in cat.items" :key="p.name" class="pkg">
                  <!-- 两行布局：单行放不下"包名 + 长版本号 + 管理器 + 状态 + 两个操作"，
                       而 .pkg-name 是唯一可收缩项，空间不足时被压到 0 → 名称整个消失。
                       故第一行只放包名（独占，ellipsis + title 悬停看全名）与右侧操作图标。 -->
                  <div class="pkg-head">
                    <span class="pkg-name mono" :title="p.name">{{ labelOf(p.name) }}</span>
                    <span class="pkg-actions">
                      <!-- 有对应服务才给管理入口；该软件无从管理时整块不渲染，
                           不给"点了必失败"的按钮（certbot/ufw 之类就没有） -->
                      <button v-if="p.unit" class="btn-ghost btn-sm icon-btn" title="服务管理：状态 / 启停 / 日志 / 配置"
                              @click="goUnit(p.unit)">
                        <Icon name="gear" :size="13" />
                      </button>
                      <!-- 卸载用图标按钮不占横向空间，语义与后果写进 title -->
                      <button class="btn-danger btn-sm icon-btn" :disabled="!canPkg || !!task"
                              :title="`卸载 ${labelOf(p.name)}：从系统移除该软件包（走任务队列）`" @click="askRemove(p.name)">
                        <Icon name="trash" :size="13" />
                      </button>
                    </span>
                  </div>
                  <div class="pkg-meta">
                    <!-- 发行版版本号可以很长（如 8.0.36-0ubuntu0.22.04.1），同样给悬停全值 -->
                    <span v-if="p.version" class="badge" :title="p.version">v{{ p.version }}</span>
                    <span class="badge badge-primary">{{ p.manager }}</span>
                    <!-- 服务状态徽标：随 meta 行一起换行，不再挤占包名空间 -->
                    <span v-if="p.unit" class="badge" :class="serviceStateBadge(p.unit.state)">{{ serviceStateLabel(p.unit.state) }}</span>
                  </div>
                </div>
              </div>
            </template>
            <p class="tip dim" style="margin-top:12px">
              仅允许白名单内的软件包：面板以 root 运行，任意安装等同任意代码执行。卸载走任务队列，进度见顶部任务条与右下角任务面板。
            </p>
          </div>
          <EmptyState v-else title="暂无已安装软件" hint="切换到下方的「安装软件」可添加运维组件" />
          <!-- 可安装软件：按类别分组 -->
          <div v-if="installableByCat.length" class="card">
            <!-- 版本选择已移到「点安装 → 弹窗选版本」，这里不再放总开关：
                 开关在区块右上角容易被看漏，用户会直接点安装装成最新版。 -->
            <div class="sec-head">
              <Icon name="plus" :size="16" /> 安装软件
              <span class="sec-note">点击软件可选择安装版本</span>
            </div>
            <template v-for="cat in installableByCat" :key="cat.key">
              <div class="cat-head">
                {{ cat.label }}
                <span class="cat-count">可选 {{ cat.items.length }}</span>
              </div>
              <div class="pkgs">
                <div v-for="p in cat.items" :key="p" class="pkg-install-row">
                  <button class="btn-ghost" :disabled="!canPkg || !!loadingPkg || !!task"
                          :title="needsExternalSource(p) ? `安装 ${labelOf(p)}：官方仓库通常不含此包，需先在目标机配置第三方软件源，否则安装会失败` : `安装 ${labelOf(p)}（可选择版本）`"
                          @click="askInstall(p)">
                    {{ loadingPkg === p ? '提交中…' : '+ ' + labelOf(p) }}
                    <span v-if="needsExternalSource(p)" class="ext-hint" title="需第三方软件源">需配源</span>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </template>
    </div>


    <ConfirmDialog :open="!!confirmRemove" :title="confirmTitle" :detail="confirmDetail"
                   :confirm-word="confirmWord" danger
                   @confirm="doConfirmed" @cancel="confirmRemove = null" />

    <InstallPackageDialog :open="!!dlgPkg" :name="dlgPkg" :label="labelOf(dlgPkg)"
                          :versions="dlgVersions" :loading="dlgLoading"
                          :external="needsExternalSource(dlgPkg)"
                          @confirm="doInstall" @cancel="closeInstallDlg" />
  </div>
</template>

<style scoped>
.dim { color: var(--c-text-dim); }
.pkgs { display: flex; gap: 8px; flex-wrap: wrap; }
/* 可安装软件：每行就是一个安装按钮（版本选择在弹窗里做）。 */
.pkg-install-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* 区块头的弱提示：「点击软件可选择安装版本」。放在标题右侧、不抢视觉焦点，
   但比原先的「指定版本」开关更贴着操作区，不容易被整体略过。 */
.sec-note { margin-left: auto; font-size: 12.5px; font-weight: 400; color: var(--c-text-dim); }
/* 「需配源」小徽标：跟在安装按钮文字后，提示官方仓库通常不含此包。
   用 inline-flex + 小字号，避免把按钮撑宽导致整行换行错位。 */
.ext-hint { display: inline-flex; align-items: center; margin-left: 6px; padding: 1px 5px;
  font-size: 10.5px; line-height: 1.5; color: var(--c-text-dim);
  border: 1px solid var(--c-border); border-radius: 999px; white-space: nowrap; }
.acts { white-space: nowrap; }

/* 顶部 Tab 已改用全站统一的分段控件 components/TabBar.vue：
   原先本地的 .tabs 是"胶囊 + 橙色填充"，与其它页面的分段控件形状不一致。 */

/* 软件类别小标题：把同类包聚在一起，避免白名单式长列表难扫读 */
.cat-head { display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; color: var(--c-text-dim);
  margin: 14px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--c-border); }
.cat-head:first-of-type { margin-top: 2px; }
/* 类别计数：一眼看出"这类包本机装了几个 / 还剩几个可选"，不用逐个包名去数 */
.cat-count { margin-left: auto; font-size: 11.5px; font-weight: 500;
  color: var(--c-text-dim); background: var(--c-hover); padding: 1px 8px; border-radius: 999px; }

/* 服务表格：固定列宽，避免长单元名(php8.1-fpm/mariadb-server)把右侧列挤出视口。
   类名用 w- 前缀，与单元格自身 class 区分（同进程页范式）。 */
.svc-card { overflow: hidden; }
.svc-card table { table-layout: fixed; }
.svc-card th, .svc-card td { font-size: 13px; }
.svc-card th.num, .svc-card td.num { text-align: right; }
.svc-card th.acts-col, .svc-card td.acts-col { text-align: right; }
col.w-state { width: 96px; }
col.w-enabled { width: 84px; }
col.w-acts { width: 96px; }
.svc-card td.svc-name,
.svc-card td.svc-desc { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 首次加载骨架（scoped，与列表页统一观感） */
.skeleton { background: linear-gradient(90deg, var(--c-hover) 25%, var(--c-glass) 37%, var(--c-hover) 63%); background-size: 400% 100%; animation: svc-sk 1.4s ease infinite; border-radius: var(--radius); }
.box { height: 320px; }
@keyframes svc-sk { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

/* 任务进度条 */
.taskstrip { padding: 12px 16px; margin-bottom: 14px; border-color: var(--c-primary-soft); }
.ts-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ts-head strong { font-size: 13.5px; }
.progress { height: 6px; background: var(--c-hover); border-radius: 3px; overflow: hidden; }
.progress i { display: block; height: 100%; background: var(--c-primary); transition: width .4s; }
.taskstrip .out { margin-top: 10px; }
.out { margin: 0; padding: 12px 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12.5px;
       white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto; }

/* 软件卡片：两行布局（第一行包名 + 操作图标，第二行版本/管理器/状态徽标）。
   此前单行放置时，包名是唯一的可收缩 flex 项，被长版本号挤到 0 宽度 → 名称整个消失。 */
.pkg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 10px; }
.pkg { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
       border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-glass); }
.pkg-head { display: flex; align-items: center; gap: 8px; }
.pkg-actions { display: flex; gap: 6px; flex-shrink: 0; }
/* 图标按钮：卡片里横向空间紧张，操作按钮一律用图标 + title 说明 */
.icon-btn { padding: 4px 7px; }
/* white-space: nowrap 是 ellipsis 生效的前提——缺它时长包名只会换行出第二行，
   而不是显示省略号。 */
.pkg-name { font-size: 13.5px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pkg-meta { display: flex; gap: 6px; flex-wrap: wrap; }

/* 表格行可点 */
tr.rowlink { cursor: pointer; }
tr.rowlink:hover { background: var(--c-hover); }

/* 服务详情已迁到独立页 ServiceDetailView：弹窗相关的样式
   （.mask / .box / .m-tabs / .m-config / .cfg-edit / .switch 等）已随弹窗一并移除，
   留在这里只会让人以为本页还在渲染这些元素。
   注意：注释里不要写 "星号+斜杠" 形式的通配符（如 .m-* ），
   那会提前闭合本注释、让后面的中文变成裸 CSS，导致整个 SFC 编译失败。 */
</style>

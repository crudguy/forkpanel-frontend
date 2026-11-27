<script setup lang="ts">
/**
 * 面板托管的应用（systemd 单元 + 自动反代站点）。
 *
 * 与「网站」页的关系是**投影**：每个启用态应用会自动持有一个同名反向代理站点
 * （上游 = `http://127.0.0.1:<port>`），站点本身仍可在「网站」页改域名/WAF。
 * 应用页只管**进程怎么起**。
 *
 * 能力门控（请求前判定，`auth.can` 与 `auth.supported` 分属两套命名空间）：
 * - 菜单可见：`service.view`（本质就是 systemd 单元托管，后端复用该权限点）
 * - 页内动作：`service.manage`
 * - 建反代站点还需 `webserver.manage` 能力位 + `site.manage` 权限（后端叠加校验）
 */
import { ref, onMounted, computed, watch, nextTick } from 'vue'
import { api, errorText, errorFieldDetail, ValidationError } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, type AppInfo, type AppRuntimeInfo } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import DirectoryPickerDialog from '@/components/DirectoryPickerDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { useModal } from '@/composables/useModal'
import { toast, toastError } from '@/composables/useToast'
import { useAsync } from '@/composables/useAsync'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import { allFieldHints, FIELD_LABELS } from '@/composables/appsFieldGuide'
import { matchFields } from '@/composables/listSearch'
// dirnameOf 此前是本文件私有的第三份父目录实现（尾斜杠输入下会取到自身而非上级），
// 统一走 composables/filePath 的 parentPath。
import { parentPath } from '@/composables/filePath'
import HelpDrawer from '@/components/HelpDrawer.vue'

const auth = useAuthStore()

const modalOpen = ref(false)
function open() { modalOpen.value = true }
function close() { modalOpen.value = false }

/**
 * 目录 / 文件选择器（复用 /files/list 在服务器浏览目录树）。
 * mode='dir' 选工作目录；mode='file' 选启动命令的可执行文件。
 * 同一组件实例按 pickerTarget 分流，避免重复挂载。
 */
const pickerOpen = ref(false)
const pickerMode = ref<'dir' | 'file'>('dir')
const pickerTarget = ref<'workdir' | 'exec'>('workdir')
/** 文件模式着陆点：命令往往是「程序 参数」，取首个 token；绝对路径则展开到父目录。 */
const pickerInitialPath = computed(() => {
  if (pickerTarget.value === 'exec') {
    const first = form.value.execStart.trim().split(/\s+/)[0]
    if (first?.startsWith('/')) return parentPath(first)
  }
  return form.value.workdir || '/'
})
function openWorkdirPicker() { pickerTarget.value = 'workdir'; pickerMode.value = 'dir'; pickerOpen.value = true }
function openExecPicker() { pickerTarget.value = 'exec'; pickerMode.value = 'file'; pickerOpen.value = true }
function onPick(p: string) {
  if (pickerTarget.value === 'workdir') { form.value.workdir = p; clearFieldErr('workdir') }
  else { form.value.execStart = p; clearFieldErr('exec_start') }
  pickerOpen.value = false
}

const apps = ref<AppInfo[]>([])
const runtimes = ref<AppRuntimeInfo[]>([])
/** 已安装的系统包集合——只用于在弹窗里显示「系统包 xxx 未装」，**不做「你没有 X」的断言** */
const installedPkgs = ref<Set<string>>(new Set())
/** 包状态是否可探测（能力位 + 权限点双门控；失败静默降级为不显示） */
const pkgDetectable = ref(false)

const { loading, error, run } = useAsync(true)
const onError = (e: unknown) => { error.value = errorText(e) }
const formError = ref('')
/** 帮助抽屉（A6）：列表卡顶栏右侧的「?」打开，承载「应用 = systemd + 反代站点」的完整说明。
 *  按钮与「新建应用」并列在卡片顶栏最右（参考网站页）；零应用时列表卡不渲染、? 一并隐藏，
 *  但 EmptyState 已给上手引导，更深的说明在抽屉里。 */
const helpOpen = ref(false)

// 全站表格约定：分页 + 排序走 useTableControls，页脚用 <TablePager>。
// 应用表按字段排序：名称/运行时/状态/单元是文本列 → localeCompare 升序；
// 端口是标识型数值（不是"越大越重要"的指标）→ 升序；域名是多值列，拼成串再比；
// 托管是布尔 → 未托管在前。默认按应用名升序。
const appSortCols: SortColumn<AppInfo>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'runtime_label', dir: 'asc', compare: (a, b) => (a.runtime_label ?? '').localeCompare(b.runtime_label ?? '') },
  { key: 'port', dir: 'asc', compare: (a, b) => (a.port ?? 0) - (b.port ?? 0) },
  { key: 'domains', dir: 'asc', compare: (a, b) => (a.domains || []).join(', ').localeCompare((b.domains || []).join(', ')) },
  { key: 'state', dir: 'asc', compare: (a, b) => (a.state ?? '').localeCompare(b.state ?? '') },
  { key: 'unit', dir: 'asc', compare: (a, b) => (a.unit ?? '').localeCompare(b.unit ?? '') },
  { key: 'enabled', dir: 'asc', compare: (a, b) => Number(a.enabled) - Number(b.enabled) },
]
/**
 * 列表本地检索：应用名 / 运行时 / 端口 / 域名 / 单元都是用户定位应用时实际看的值，
 * 全部纳入匹配。纯前端过滤，不发请求——应用是本机托管的有限集合，即时反馈更划算。
 */
const q = ref('')
const filteredApps = computed(() => apps.value.filter(a => matchFields(q.value, [
  a.name, a.runtime_label, String(a.port ?? ''), ...(a.domains ?? []), a.unit, a.state,
])))
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<AppInfo>({
    rows: filteredApps, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' }, columns: appSortCols,
    persistKey: 'apps.list',
  })
/** 改搜索词回第一页：否则「搜到 2 条却停在第 5 页」会先空一屏再被夹回来 */
watch(q, () => { page.value = 1 })

// 系统用户列表（运行用户下拉的真实数据源）：打开应用表单时拉取，失败则退回手填。
const systemUsers = ref<{ name: string; uid: number; login_allowed: boolean }[]>([])
async function loadSystemUsers() {
  try {
    systemUsers.value =
      (await api.get<{ name: string; uid: number; login_allowed: boolean }[]>(API.system.users())) ?? []
  } catch {
    // 拉取失败（权限不足 / 后端未接入）不阻断表单：用户仍可手填任意已存在账号
  }
}
const fieldErrs = ref<Record<string, string>>({})
const errSeq = ref(0)
const busyId = ref<number | null>(null)
const saving = ref(false)
const canManage = computed(() => auth.can('service.manage'))
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
const curRuntime = computed(() => runtimes.value.find(r => r.key === form.value.runtime) ?? null)
/** 每个输入框填什么：运行时相关三项 + 与运行时无关三项（见 composables/appsFieldGuide.ts）。
 *  后端只下发「用途 / 什么时候选」，没下发「这五个框各填什么」——那段靠这里补。 */
const fieldHints = computed(() => allFieldHints(form.value.runtime))
/** 字段名 → 该框填什么。指引就地挂在各输入框下方，不再集中成一块教程：
 *  集中块把「工作目录怎么填」写在「基础」分区里，用户滚到那个框时早看不着了；
 *  且其中「运行用户」「启动命令」两条与字段自身 hint 逐字重复。 */
const fieldHintMap = computed<Record<string, string>>(
  () => Object.fromEntries(fieldHints.value.map(h => [h.field, h.what])),
)

function clearFieldErr(k: string) {
  if (!fieldErrs.value[k]) return
  const next = { ...fieldErrs.value }
  delete next[k]
  fieldErrs.value = next
}
function showErr(msg: string) {
  formError.value = msg
  errSeq.value++
}

// ── 表单模型 ──
function emptyForm() {
  return {
    name: '', runtime: '', workdir: '', execStart: '', runUser: '',
    port: null as number | null, autoRestart: true, enabled: true, domains: '',
    env: [] as { k: string; v: string }[],
  }
}
const form = ref(emptyForm())
const editing = ref<AppInfo | null>(null)
const modalBox = ref<HTMLElement | null>(null)
// 弹窗统一行为：Esc 关闭 + 焦点陷阱 + 关闭后焦点返还。
// modalClose 是**统一关闭出口**（离场动画 + 焦点返还）：X / 点遮罩 / 取消按钮都走它，
// 内部再调 close() 做状态清理。
const { close: modalClose } = useModal(() => modalOpen.value, modalBox, close)

/**
 * 弹窗内的分区导航：与「新增网站」弹窗同款——左侧 rail 点按滚动到分区，滚动时
 * 反向高亮；分区内有字段级错误时 rail 亮红点，用户切到别的分区仍找得到问题在哪。
 * 段名必须如实对应段内字段——此前站点弹窗曾因「安全与性能」里塞着自定义片段这类
 * 名实不符的项，找东西只能靠猜。
 */
const modalBody = ref<HTMLElement | null>(null)
const navSections = [
  { id: 'sec-basic', label: '基础' },
  { id: 'sec-process', label: '进程配置' },
  { id: 'sec-hosting', label: '网站托管' },
  { id: 'sec-env', label: '环境变量' },
] as const
/** 字段 → 所属分区。字段级错误映射回 rail；env${i} 按前缀归入环境变量段。 */
const FIELD_SEC: Record<string, string> = {
  name: 'sec-basic', runtime: 'sec-basic', port: 'sec-basic',
  workdir: 'sec-process', exec_start: 'sec-process', run_user: 'sec-process',
  domains: 'sec-hosting',
}
function fieldSection(key: string): string {
  return FIELD_SEC[key] ?? (key.startsWith('env') ? 'sec-env' : '')
}
const secErrs = computed<Record<string, boolean>>(() => {
  const m: Record<string, boolean> = {}
  for (const k of Object.keys(fieldErrs.value)) {
    const sec = fieldSection(k)
    if (sec) m[sec] = true
  }
  return m
})
const activeSec = ref<string>(navSections[0].id)
/** 点导航后短暂锁住高亮：末尾分区下方内容不足，scrollTo 会被浏览器夹到最大
 *  滚动位置，onBodyScroll 据此又把高亮弹回上一个分区——用户点了却像没点中。 */
let navLockUntil = 0
function scrollToSec(id: string) {
  const body = modalBody.value
  if (!body) return
  const el = body.querySelector<HTMLElement>('#' + id)
  if (!el) return
  body.scrollTo({ top: Math.max(0, el.offsetTop - 14), behavior: 'smooth' })
  activeSec.value = id
  navLockUntil = Date.now() + 600
}
function onBodyScroll() {
  if (Date.now() < navLockUntil) return
  const body = modalBody.value
  if (!body) return
  const top = body.scrollTop + 28
  let cur: string = navSections[0].id
  for (const s of navSections) {
    const el = body.querySelector<HTMLElement>('#' + s.id)
    if (el && el.offsetTop <= top) cur = s.id
  }
  activeSec.value = cur
}
/** 字段出错（前端校验或后端 detail.field）时滚到对应分区并聚焦输入框，不让用户自己找。 */
function revealField(key: string) {
  const sec = fieldSection(key)
  if (sec) activeSec.value = sec
  // 与点导航同理：错误定位滚动的落点未必等于出错分区顶部，锁住高亮别被弹回去
  navLockUntil = Date.now() + 600
  nextTick(() => {
    const body = modalBody.value
    const el = body?.querySelector<HTMLElement>(`[data-f="${key}"]`)
    if (!body || !el) return
    body.scrollTo({ top: Math.max(0, el.offsetTop - 40), behavior: 'smooth' })
    el.querySelector<HTMLElement>('input, select, textarea')?.focus()
  })
}
/** 每次打开都从第一段顶部开始：上次停在哪段不该带进新的一次编辑。 */
watch(modalOpen, (v) => {
  if (!v) return
  nextTick(() => {
    modalBody.value?.scrollTo({ top: 0 })
    activeSec.value = navSections[0].id
  })
})

async function load(silent = false) {
  await run(
    async () => { apps.value = (await api.get<AppInfo[]>(API.apps.list())) ?? [] },
    onError,
    { silent },
  )
}

/**
 * 运行时目录来自**后端**（`/api/v1/apps/catalog`），前端不硬编码语言表。
 * 顺带在此拉一次包状态，用于「系统包未装」提示。
 */
async function loadCatalog() {
  try {
    const r = await api.get<{ runtimes: AppRuntimeInfo[] }>(API.apps.catalog())
    runtimes.value = r?.runtimes ?? []
  } catch { runtimes.value = [] }
  // 包状态是锦上添花：探测失败就静默不显示，不该拖累主流程
  pkgDetectable.value = auth.enabled(CAP.PACKAGE_INSTALL, 'package.manage')
  if (!pkgDetectable.value) return
  try {
    const p = await api.get<{ packages: { name: string }[] }>(API.packages.list())
    installedPkgs.value = new Set((p?.packages ?? []).map(x => x.name))
  } catch { pkgDetectable.value = false }
}

function openCreate() {
  editing.value = null
  form.value = emptyForm()
  // 默认选第一个非 custom 的运行时，省一次点击
  form.value.runtime = runtimes.value.find(r => r.key !== 'custom')?.key ?? ''
  syncRuntimeDefaults()
  fieldErrs.value = {}
  formError.value = ''
  open()
  void loadCatalog()
  void loadSystemUsers()
}

function openEdit(a: AppInfo) {
  editing.value = a
  form.value = {
    name: a.name,
    runtime: a.runtime,
    workdir: a.workdir,
    execStart: a.exec_start,
    runUser: a.run_user ?? '',
    port: a.port,
    autoRestart: a.auto_restart,
    enabled: a.enabled,
    domains: a.domains.join(', '),
    env: a.env.map(([k, v]) => ({ k, v })),
  }
  fieldErrs.value = {}
  formError.value = ''
  open()
  void loadCatalog()
  void loadSystemUsers()
}

/**
 * 切运行时时预填端口与启动命令。
 *
 * **只填空值**——用户手改过的内容不覆盖（与 SitesView 的应用模板同一纪律：
 * 静默吞掉用户输入比不给默认值更难发现）。
 */
function syncRuntimeDefaults() {
  const r = curRuntime.value
  if (!r) return
  if (form.value.port === null || form.value.port === 0) form.value.port = r.default_port || null
  if (!form.value.execStart.trim()) form.value.execStart = r.default_exec
}

function onRuntimeChange() {
  // 显式重置：换语言等于换一套默认值，保留上一个端口只会误导
  form.value.port = curRuntime.value?.default_port || null
  form.value.execStart = curRuntime.value?.default_exec ?? ''
  clearFieldErr('runtime'); clearFieldErr('port'); clearFieldErr('exec_start')
}

function addEnvRow() { form.value.env.push({ k: '', v: '' }) }
function removeEnvRow(i: number) {
  form.value.env.splice(i, 1)
  // 删除行后索引重排，旧 env${i} 错误 key 会错位——统一清空所有 env* 字段错误，
  // 待用户下次保存时再逐字段校验，避免错误提示贴到错误行
  const next = { ...fieldErrs.value }
  for (const k of Object.keys(next)) if (k.startsWith('env')) delete next[k]
  fieldErrs.value = next
}

async function save() {
  saving.value = true
  formError.value = ''
  const errs: Record<string, string> = {}
  try {
    const name = form.value.name.trim()
    const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
    // 前端只做格式提示，后端为准；逐字段收集，一次全标出（不抛第一个就中断）
    if (!name) errs.name = '应用名不能为空'
    if (!form.value.runtime) errs.runtime = '请选择运行时'
    if (!form.value.workdir.trim()) errs.workdir = '工作目录不能为空'
    else if (!form.value.workdir.trim().startsWith('/')) errs.workdir = '工作目录须为绝对路径'
    const exec = form.value.execStart.trim()
    if (!exec) errs.exec_start = '启动命令不能为空'
    else if (exec.split(/\s+/)[0].includes('/') && !exec.startsWith('/')) {
      // 与后端 exec_start_is_valid 同规则：systemd 只接受程序名或绝对路径
      errs.exec_start = 'systemd 不接受 ./app 这类相对路径，请用程序名（app）或绝对路径'
    }
    if (form.value.enabled && !domains.length) errs.domains = '启用态至少需要一个域名（面板据此自动建反代站点）'
    for (const [i, row] of form.value.env.entries()) {
      if (!row.k && !row.v) continue
      if (!row.k) { errs[`env${i}`] = '环境变量名不能为空'; continue }
      if (/[\r\n=]/.test(row.k)) { errs[`env${i}`] = '变量名不能含换行或 ='; continue }
      if (/[\r\n]/.test(row.v)) errs[`env${i}`] = '变量值不能含换行'
    }
    const firstBad = Object.keys(errs)[0]
    if (firstBad) {
      fieldErrs.value = errs
      revealField(firstBad)
      throw new ValidationError('请修正标红的字段')
    }

    const payload = {
      runtime: form.value.runtime,
      workdir: form.value.workdir.trim(),
      exec_start: exec,
      run_user: form.value.runUser.trim() || null,
      env: form.value.env.filter(r => r.k).map(r => [r.k, r.v]) as [string, string][],
      port: form.value.port ?? undefined,
      auto_restart: form.value.autoRestart,
      domains,
      enabled: form.value.enabled,
    }
    if (editing.value) {
      // name 不支持改：它同时是 systemd 单元名片段与站点名，改名等于换单元+换站点
      await api.patch(API.apps.patch(editing.value.id), payload)
    } else {
      await api.post(API.apps.create(), { ...payload, name })
    }
    // ⚠ 提示必须**按实际托管状态**说：停用态压根没建站点，说「已自动建立」是不实描述。
    const wasEditing = !!editing.value
    close()
    await load()
    const managed = form.value.enabled
    toast(
      wasEditing
        ? (managed ? `已更新应用 ${name}` : `已更新应用 ${name}（未托管：站点已撤下、单元已删除）`)
        : (managed ? `已创建应用 ${name}（单元已装、反代站点已下发）` : `已登记应用 ${name}（未托管：未装单元、未建站点）`),
    )
  } catch (e) {
    // 后端 400 的 detail.field 落到对应输入框；其余归入弹窗顶部通用条
    const f = errorFieldDetail(e)
    if (f?.field) {
      fieldErrs.value = { ...fieldErrs.value, [f.field]: f.reason || errorText(e) }
      revealField(f.field)
    }
    showErr(errorText(e))
  } finally {
    saving.value = false
  }
}

async function act(a: AppInfo, action: 'start' | 'stop' | 'restart') {
  busyId.value = a.id
  try {
    await api.post(API.apps.act(a.id), { act: action })
    await load(true)
    toast(`已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'} ${a.name}`)
  } catch (e) {
    toastError(e)
  } finally {
    busyId.value = null
  }
}

async function toggleEnabled(a: AppInfo, val: boolean) {
  busyId.value = a.id
  try {
    await api.patch(API.apps.patch(a.id), { enabled: val })
    await load(true)
    toast(val ? `已托管 ${a.name}（单元已装、反代站点已下发）` : `已停止托管 ${a.name}（撤下站点并删除单元）`)
  } catch (e) {
    toastError(e)
    await load(true) // 失败时回滚开关的真实状态，不靠前端猜
  } finally {
    busyId.value = null
  }
}

/** 待删除应用：存 ref 驱动 ConfirmDialog，避免原生 confirm 阻塞且样式与 .modal 体系割裂。 */
const pendingRemove = ref<AppInfo | null>(null)
function askRemove(a: AppInfo) { pendingRemove.value = a }
async function doRemove() {
  const a = pendingRemove.value
  pendingRemove.value = null
  if (!a) return
  busyId.value = a.id
  try {
    await api.del(API.apps.remove(a.id))
    await load()
    toast(`已删除应用 ${a.name}`)
  } catch (e) {
    toastError(e)
  } finally {
    busyId.value = null
  }
}

/** systemd 状态 → 徽章类。null（探测失败）单独一档，别混成 unknown。
 *  配色走全站统一的 badge-* 彩色药丸（main.css），与 Sites/WAF 一致——
 *  此前这里用 .ok/.warn/.err 文字色工具类配 .badge，得到的是「灰底彩字」而非药丸。 */
function stateBadge(s: string | null): { cls: string; text: string } {
  if (s === null) return { cls: '', text: '—' }
  if (s === 'running') return { cls: 'badge-ok', text: '运行中' }
  if (s === 'failed') return { cls: 'badge-danger', text: '失败' }
  if (s === 'activating' || s === 'deactivating' || s === 'reloading') return { cls: 'badge-info', text: s }
  return { cls: 'dim', text: '已停止' }
}

onMounted(() => { void load(); void loadCatalog(); void loadSystemUsers() })
</script>

<template>
  <div class="view">
    <p v-if="error" class="err-bar" role="alert">
      <Icon name="alert" :size="15" class="ic" /><span>{{ error }}</span>
      <button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button>
    </p>

    <!-- 与网站/WAF/证书页同构：骨架 → 数据卡（工具栏 + 表格）→ 空态自带 #cta。
         工具栏随数据卡渲染；空态下「新建应用」入口由 EmptyState 的 #cta 提供 -->
    <div v-if="loading && !apps.length" class="skeleton box" />
    <div v-else-if="apps.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">
          <template v-if="q.trim()">找到 {{ filteredApps.length }} / 共 {{ apps.length }} 个应用</template>
          <template v-else>共 {{ apps.length }} 个应用</template>
        </span>
        <span class="spacer" />
        <input v-model="q" class="filter" type="search" autocomplete="off" placeholder="搜索名称 / 域名 / 运行时…"
          aria-label="搜索应用" />
        <button v-if="q" class="btn-ghost btn-sm" type="button" title="清空搜索" @click="q = ''">清空</button>
        <HelpBtn title="应用说明" aria-label="应用说明" :expanded="helpOpen" @click="helpOpen = true" />
        <RefreshBtn :disabled="loading || busyId !== null" @click="load()" />
        <button class="btn-primary" :disabled="(!canManage || !webSupported) || busyId !== null"
          :title="canManage ? (webSupported ? '' : '需要 webserver 能力才能建反代站点') : '无 service.manage 权限'"
          @click="openCreate">
          <Icon name="plus" :size="14" /> 新建应用
        </button>
      </div>
      <div class="t-scroll">
      <table class="fixed" v-table-nav>
        <!-- 应用表列宽独立一套（不与站点/证书表共用 class，避免改一处漂一片） -->
        <colgroup>
          <col class="app-name" /><col class="app-rt" /><col class="app-port" /><col class="app-dom" />
          <col class="app-state" /><col class="app-unit" /><col class="app-en" /><col class="app-acts" />
        </colgroup>
        <thead>
          <tr>
            <SortTh label="应用" :active="isSorted('name')" :dir="sortDir" @sort="toggleSort('name')" />
            <SortTh label="运行时" :active="isSorted('runtime_label')" :dir="sortDir" @sort="toggleSort('runtime_label')" />
            <SortTh label="端口" :active="isSorted('port')" :dir="sortDir" @sort="toggleSort('port')" />
            <SortTh label="域名" :active="isSorted('domains')" :dir="sortDir" @sort="toggleSort('domains')" />
            <SortTh label="状态" :active="isSorted('state')" :dir="sortDir" @sort="toggleSort('state')" />
            <SortTh label="单元" :active="isSorted('unit')" :dir="sortDir" @sort="toggleSort('unit')" />
            <SortTh label="托管" :active="isSorted('enabled')" :dir="sortDir" @sort="toggleSort('enabled')" />
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in pageRows" :key="a.id">
            <td class="ellipsis" :title="a.name">{{ a.name }}</td>
            <td class="dim">{{ a.runtime_label }}</td>
            <td class="mono">{{ a.port }}</td>
            <td class="ellipsis" :title="a.domains.join(', ')">
              {{ a.domains.length ? a.domains.join(', ') : '—' }}
            </td>
            <td>
              <span class="badge" :class="stateBadge(a.state).cls">{{ stateBadge(a.state).text }}</span>
            </td>
            <td class="mono ellipsis dim" :title="a.unit">{{ a.unit }}</td>
            <td>
              <label class="switch" :title="a.enabled ? '点击停止托管（撤站点 + 删单元）' : '点击托管（装单元 + 建站点）'">
                <input type="checkbox" :checked="a.enabled" :disabled="!canManage || busyId === a.id"
                  @change="toggleEnabled(a, ($event.target as HTMLInputElement).checked)" />
                <i />
              </label>
            </td>
            <td class="col-actions">
              <button class="btn-ghost btn-sm" :disabled="!canManage || !a.enabled || busyId === a.id"
                :title="!canManage ? '无 service.manage 权限' : (!a.enabled ? '先启用托管才能启动' : '启动')"
                @click="act(a, 'start')"><Icon name="play" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!canManage || !a.enabled || busyId === a.id"
                :title="!canManage ? '无 service.manage 权限' : (!a.enabled ? '应用未托管，无法停止' : '停止')"
                @click="act(a, 'stop')"><Icon name="stop" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!canManage || !a.enabled || busyId === a.id"
                :title="!canManage ? '无 service.manage 权限' : (!a.enabled ? '先启用托管才能重启' : '重启')"
                @click="act(a, 'restart')"><Icon name="refresh" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!canManage || busyId === a.id"
                :title="canManage ? '编辑' : '无 service.manage 权限'" @click="openEdit(a)">
                <Icon name="edit" :size="13" />
              </button>
              <button class="btn-ghost btn-sm" :disabled="!canManage || busyId === a.id"
                :title="canManage ? '删除' : '无 service.manage 权限'" @click="askRemove(a)">
                <Icon name="trash" :size="13" />
              </button>
            </td>
          </tr>
          <tr v-if="!pageRows.length"><td colspan="8">
            <EmptyState :title="`没有匹配「${q.trim()}」的应用`"
              hint="换个关键词，或清空搜索查看全部应用。">
              <template #cta>
                <button class="btn-ghost" type="button" @click="q = ''">清空搜索</button>
              </template>
            </EmptyState>
          </td></tr>
        </tbody>
      </table>
      </div>
      <!-- 分页脚：放在 .t-scroll 之外、同一张卡片内；可见性由组件自判 -->
      <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
        @update:page="gotoPage" @update:size="changeSize" />
    </div>
    <EmptyState v-else title="暂无托管应用"
      hint="点「新建应用」登记一个进程：选运行时、填工作目录与启动命令，面板会装好 systemd 单元并自动建好反代站点">
      <template #cta>
        <button class="btn-primary" :disabled="(!canManage || !webSupported) || busyId !== null"
          :title="canManage ? (webSupported ? '' : '需要 webserver 能力才能建反代站点') : '无 service.manage 权限'"
          @click="openCreate">
          <Icon name="plus" :size="13" /> 新建应用
        </button>
      </template>
    </EmptyState>

    <!-- 新建 / 编辑弹窗 -->
    <Teleport to="body">
    <div v-if="modalOpen" class="mask" @click.self="modalClose">
      <div ref="modalBox" class="modal wide app-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">{{ editing ? `编辑应用 ${editing.name}` : '新建应用' }}</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
            <Icon name="close" :size="16" />
          </button>
          <!-- 通用错误条放进标题行：与「新增网站」同款——标题行整体吸顶，
               滚到任何分区都看得见，也不会和第二个 sticky 元素互相盖。 -->
          <p v-if="formError" :key="'fe' + errSeq" class="err-bar form-msg" role="alert">
            <Icon name="alert" :size="15" class="ic" /><span>{{ formError }}</span>
          </p>
        </div>

        <div class="modal-mid">
          <nav class="nav-rail" aria-label="配置分区">
            <button v-for="s in navSections" :key="s.id" type="button" class="nav-item"
              :class="{ active: activeSec === s.id, 'has-err': secErrs[s.id] }"
              :title="secErrs[s.id] ? '该分区内有字段未填对' : s.label"
              @click="scrollToSec(s.id)">{{ s.label }}<i v-if="secErrs[s.id]" class="nav-dot" aria-hidden="true" /></button>
          </nav>

          <div ref="modalBody" class="modal-body" @scroll="onBodyScroll">
            <!-- ① 基础：这是什么应用、跑在哪个端口。关键三项集中在首屏。 -->
            <section class="sector" id="sec-basic">
              <h4 class="sector-h">基础<small>名称 · 运行时 · 端口</small></h4>
              <p v-if="editing" class="hint-note">
                <Icon name="info" :size="14" class="ic" />
                <span>应用名<b>不支持修改</b>——它同时是 systemd 单元名片段与反代站点名，改名等于换单元 + 换站点。</span>
              </p>

              <label class="blk" :class="{ 'has-err': fieldErrs.name }" data-f="name">
                名称
                <input v-model="form.name" :disabled="!!editing" placeholder="my-blog"
                  :aria-invalid="!!fieldErrs.name" @input="clearFieldErr('name')" />
                <span v-if="fieldHintMap[FIELD_LABELS.name]" class="fg-hint">{{ fieldHintMap[FIELD_LABELS.name] }}</span>
                <span v-if="fieldErrs.name" class="field-err">{{ fieldErrs.name }}</span>
              </label>

              <label class="blk" :class="{ 'has-err': fieldErrs.runtime }" data-f="runtime">
                运行时
                <select v-model="form.runtime" :aria-invalid="!!fieldErrs.runtime" @change="onRuntimeChange">
                  <option value="" disabled>请选择…</option>
                  <option v-for="r in runtimes" :key="r.key" :value="r.key">{{ r.label }}</option>
                </select>
                <span v-if="fieldErrs.runtime" class="field-err">{{ fieldErrs.runtime }}</span>
              </label>

              <!-- 运行时说明：先讲「它是干什么的 / 什么时候该选它」（用户选运行时真正
                   需要的决策信息），再讲「启动命令 / 构建步骤 / 系统包状态」这些操作细节。
                   顺序刻意如此：原先这些内容挤在一行里，用户要先跳过一堆命令才能读到
                   「典型框架」，等于把最有用的信息埋了。 -->
              <div v-if="curRuntime" class="hint-note rt-note">
                <Icon name="info" :size="14" class="ic" />
                <span>
                  <b class="rt-purpose">{{ curRuntime.purpose }}</b>
                  <br />什么时候选它：{{ curRuntime.choose_when }}
                  <br /><span class="rt-dim">典型框架 {{ curRuntime.typical }}；</span>启动命令 <b>{{ curRuntime.default_exec || '（需自行填写）' }}</b>。
                  <template v-if="curRuntime.runtime_pkg && pkgDetectable">系统包
                    <b :class="{ 'is-warn': !installedPkgs.has(curRuntime.runtime_pkg) }">
                      {{ curRuntime.runtime_pkg }}{{ installedPkgs.has(curRuntime.runtime_pkg) ? ' 已装' : ' 未装，可到「软件」页装' }}
                    </b>。</template>
                  <br /><span class="rt-dim">构建步骤：{{ curRuntime.build_hint }}</span>
                </span>
              </div>

              <label class="blk" :class="{ 'has-err': fieldErrs.port }" data-f="port">
                监听端口
                <input v-model.number="form.port" type="number" min="1" max="65535" placeholder="3000"
                  :aria-invalid="!!fieldErrs.port" @input="clearFieldErr('port')" />
                <span v-if="fieldHintMap[FIELD_LABELS.port]" class="fg-hint">{{ fieldHintMap[FIELD_LABELS.port] }}</span>
                <span v-if="fieldErrs.port" class="field-err">{{ fieldErrs.port }}</span>
              </label>
            </section>

            <!-- ② 进程配置：进程怎么起、以什么身份起、崩了要不要拉起来。 -->
            <section class="sector" id="sec-process">
              <h4 class="sector-h">进程配置<small>工作目录 · 启动命令 · 运行用户</small></h4>

              <label class="blk full" :class="{ 'has-err': fieldErrs.workdir }" data-f="workdir">
                工作目录（绝对路径，须已存在）
                <div class="dir-row">
                  <input v-model="form.workdir" placeholder="/opt/blog" :aria-invalid="!!fieldErrs.workdir"
                    @input="clearFieldErr('workdir')" />
                  <button type="button" class="btn-ghost btn-sm" @click="openWorkdirPicker">
                    <Icon name="folder" :size="13" /> 浏览…
                  </button>
                </div>
                <span v-if="fieldHintMap[FIELD_LABELS.workdir]" class="fg-hint">{{ fieldHintMap[FIELD_LABELS.workdir] }}</span>
                <span v-if="fieldErrs.workdir" class="field-err">{{ fieldErrs.workdir }}</span>
              </label>

              <label class="blk full" :class="{ 'has-err': fieldErrs.exec_start }" data-f="exec_start">
                启动命令（systemd ExecStart）
                <div class="dir-row">
                  <input v-model="form.execStart" placeholder="app 或 /opt/blog/app"
                    :aria-invalid="!!fieldErrs.exec_start" @input="clearFieldErr('exec_start')" />
                  <button type="button" class="btn-ghost btn-sm" @click="openExecPicker">
                    <Icon name="file" :size="13" /> 浏览…
                  </button>
                </div>
                <span class="hint-inline">支持「程序名」（如 <code>node</code>）或绝对路径（如 <code>/opt/blog/app</code>）；
                  带参数时写 <code>node server.js --port 3000</code>，浏览只选程序本体。</span>
                <span v-if="fieldHintMap[FIELD_LABELS.execStart]" class="fg-hint">{{ fieldHintMap[FIELD_LABELS.execStart] }}</span>
                <span v-if="fieldErrs.exec_start" class="field-err">{{ fieldErrs.exec_start }}</span>
              </label>

              <label class="blk" :class="{ 'has-err': fieldErrs.run_user }" data-f="run_user">
                运行用户
                <input v-model="form.runUser" placeholder="留空则自动分配 site-&lt;应用名&gt;" list="app-run-user-suggest"
                  :aria-invalid="!!fieldErrs.run_user" @input="clearFieldErr('run_user')" />
                <datalist id="app-run-user-suggest">
                  <option v-for="u in systemUsers" :key="u.name" :value="u.name"
                    :label="`${u.name} (uid ${u.uid})${u.login_allowed ? '' : ' · 禁止登录'}`" />
                </datalist>
                <span class="hint-inline">留空由面板创建 <b>系统用户</b> <code>site-&lt;应用名&gt;</code>
                  （禁止登录），应用不再以 root 运行；下拉列出本机真实系统账户，也可手填任意已存在账号，
                  填错名字会报错而不会凭空建号。</span>
                <span v-if="fieldErrs.run_user" class="field-err">{{ fieldErrs.run_user }}</span>
              </label>

              <div class="blk full row-inline">
                <input id="app-restart" v-model="form.autoRestart" type="checkbox" style="width: auto" />
                <span>崩溃自动重启（systemd Restart=always）</span>
              </div>
            </section>

            <!-- ③ 网站托管：域名与托管开关是一对——「托管」开着就必须有域名，放同段才讲得通。 -->
            <section class="sector" id="sec-hosting">
              <h4 class="sector-h">网站托管<small>域名 · 反代站点</small></h4>

              <label class="blk full" :class="{ 'has-err': fieldErrs.domains }" data-f="domains">
                域名（逗号分隔，面板据此自动建反代站点）
                <input v-model="form.domains" placeholder="blog.example.com, www.blog.example.com"
                  :aria-invalid="!!fieldErrs.domains" @input="clearFieldErr('domains')" />
                <span v-if="fieldHintMap[FIELD_LABELS.domains]" class="fg-hint">{{ fieldHintMap[FIELD_LABELS.domains] }}</span>
                <span v-if="fieldErrs.domains" class="field-err">{{ fieldErrs.domains }}</span>
              </label>

              <div class="blk full row-inline">
                <input id="app-env-toggle" v-model="form.enabled" type="checkbox" style="width: auto" />
                <span>托管（勾选 = 装 systemd 单元 + 下发反代站点；取消 = 撤站点并删单元）</span>
              </div>
            </section>

            <!-- ④ 环境变量：刻意做成「键值对列表」而非 textarea ——
                 面板**不加密存储**这些值，一 textarea 反而容易让人误以为可以放密码。 -->
            <section class="sector" id="sec-env">
              <h4 class="sector-h">环境变量<small>可选</small></h4>
              <div class="blk full env-box">
                <div class="env-head">
                  <span>环境变量（可选）</span>
                  <button class="btn-ghost btn-sm" @click="addEnvRow"><Icon name="plus" :size="13" /> 添加</button>
                </div>
                <p class="env-warn">
                  <Icon name="alert" :size="13" class="ic" />
                  <span>面板<b>不加密</b>存储环境变量，<b>请勿放密码 / 密钥</b>。敏感配置请在应用代码里读自己的配置文件。</span>
                </p>
                <div v-for="(row, i) in form.env" :key="i" class="env-row" :data-f="'env' + i">
                  <input v-model="row.k" placeholder="KEY" @input="clearFieldErr(`env${i}`)" />
                  <input v-model="row.v" placeholder="值" @input="clearFieldErr(`env${i}`)" />
                  <button class="btn-ghost btn-sm" title="删除该行" @click="removeEnvRow(i)">
                    <Icon name="trash" :size="13" />
                  </button>
                  <span v-if="fieldErrs[`env${i}`]" class="field-err">{{ fieldErrs[`env${i}`] }}</span>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="modalClose">取消</button>
            <button class="btn-primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : (editing ? '保存' : '创建并托管') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Teleport>

    <DirectoryPickerDialog :open="pickerOpen" :mode="pickerMode" :initial-path="pickerInitialPath"
      @select="onPick" @cancel="pickerOpen = false" />

    <ConfirmDialog :open="!!pendingRemove" danger title="删除应用"
      :detail="`将同时：撤下反向代理站点、停止并删除 systemd 单元 ${pendingRemove?.unit ?? ''}、删除面板登记。（不会删除你的项目代码与构建产物）`"
      :confirm-word="pendingRemove ? pendingRemove.name : ''"
      @confirm="doRemove" @cancel="pendingRemove = null" />

    <!-- 完整说明收进帮助抽屉（A6）：头部「?」打开。
         浮层组件放链尾：**不得**插在 v-if / v-else 链中间（会打断相邻性，模板编译直接报错）。 -->
    <HelpDrawer :open="helpOpen" title="应用说明" @close="helpOpen = false">
      <p>一个应用包含面板托管的应用进程，以及一个自动配置的访问站点。<b>代码构建和依赖安装需你自己在项目目录完成</b>，面板只负责启动进程。</p>
      <h4>与「网站」页的关系</h4>
      <p>启用应用时会自动生成一个同名站点；域名、防护等站点设置仍可在「网站」页修改。应用页只管<b>进程如何启动</b>。</p>
      <h4>托管开关</h4>
      <p>开启即创建运行服务并建站，关闭则撤掉站点和服务。<b>不会删除你的项目代码与构建产物。</b></p>
      <h4>运行用户</h4>
      <p>留空时面板会创建专用账号，以非 root 身份运行应用。</p>
    </HelpDrawer>
  </div>
</template>

<style scoped>
/* 运行时说明块：首行（用途 / 什么时候选它）用正文色强调，命令与构建步骤降为次级色。
   层级靠颜色而非字号——这一块要在表单里常驻，字号一变大就成了页面主体。 */
.rt-note .rt-purpose { color: var(--c-text); font-weight: 600; }
.rt-note .rt-dim { color: var(--c-text-dim); }
/* 字段指引不再集中成一块：原「照这个填（共 6 项）」块在 508px 高的弹窗里吃掉 184px
   （行内排版前是 248px），且「运行用户 / 启动命令」两条与该字段自身 hint 逐字重复。
   现已按字段就地挂在输入框下方（.fg-hint），内容仍由 composables/appsFieldGuide.ts
   单一维护。 */
/* 应用表列宽：名称唯一弹性列（吸收剩余），其余按实测控件/取值定宽——与 Sites/Certs
   同款「实测 px + 弹性列」范式。此前用百分比（14%/8%/…），按 SitesView 注释会
   在窄屏把名称列压到 29px、把弹性列挤成 0，故统一改 px。 */
.app-name { width: auto; }
.app-rt   { width: 78px; }
.app-port { width: 70px; }
.app-dom  { width: 220px; }
.app-state{ width: 78px; }
.app-unit { width: 200px; }
.app-en   { width: 70px; }
.app-acts { width: 200px; }
/* 字段下的补充说明（非错误）。与 .hint-note 不同：没有底色/图标，
   只是把「这个字段留空会发生什么」讲清楚，避免用户误以为留空 = root。 */
.hint-inline { display: block; margin-top: 4px; font-size: var(--fs-12); line-height: 1.6;
  color: var(--c-text-dim); }
.hint-inline b { font-weight: 500; color: var(--c-text); }
.hint-inline code { font-size: var(--fs-12); padding: 0 3px; border-radius: var(--radius-chip);
  background: var(--c-surface-2); border: 1px solid var(--c-border); }
/* 5 个操作按钮必须**单行**：已抽到公共 .col-actions（main.css），此处不再私有重抄 */
/* 字段红框：字段已搬进 .modal-body 的分区，旧的 `.modal > label` 直接子选择器
   随结构重构失效——判据必须指向被检查的那份 DOM，不能留一条恒不命中的死规则。 */
.app-modal .modal-body .blk.has-err input,
.app-modal .modal-body .blk.has-err select { border-color: var(--c-danger); }

/* 通用错误条放进标题行：标题行本身吸顶，这里只管排布（独占第二行），
   不再另起一个 sticky 元素与它互相盖。 */
.app-modal > .modal-head > .form-msg { flex-basis: 100%; margin: 8px 0 0; }
/* .err-bar / .field-err 已提到 main.css 公共规则（此前这里与 SitesView 各抄一份，
   且此处少了抖动动画和图标配色，两条错误条长得不一样） */

/* 环境变量区 */
.env-box { display: flex; flex-direction: column; gap: 8px; }
.env-head { display: flex; align-items: center; justify-content: space-between; }
.env-warn {
  display: flex; gap: 6px; align-items: flex-start; margin: 0;
  font-size: var(--fs-12-5); color: var(--c-warn); line-height: 1.55;
}
.env-warn .ic { flex: none; margin-top: 2px; }
.env-row { display: flex; gap: 8px; align-items: flex-start; }
.env-row .btn-sm { flex: none; }
.env-row .field-err { flex-basis: 100%; }

.is-warn { color: var(--c-warn); }

/* ── 应用弹窗：左侧分区导航 + 右部分区滚动 ──────────────────────────────
   与「新增网站」弹窗（SiteFormDialog）同款交互：rail 点按平滑滚到分区、滚动
   反向高亮、出错分区亮红点。派生式样挂在 .app-modal 上，不改站点弹窗的样式域。
   ⚠️ 分区内的字段**不要搬进子组件**：跨列 grid-column 靠本组件 scoped 的 `>`
   选择器，Vue 3.5 不给子组件根节点补父级 data-v，搬走后跨列规则静默全废。 */
.modal.wide.app-modal {
  width: min(1080px, 100%);
  height: min(90vh, 900px);
  max-height: 96vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  grid-template-columns: 1fr;
  padding: 0;
  /* 公共 .modal-head/.modal-foot 用这两个变量的负值外扩补背景；padding 归零后
     必须同步归零，否则标题行被推出容器、被 overflow:hidden 裁掉。 */
  --modal-py: 0;
  --modal-px: 0;
  overflow: hidden;
}
.modal.wide.app-modal > .modal-head { grid-row: 1; margin: 0; padding: 14px 22px 12px;
  border-bottom: 1px solid var(--c-border); }
.modal.wide.app-modal > .modal-mid { grid-row: 2; display: flex; min-height: 0; }
.modal.wide.app-modal > .modal-foot { grid-row: 3; position: static; margin: 0; padding: 12px 22px;
  background: var(--c-surface-2); border-top: 1px solid var(--c-border); }
.modal.wide.app-modal > .modal-foot .modal-actions { position: static; margin: 0; padding: 0;
  border-top: 0; background: none; }
.app-modal .nav-rail {
  width: 176px; flex: none; overflow-y: auto; border-right: 1px solid var(--c-border);
  padding: 14px 10px; background: var(--c-surface-2);
  display: flex; flex-direction: column; gap: 2px;
}
.app-modal .nav-item {
  position: relative; display: block; width: 100%; text-align: left;
  border: 0; background: none; cursor: pointer;
  padding: 8px 10px; border-radius: var(--radius-xs);
  font: inherit; font-size: var(--fs-13); color: var(--c-text);
}
.app-modal .nav-item:hover { background: var(--c-hover); }
.app-modal .nav-item.active { background: var(--c-primary-soft); color: var(--c-primary); font-weight: 600; }
.app-modal .nav-item.has-err { color: var(--c-danger); }
.app-modal .nav-dot { position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: var(--c-danger); }
.app-modal .modal-body { flex: 1; min-width: 0; min-height: 0; overflow-y: auto;
  position: relative; padding: 18px 22px 8px; }
.app-modal .modal-body .sector { max-width: 900px; margin: 0 auto 22px;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px; row-gap: 14px; align-items: start; }
.app-modal .modal-body .sector + .sector { border-top: 1px solid var(--c-border); padding-top: 20px; }
/* main.css 的 `.modal .blk { margin: 12px 0 }` 是简写：只覆盖 bottom 会让 top
   与 row-gap 叠加成 26px（设计值 14），故整条 margin 归零。 */
.app-modal .modal-body .sector > .blk { margin: 0; }
/* 字段级填写指引：12px 次色，紧贴输入框（.blk 是 block，无需额外间距） */
.fg-hint { display: block; margin-top: 5px; font-size: var(--fs-12); line-height: 1.5; color: var(--c-text-mute); }
.app-modal .modal-body .sector > .blk.full,
.app-modal .modal-body .sector > .row-inline,
.app-modal .modal-body .sector > .hint-note,
.app-modal .modal-body .sector > .env-box { grid-column: 1 / -1; }
.app-modal .modal-body .sector-h { grid-column: 1 / -1; margin: 0; color: var(--c-text);
  font-size: var(--fs-14); font-weight: 700; }
.app-modal .modal-body .sector-h small { margin-left: 8px; font-size: var(--fs-12);
  font-weight: 400; color: var(--c-text-dim); }
/* 窄窗（横向空间被 rail 吃掉）与矮窗（纵向双层滚动路径太长）：rail 转顶部横向页签 */
@media (max-width: 720px), (max-height: 600px) {
  .modal.wide.app-modal > .modal-mid { flex-direction: column; }
  .app-modal .nav-rail { width: auto; flex: none; flex-direction: row; overflow-x: auto;
    border-right: 0; border-bottom: 1px solid var(--c-border); padding: 8px 10px; }
  .app-modal .nav-item { width: auto; white-space: nowrap; padding: 6px 12px; }
  .app-modal .modal-body .sector { grid-template-columns: 1fr; }
}
</style>

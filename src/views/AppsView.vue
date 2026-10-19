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
import { ref, onMounted, computed } from 'vue'
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
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { useAsync } from '@/composables/useAsync'
import { allFieldHints } from '@/composables/appsFieldGuide'
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
function dirnameOf(p: string) {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
/** 文件模式着陆点：命令往往是「程序 参数」，取首个 token；绝对路径则展开到父目录。 */
const pickerInitialPath = computed(() => {
  if (pickerTarget.value === 'exec') {
    const first = form.value.execStart.trim().split(/\s+/)[0]
    if (first?.startsWith('/')) return dirnameOf(first)
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
    if (Object.keys(errs).length) { fieldErrs.value = errs; throw new ValidationError('请修正标红的字段') }

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
    toast(errorText(e), 'err')
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
    toast(errorText(e), 'err')
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
    toast(errorText(e), 'err')
  } finally {
    busyId.value = null
  }
}

/** systemd 状态 → 徽章类。null（探测失败）单独一档，别混成 unknown。 */
function stateBadge(s: string | null): { cls: string; text: string } {
  if (s === null) return { cls: 'dim', text: '—' }
  if (s === 'running') return { cls: 'ok', text: '运行中' }
  if (s === 'failed') return { cls: 'err', text: '失败' }
  if (s === 'activating' || s === 'deactivating' || s === 'reloading') return { cls: 'warn', text: s }
  return { cls: 'dim', text: '已停止' }
}

onMounted(() => { void load(); void loadCatalog(); void loadSystemUsers() })
</script>

<template>
  <div class="wrap">
    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button></p>

    <div class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ apps.length }} 个应用</span>
        <span class="spacer" />
        <HelpBtn title="应用说明" aria-label="应用说明" :expanded="helpOpen" @click="helpOpen = true" />
        <RefreshBtn :disabled="loading || busyId !== null" @click="load" />
        <button class="btn-primary btn-sm" :disabled="(!canManage || !webSupported) || busyId !== null"
          :title="canManage ? (webSupported ? '' : '需要 webserver 能力才能建反代站点') : '无 service.manage 权限'"
          @click="openCreate">
          <Icon name="plus" :size="14" /> 新建应用
        </button>
      </div>
      <!-- 顶栏固定：零应用也常驻（参考网站页）；其下按状态显示骨架 / 表格 / 空态 -->
      <div v-if="loading && !apps.length" class="skeleton box" />
      <div v-else-if="apps.length" class="t-scroll">
      <table class="fixed" v-table-nav>
        <!-- 应用表列宽独立一套（不与站点/证书表共用 class，避免改一处漂一片） -->
        <colgroup>
          <col class="app-name" /><col class="app-rt" /><col class="app-port" /><col class="app-dom" />
          <col class="app-state" /><col class="app-unit" /><col class="app-en" /><col class="app-acts" />
        </colgroup>
        <thead>
          <tr>
            <th>应用</th><th>运行时</th><th>端口</th><th>域名</th>
            <th>状态</th><th>单元</th><th>托管</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in apps" :key="a.id">
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
            <td class="app-acts-cell">
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busyId === a.id" :title="!a.enabled ? '先启用托管才能启动' : '启动'"
                @click="act(a, 'start')"><Icon name="play" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busyId === a.id" :title="!a.enabled ? '应用未托管，无法停止' : '停止'"
                @click="act(a, 'stop')"><Icon name="stop" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busyId === a.id" :title="!a.enabled ? '先启用托管才能重启' : '重启'"
                @click="act(a, 'restart')"><Icon name="refresh" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="busyId === a.id" title="编辑" @click="openEdit(a)">
                <Icon name="edit" :size="13" />
              </button>
              <button class="btn-ghost btn-sm" :disabled="busyId === a.id" title="删除" @click="askRemove(a)">
                <Icon name="trash" :size="13" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <EmptyState v-else title="暂无托管应用"
        hint="点「新建应用」登记一个进程：选运行时、填工作目录与启动命令，面板会装好 systemd 单元并自动建好反代站点" />
    </div>

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="modalOpen" class="mask" @click.self="modalClose">
      <div ref="modalBox" class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">{{ editing ? `编辑应用 ${editing.name}` : '新建应用' }}</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
            <Icon name="close" :size="16" />
          </button>
        </div>

        <p v-if="editing" class="hint-note">
          <Icon name="info" :size="14" class="ic" />
          <span>应用名<b>不支持修改</b>——它同时是 systemd 单元名片段与反代站点名，改名等于换单元 + 换站点。</span>
        </p>

        <!-- 通用错误条：sticky 吸顶（弹窗内容比视口高时，底部条会滚出视野） -->
        <p v-if="formError" :key="'fe' + errSeq" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ formError }}</span>
        </p>

        <label class="blk" data-f="name">
          名称
          <input v-model="form.name" :disabled="!!editing" placeholder="my-blog" />
          <span v-if="fieldErrs.name" class="field-err">{{ fieldErrs.name }}</span>
        </label>

        <label class="blk" data-f="runtime">
          运行时
          <select v-model="form.runtime" @change="onRuntimeChange">
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

        <!-- 各输入框填什么：后端只下发「这运行时是什么 / 何时选」，缺「这几个框各填什么」。
             用户选完运行时对着五个输入框仍在猜，尤其「工作目录须已存在」与「启动命令写
             程序名还是绝对路径」——后端的字段错误要提交后才出现，事前没有提示。 -->
        <div v-if="fieldHints.length" class="hint-note fg-note">
          <Icon name="edit" :size="14" class="ic" />
          <span>
            <b>照这个填</b>（共 {{ fieldHints.length }} 项）
            <span v-for="(h, i) in fieldHints" :key="h.field" class="fg-item">
              <span v-if="i > 0" class="fg-sep">·</span><b class="fg-f">{{ h.field }}</b>{{ '：' }}{{ h.what }}
            </span>
          </span>
        </div>

        <label class="blk full" :class="{ 'has-err': fieldErrs.workdir }" data-f="workdir">
          工作目录（绝对路径，须已存在）
          <div class="dir-row">
            <input v-model="form.workdir" placeholder="/opt/blog" :aria-invalid="!!fieldErrs.workdir"
              @input="clearFieldErr('workdir')" />
            <button type="button" class="btn-ghost btn-sm" @click="openWorkdirPicker">
              <Icon name="folder" :size="13" /> 浏览…
            </button>
          </div>
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
          <span v-if="fieldErrs.exec_start" class="field-err">{{ fieldErrs.exec_start }}</span>
        </label>

        <label class="blk" data-f="port">
          监听端口
          <input v-model.number="form.port" type="number" min="1" max="65535" placeholder="3000" />
          <span v-if="fieldErrs.port" class="field-err">{{ fieldErrs.port }}</span>
        </label>

        <label class="blk" data-f="run_user">
          运行用户
          <input v-model="form.runUser" placeholder="留空则自动分配 site-&lt;应用名&gt;" list="app-run-user-suggest" />
          <datalist id="app-run-user-suggest">
            <option v-for="u in systemUsers" :key="u.name" :value="u.name"
              :label="`${u.name} (uid ${u.uid})${u.login_allowed ? '' : ' · 禁止登录'}`" />
          </datalist>
          <span class="hint-inline">留空由面板创建 <b>系统用户</b> <code>site-&lt;应用名&gt;</code>
            （禁止登录），应用不再以 root 运行；下拉列出本机真实系统账户，也可手填任意已存在账号，
            填错名字会报错而不会凭空建号。</span>
          <span v-if="fieldErrs.run_user" class="field-err">{{ fieldErrs.run_user }}</span>
        </label>

        <label class="blk full" data-f="domains">
          域名（逗号分隔，面板据此自动建反代站点）
          <input v-model="form.domains" placeholder="blog.example.com, www.blog.example.com" />
          <span v-if="fieldErrs.domains" class="field-err">{{ fieldErrs.domains }}</span>
        </label>

        <div class="blk full row-inline">
          <input id="app-env-toggle" v-model="form.enabled" type="checkbox" style="width: auto" />
          <span>托管（勾选 = 装 systemd 单元 + 下发反代站点；取消 = 撤站点并删单元）</span>
        </div>

        <div class="blk full row-inline">
          <input id="app-restart" v-model="form.autoRestart" type="checkbox" style="width: auto" />
          <span>崩溃自动重启（systemd Restart=always）</span>
        </div>

        <!-- 环境变量：刻意做成「键值对列表」而非 textarea ——
             面板**不加密存储**这些值，一 textarea 反而容易让人误以为可以放密码。 -->
        <div class="blk full env-box">
          <div class="env-head">
            <span>环境变量（可选）</span>
            <button class="btn-ghost btn-sm" @click="addEnvRow"><Icon name="plus" :size="13" /> 添加</button>
          </div>
          <p class="env-warn">
            <Icon name="alert" :size="13" class="ic" />
            <span>面板<b>不加密</b>存储环境变量，<b>请勿放密码 / 密钥</b>。敏感配置请在应用代码里读自己的配置文件。</span>
          </p>
          <div v-for="(row, i) in form.env" :key="i" class="env-row">
            <input v-model="row.k" placeholder="KEY" @input="clearFieldErr(`env${i}`)" />
            <input v-model="row.v" placeholder="值" @input="clearFieldErr(`env${i}`)" />
            <button class="btn-ghost btn-sm" title="删除该行" @click="removeEnvRow(i)">
              <Icon name="trash" :size="13" />
            </button>
            <span v-if="fieldErrs[`env${i}`]" class="field-err">{{ fieldErrs[`env${i}`] }}</span>
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

    <DirectoryPickerDialog :open="pickerOpen" :mode="pickerMode" :initial-path="pickerInitialPath"
      @select="onPick" @cancel="pickerOpen = false" />

    <ConfirmDialog :open="!!pendingRemove" danger title="删除应用"
      :detail="`将同时：撤下反向代理站点、停止并删除 systemd 单元 ${pendingRemove?.unit ?? ''}、删除面板登记。（不会删除你的项目代码与构建产物）`"
      :confirm-word="pendingRemove ? pendingRemove.name : ''"
      @confirm="doRemove" @cancel="pendingRemove = null" />

    <!-- 完整说明收进帮助抽屉（A6）：头部「?」打开。
         浮层组件放链尾：**不得**插在 v-if / v-else 链中间（会打断相邻性，模板编译直接报错）。 -->
    <HelpDrawer :open="helpOpen" title="应用说明" @close="helpOpen = false">
      <p>每个应用 = 一个由面板用 systemd 托管的进程 + 一个自动维护的反向代理站点（上游 <code>http://127.0.0.1:&lt;端口&gt;</code>）。<b>构建与依赖安装需你自己在项目目录完成</b>——面板只负责把进程拉起来。</p>
      <h4>与「网站」页的关系</h4>
      <p>应用是<b>投影</b>：每个启用态应用会自动持有一个同名反向代理站点，站点本身仍可在「网站」页改域名 / WAF。应用页只管<b>进程怎么起</b>。</p>
      <h4>托管开关</h4>
      <p>打开托管 = 装 systemd 单元 + 建站；关闭 = 撤站点 + 删单元。<b>不会删除你的项目代码与构建产物。</b></p>
      <h4>运行用户</h4>
      <p>留空 = 由面板创建 <code>site-&lt;应用名&gt;</code> 系统用户并降权运行，<b>并非 root</b>。</p>
    </HelpDrawer>
  </div>
</template>

<style scoped>
/* 运行时说明块：首行（用途 / 什么时候选它）用正文色强调，命令与构建步骤降为次级色。
   层级靠颜色而非字号——这一块要在表单里常驻，字号一变大就成了页面主体。 */
.rt-note .rt-purpose { color: var(--c-text); font-weight: 600; }
.rt-note .rt-dim { color: var(--c-text-dim); }
/* 字段指引：字段名用正文色加粗，说明段保持常规色。
   刻意**不**每项一行：六项硬换行实测占 248px，而 508px 高的弹窗里它要吃掉一半、
   把端口/域名框挤进滚动区。改成行内连续排版（靠 .fg-item 自然折行）后实测 184px，
   省下 26%——数字是真机 `getBoundingClientRect` 量的，不是估的。 */
.fg-note { line-height: 1.8; }
.fg-note .fg-item { display: inline; }
.fg-note .fg-f { color: var(--c-text); font-weight: 600; }
.fg-note .fg-sep { color: var(--c-text-dim); margin: 0 4px 0 2px; }
/* 应用表列宽：名称唯一弹性列，其余按实测最长取值定宽 */
.app-name { width: 14%; }
.app-rt   { width: 8%; }
.app-port { width: 7%; }
.app-dom  { width: 20%; }
.app-state{ width: 8%; }
.app-unit { width: 18%; }
.app-en   { width: 7%; }
.app-acts { width: 18%; }

.field-err { display: block; color: var(--c-danger); font-size: var(--fs-12); margin-top: 4px; }
/* 字段下的补充说明（非错误）。与 .hint-note 不同：没有底色/图标，
   只是把「这个字段留空会发生什么」讲清楚，避免用户误以为留空 = root。 */
.hint-inline { display: block; margin-top: 4px; font-size: var(--fs-12); line-height: 1.6;
  color: var(--c-text-dim); }
.hint-inline b { font-weight: 500; color: var(--c-text); }
.hint-inline code { font-size: var(--fs-12); padding: 0 3px; border-radius: 4px;
  background: var(--c-surface-2); border: 1px solid var(--c-border); }
/* 5 个操作按钮必须**单行**：flex-wrap 换行会让行高突然变高、表格错位 */
.app-acts-cell { display: flex; gap: 4px; flex-wrap: nowrap; }
.app-acts-cell .btn-sm { flex: none; padding: 4px 7px; }
.modal > label.has-err input,
.modal > label.has-err select { border-color: var(--c-danger); }

/* 通用错误条吸顶：须为 grid 首项 + 负上边距抵消 .modal 的 padding，底色不透明 */
.modal > .form-msg {
  grid-column: 1 / -1; position: sticky; top: 0; z-index: 3; margin: 0;
}
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
</style>
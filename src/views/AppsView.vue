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
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'

const auth = useAuthStore()

const modalOpen = ref(false)
function open() { modalOpen.value = true }
function close() { modalOpen.value = false }

const apps = ref<AppInfo[]>([])
const runtimes = ref<AppRuntimeInfo[]>([])
/** 已安装的系统包集合——只用于在弹窗里显示「系统包 xxx 未装」，**不做「你没有 X」的断言** */
const installedPkgs = ref<Set<string>>(new Set())
/** 包状态是否可探测（能力位 + 权限点双门控；失败静默降级为不显示） */
const pkgDetectable = ref(false)

const error = ref('')
const formError = ref('')
const fieldErrs = ref<Record<string, string>>({})
const errSeq = ref(0)
const busy = ref(false)
const loading = ref(false)

const canManage = computed(() => auth.can('service.manage'))
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
const curRuntime = computed(() => runtimes.value.find(r => r.key === form.value.runtime) ?? null)

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
// 弹窗统一行为：Esc 关闭 + 焦点陷阱（useModal 是副作用型，返回 void）
useModal(() => modalOpen.value, modalBox, close)

async function load(silent = false) {
  if (!silent) { loading.value = true; error.value = '' }
  try {
    apps.value = await api.get<AppInfo[]>(API.apps.list()) ?? []
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
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
function removeEnvRow(i: number) { form.value.env.splice(i, 1) }

async function save() {
  busy.value = true
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
    if (f && typeof f === 'string') {
      fieldErrs.value = { ...fieldErrs.value, [f]: errorText(e) }
      showErr(errorText(e))
    } else {
      showErr(errorText(e))
    }
  } finally {
    busy.value = false
  }
}

async function act(a: AppInfo, action: 'start' | 'stop' | 'restart') {
  busy.value = true
  try {
    await api.post(API.apps.act(a.id), { act: action })
    await load(true)
    toast(`已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'} ${a.name}`)
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    busy.value = false
  }
}

async function toggleEnabled(a: AppInfo, val: boolean) {
  busy.value = true
  try {
    await api.patch(API.apps.patch(a.id), { enabled: val })
    await load(true)
    toast(val ? `已托管 ${a.name}（单元已装、反代站点已下发）` : `已停止托管 ${a.name}（撤下站点并删除单元）`)
  } catch (e) {
    toast(errorText(e), 'err')
    await load(true) // 失败时回滚开关的真实状态，不靠前端猜
  } finally {
    busy.value = false
  }
}

async function remove(a: AppInfo) {
  if (!window.confirm(`删除应用 ${a.name}？\n\n将同时：撤下反向代理站点、停止并删除 systemd 单元 ${a.unit}、删除面板登记。\n（不会删除你的项目代码与构建产物）`)) return
  busy.value = true
  try {
    await api.del(API.apps.remove(a.id))
    await load()
    toast(`已删除应用 ${a.name}`)
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    busy.value = false
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

onMounted(() => { void load(); void loadCatalog() })
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <h2>应用</h2>
      <div class="head-acts">
        <button class="btn-primary" :disabled="busy" @click="openCreate">
          <Icon name="plus" :size="14" /> 新建应用
        </button>
      </div>
    </div>

    <p class="hint-note">
      <Icon name="info" :size="14" class="ic" />
      <span>每个应用 = 一个由面板用 systemd 托管的进程 + 一个自动维护的反向代理站点（上游
        <b>http://127.0.0.1:&lt;端口&gt;</b>）。<b>构建与依赖安装需你自己在项目目录完成</b>——
        面板只负责把进程拉起来。</span>
    </p>

    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <div v-if="loading && !apps.length" class="skeleton box" />
    <EmptyState v-else-if="!apps.length && !error" title="暂无托管应用"
      desc="点「新建应用」登记一个进程：选运行时、填工作目录与启动命令，面板会装好 systemd 单元并自动建好反代站点" />

    <div v-else-if="apps.length" class="card flush">
      <table class="fixed">
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
                <input type="checkbox" :checked="a.enabled" :disabled="!canManage || busy"
                  @change="toggleEnabled(a, ($event.target as HTMLInputElement).checked)" />
                <i />
              </label>
            </td>
            <td class="app-acts-cell">
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busy" title="启动"
                @click="act(a, 'start')"><Icon name="play" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busy" title="停止"
                @click="act(a, 'stop')"><Icon name="stop" :size="13" /></button>
              <button class="btn-ghost btn-sm" :disabled="!a.enabled || busy" title="重启"
                @click="act(a, 'restart')"><Icon name="refresh" :size="13" /></button>
              <button class="btn-ghost btn-sm" title="编辑" @click="openEdit(a)">
                <Icon name="edit" :size="13" />
              </button>
              <button class="btn-ghost btn-sm" :disabled="busy" title="删除" @click="remove(a)">
                <Icon name="trash" :size="13" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="modalOpen" class="mask" @click.self="close">
      <div ref="modalBox" class="modal wide" role="dialog" aria-modal="true">
        <h3>{{ editing ? `编辑应用 ${editing.name}` : '新建应用' }}</h3>

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

        <!-- 运行时说明：启动命令 + 构建步骤 + 典型框架 + 系统包状态 -->
        <p v-if="curRuntime" class="hint-note">
          <Icon name="info" :size="14" class="ic" />
          <span>
            典型框架 {{ curRuntime.typical }}；启动命令 <b>{{ curRuntime.default_exec || '（需自行填写）' }}</b>。
            <template v-if="curRuntime.runtime_pkg && pkgDetectable">系统包
              <b :class="{ 'is-warn': !installedPkgs.has(curRuntime.runtime_pkg) }">
                {{ curRuntime.runtime_pkg }}{{ installedPkgs.has(curRuntime.runtime_pkg) ? ' 已装' : ' 未装，可到「软件」页装' }}
              </b>。</template>
            <br />构建步骤：{{ curRuntime.build_hint }}
          </span>
        </p>

        <label class="blk full" data-f="workdir">
          工作目录（绝对路径，须已存在）
          <input v-model="form.workdir" placeholder="/opt/blog" />
          <span v-if="fieldErrs.workdir" class="field-err">{{ fieldErrs.workdir }}</span>
        </label>

        <label class="blk full" data-f="exec_start">
          启动命令（systemd ExecStart）
          <input v-model="form.execStart" placeholder="app 或 /opt/blog/app" />
          <span v-if="fieldErrs.exec_start" class="field-err">{{ fieldErrs.exec_start }}</span>
        </label>

        <label class="blk" data-f="port">
          监听端口
          <input v-model.number="form.port" type="number" min="1" max="65535" placeholder="3000" />
          <span v-if="fieldErrs.port" class="field-err">{{ fieldErrs.port }}</span>
        </label>

        <label class="blk">
          运行用户（留空 = root）
          <input v-model="form.runUser" placeholder="留空则 root" />
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
            <button class="btn-ghost" @click="close">取消</button>
            <button class="btn-primary" :disabled="busy" @click="save">
              {{ busy ? '保存中…' : (editing ? '保存' : '创建并托管') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 应用表列宽：名称唯一弹性列，其余按实测最长取值定宽 */
.app-name { width: 14%; }
.app-rt   { width: 8%; }
.app-port { width: 7%; }
.app-dom  { width: 20%; }
.app-state{ width: 8%; }
.app-unit { width: 18%; }
.app-en   { width: 7%; }
.app-acts { width: 18%; }

.field-err { display: block; color: var(--c-danger); font-size: 12px; margin-top: 4px; }
/* 5 个操作按钮必须**单行**：flex-wrap 换行会让行高突然变高、表格错位 */
.app-acts-cell { display: flex; gap: 4px; flex-wrap: nowrap; }
.app-acts-cell .btn-sm { flex: none; padding: 4px 7px; }
.modal > label.has-err input,
.modal > label.has-err select { border-color: var(--c-danger); }

/* 通用错误条吸顶：须为 grid 首项 + 负上边距抵消 .modal 的 padding，底色不透明 */
.modal > .form-msg {
  grid-column: 1 / -1; position: sticky; top: 0; z-index: 3; margin: 0;
}
.err-bar {
  display: flex; gap: 7px; align-items: flex-start; padding: 9px 11px;
  border-radius: 8px; line-height: 1.6;
  background: var(--c-danger-soft); border: 1px solid var(--c-danger);
}
.err-bar .ic { flex: none; margin-top: 1px; }

/* 环境变量区 */
.env-box { display: flex; flex-direction: column; gap: 8px; }
.env-head { display: flex; align-items: center; justify-content: space-between; }
.env-warn {
  display: flex; gap: 6px; align-items: flex-start; margin: 0;
  font-size: 12.5px; color: var(--c-warn); line-height: 1.55;
}
.env-warn .ic { flex: none; margin-top: 2px; }
.env-row { display: flex; gap: 8px; align-items: flex-start; }
.env-row .btn-sm { flex: none; }
.env-row .field-err { flex-basis: 100%; }

.is-warn { color: var(--c-warn); }
</style>
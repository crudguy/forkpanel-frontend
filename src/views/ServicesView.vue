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
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
// ServiceConfig / ServiceJournal / fmtDateTime 随服务弹窗一并移出（现由详情页使用）
import { CAP, PackageInfo, ServiceInfo as Svc, TaskRun, TASK_FINISHED, serviceStateLabel, taskStateBadge, taskStateLabel } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'

// Svc 直接取 types.ts 的 ServiceInfo（与服务详情页共用，避免两处各自定义漂移）；
// 以别名引入是为保留本文件既有的 Svc 写法、压低改动面。
interface TaskWatch { id: number; label: string; state: string; percent: number; out?: string[] }

const auth = useAuthStore()
const svcs = ref<Svc[]>([])
const pkgs = ref<PackageInfo[] | null>(null)
const init = ref('')
const error = ref('')
const pkgNote = ref('')
// svcError 随服务弹窗移除（服务操作的错误提示现由详情页承载）
const busy = ref('')            // 软件安装/卸载提交中
const loadingPkg = ref('')      // 正在提交安装的包名

// 与后端 ALLOWED_PACKAGES 保持一致的展示白名单
const WHITELIST = [
  'nginx', 'caddy', 'apache2', 'mysql-server', 'mariadb-server', 'postgresql',
  'redis', 'memcached', 'php-fpm', 'php8.1-fpm', 'php8.2-fpm', 'php8.3-fpm',
  'certbot', 'fail2ban', 'ufw', 'curl', 'wget', 'git', 'unzip', 'tar',
]

const canManage = computed(() => auth.enabled(CAP.SERVICE_MANAGE, 'service.manage'))
const canPkg = computed(() => auth.enabled(CAP.PACKAGE_INSTALL, 'package.install'))
const installedNames = computed(() => new Set(pkgs.value?.map(p => p.name) ?? []))
const installable = computed(() => WHITELIST.filter(n => !installedNames.value.has(n)))

async function load() {
  error.value = ''
  // 请求级门控：init 系统未知时后端返 501（service.manage=no）
  if (!auth.supported(CAP.SERVICE_MANAGE)) return
  try {
    const r = await api.get<{ init_system: string; services: Svc[] }>(API.services.list())
    init.value = r.init_system
    svcs.value = r.services
  } catch (e) { error.value = errorText(e) }
}

async function loadPackages() {
  pkgNote.value = ''
  // 同上：无包管理器时 package.install=no，枚举端点会 501
  if (!auth.supported(CAP.PACKAGE_INSTALL)) { pkgs.value = []; return }
  try {
    const r = await api.get<{ packages: PackageInfo[] }>(API.packages.list())
    pkgs.value = r.packages ?? []
  } catch (e) {
    pkgs.value = []
    if (isUnsupported(e)) pkgNote.value = '软件包枚举功能即将推出（可先使用下方安装）'
    else pkgNote.value = errorText(e)
  }
}

onMounted(() => { load(); loadPackages() })
onUnmounted(stopWatch)

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
  if (state === 'ok') { loadPackages(); load() }
}

// 徽标与文案统一走共享词表（src/api/types.ts），与任务中心口径一致
function taskBadge(s: string) { return taskStateBadge(s) }
function taskStateText(s: string) { return taskStateLabel(s) }

// ─────────────── 软件安装 / 卸载 ───────────────

async function install(p: string) {
  loadingPkg.value = p; error.value = ''
  try {
    const r = await api.post<{ task_id: number; created: boolean }>(API.packages.install(), { name: p })
    if (!r.created) error.value = '该安装任务已在进行中（已复用已有任务）'
    watchTask(r.task_id, `安装 ${p}`)
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

function stateBadge(s: string) {
  return s === 'active' ? 'badge-ok' : s === 'failed' ? 'badge-danger'
    : (s === 'activating' || s === 'deactivating') ? 'badge-warn' : ''
}

// ─────────────── 卸载软件确认（需输入包名） ───────────────

const confirmRemove = ref<string | null>(null)
const confirmTitle = computed(() => confirmRemove.value ? `卸载软件 ${confirmRemove.value}` : '')
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
    <div class="page-head">
      <span v-if="init" class="badge badge-primary">init: {{ init }}</span>
      <span class="spacer" />
      <button class="btn-primary" :disabled="!!busy" @click="load">
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

    <!-- 软件区 -->
    <section v-if="auth.supported(CAP.PACKAGE_INSTALL)" class="card" style="margin-bottom:14px">
      <div class="sec-head">
        <Icon name="database" :size="16" /> 已安装软件
        <span v-if="pkgs && !pkgNote" class="dim">（白名单内 {{ pkgs.length }} 个）</span>
      </div>
      <p v-if="pkgNote" class="tip dim">{{ pkgNote }}</p>
      <template v-else>
        <div v-if="pkgs?.length" class="pkg-grid">
          <div v-for="p in pkgs" :key="p.name" class="pkg">
            <span class="pkg-name mono">{{ p.name }}</span>
            <span class="pkg-meta">
              <span v-if="p.version" class="badge">v{{ p.version }}</span>
              <span class="badge badge-primary">{{ p.manager }}</span>
            </span>
            <button class="btn-danger btn-sm" :disabled="!canPkg || !!task" @click="askRemove(p.name)">卸载</button>
          </div>
        </div>
        <EmptyState v-else title="白名单内暂无已安装软件" />
        <template v-if="installable.length">
          <div class="sec-head" style="margin-top:18px">
            <Icon name="plus" :size="16" /> 安装软件
          </div>
          <div class="pkgs">
            <button v-for="p in installable" :key="p" class="btn-ghost"
                    :disabled="!canPkg || !!loadingPkg || !!task" @click="install(p)">
              {{ loadingPkg === p ? '提交中…' : '+ ' + p }}
            </button>
          </div>
        </template>
      </template>
      <p class="tip dim" style="margin-top:12px">
        仅允许白名单内的软件包：面板以 root 运行，任意安装等同任意代码执行。安装/卸载走任务队列，进度见顶部任务条与右下角任务面板。
      </p>
    </section>

    <!-- 服务列表 -->
    <EmptyState v-if="!auth.supported(CAP.SERVICE_MANAGE)"
      title="当前环境不支持服务管理"
      :reason="auth.capabilities[CAP.SERVICE_MANAGE]?.reason ?? undefined" />

    <div v-else class="card flush">
      <table>
        <thead><tr><th>服务</th><th>状态</th><th>开机自启</th><th>说明</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in svcs" :key="s.name" class="rowlink" @click="goDetail(s)">
            <td>
              {{ s.name }}
              <span v-if="!s.managed" class="badge badge-warn">未托管</span>
            </td>
            <td><span class="badge" :class="stateBadge(s.state)">{{ serviceStateLabel(s.state) }}</span></td>
            <td>{{ s.enabled ? '是' : '否' }}</td>
            <td class="dim">{{ s.description ?? '—' }}</td>
            <td class="acts"><button class="btn-ghost btn-sm">详情 ›</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="!svcs.length && !error" title="未发现服务" />
    </div>


    <ConfirmDialog :open="!!confirmRemove" :title="confirmTitle" :detail="confirmDetail"
                   :confirm-word="confirmWord" danger
                   @confirm="doConfirmed" @cancel="confirmRemove = null" />
  </div>
</template>

<style scoped>
.dim { color: var(--c-text-dim); }
.pkgs { display: flex; gap: 8px; flex-wrap: wrap; }
.acts { white-space: nowrap; }

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

/* 软件卡片 */
.pkg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.pkg { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
       border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-glass); }
.pkg-name { font-size: 13.5px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pkg-meta { display: flex; gap: 6px; flex-shrink: 0; }

/* 表格行可点 */
tr.rowlink { cursor: pointer; }
tr.rowlink:hover { background: var(--c-hover); }

/* 服务详情已迁到独立页 ServiceDetailView：弹窗相关的样式
   （.mask / .box / .m-tabs / .m-config / .cfg-edit / .switch 等）已随弹窗一并移除，
   留在这里只会让人以为本页还在渲染这些元素。
   注意：注释里不要写 "星号+斜杠" 形式的通配符（如 .m-* ），
   那会提前闭合本注释、让后面的中文变成裸 CSS，导致整个 SFC 编译失败。 */
</style>

<script setup lang="ts">
/**
 * 软件与服务。
 *
 * 交互设计（对标 1Panel / 宝塔的"点击进入管理"模式）：
 * - 服务表格**行点击 → 管理弹窗**：启/停/重启、开机自启开关、最近日志一次看全。
 * - 未托管服务的停止需要二次确认（ConfirmDialog），sshd 的停止被后端拒绝（防失联）。
 * - 软件区展示白名单内已装列表（/packages），卸载需输入包名确认；
 *   安装/卸载都走任务队列，页面顶部任务条轮询 /tasks 展示进度与输出尾部。
 * - 服务弹窗内「配置」页可在线编辑单元文件（GET/PUT /services/{unit}/config），
 *   保存时原子替换 + daemon-reload，可选保存后重启；发行版文件会提示改用 drop-in。
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useModal } from '@/composables/useModal'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { CAP, PackageInfo, ServiceConfig, ServiceJournal, TaskRun, TASK_FINISHED, taskStateBadge, taskStateLabel } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'

interface Svc { name: string; state: string; enabled: boolean; description: string | null; managed: boolean }
interface TaskWatch { id: number; label: string; state: string; percent: number; out?: string[] }
interface ModalState { svc: Svc; journal: string[]; jLoading: boolean; jError: string }

const auth = useAuthStore()
const svcs = ref<Svc[]>([])
const pkgs = ref<PackageInfo[] | null>(null)
const init = ref('')
const error = ref('')
const pkgNote = ref('')
const svcError = ref('')
const busy = ref('')            // `${name}:${action}` 动作进行中
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

// 终态判定改用共享词表：此前写死 ['done','failed','cancelled','interrupted']，
// 而后端成功终态是 'ok'（'done' 根本不会出现）→ 任务完成后轮询永不停止。
const FINISHED = TASK_FINISHED
const task = ref<TaskWatch | null>(null)
let pollTimer: number | undefined

function watchTask(id: number, label: string) {
  stopWatch()
  task.value = { id, label, state: 'running', percent: 0 }
  pollTimer = window.setInterval(pollTask, 1500)
  pollTask()
}
function stopWatch() { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined } }
function dismissTask() { stopWatch(); task.value = null }

async function pollTask() {
  const t = task.value
  if (!t) return
  try {
    const r = await api.get<TaskRun[] | { tasks: TaskRun[] }>(API.tasks.list())
    const list = Array.isArray(r) ? r : (r.tasks ?? [])
    const row = list.find(x => x.id === t.id)
    if (!row) return
    t.state = row.state
    t.percent = row.progress ?? 0
    if (FINISHED.has(row.state)) {
      stopWatch()
      try {
        const o = await api.get<{ lines?: string[] }>(API.tasks.output(t.id) + '?lines=12')
        t.out = (o.lines ?? []).slice(-10)
      } catch { /* 输出读取失败不阻断状态展示 */ }
      if (row.state === 'done') { loadPackages(); load() }
    }
  } catch { /* 轮询瞬时失败忽略，下个周期重试 */ }
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

// ─────────────── 服务弹窗 ───────────────

const modal = ref<ModalState | null>(null)

function openSvc(s: Svc) {
  modal.value = { svc: { ...s }, journal: [], jLoading: true, jError: '' }
  // 必须先清空上一次服务的配置状态：否则看过 A 的配置再打开 B，「配置」页显示的
  // 仍是 A 的路径与内容（openConfig 仅 !cfg 才拉取），一保存就把 A 的单元写进 B。
  cfg.value = null
  cfgDraft.value = ''
  cfgError.value = ''
  cfgSaved.value = false
  tab.value = 'log'
  loadJournal(s.name)
}
function closeModal() { modal.value = null }

// 服务弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const modalBox = ref<HTMLElement | null>(null)
useModal(() => !!modal.value, modalBox, closeModal)

async function loadJournal(name: string) {
  if (!modal.value) return
  modal.value.jLoading = true; modal.value.jError = ''
  try {
    const r = await api.get<ServiceJournal>(API.services.journal(name))
    modal.value.journal = r.lines ?? []
  } catch (e) {
    if (isUnsupported(e)) modal.value.jError = '日志查看功能即将推出'
    else modal.value.jError = errorText(e)
  } finally { if (modal.value) modal.value.jLoading = false }
}

async function svcAct(s: Svc, action: 'start' | 'stop' | 'restart') {
  const key = s.name + ':' + action
  busy.value = key; svcError.value = ''
  try {
    const url = action === 'start' ? API.services.start(s.name)
      : action === 'stop' ? API.services.stop(s.name)
      : API.services.restart(s.name)
    await api.post(url)
    // 拉最新状态回填弹窗（表格随后整表刷新）
    const st = await api.get<{ name: string; state: string }>(API.services.status(s.name))
    if (modal.value && modal.value.svc.name === s.name) modal.value.svc.state = st.state
    load()
  } catch (e) { svcError.value = errorText(e) }
  finally { busy.value = '' }
}

async function toggleEnable(s: Svc) {
  busy.value = s.name + ':enable'; svcError.value = ''
  try {
    await api.put(API.services.setEnabled(s.name), { enabled: !s.enabled })
    if (modal.value && modal.value.svc.name === s.name) modal.value.svc.enabled = !s.enabled
    load()
  } catch (e) { svcError.value = errorText(e) }
  finally { busy.value = '' }
}

/** sshd 不允许 stop：防失联（后端也会拒绝，双保险） */
function stopDisabled(s: Svc) {
  return s.name === 'sshd' || s.name === 'ssh'
}

// ─────────────── 在线配置编辑 ───────────────

const tab = ref<'log' | 'config'>('log')
const cfg = ref<ServiceConfig | null>(null)
const cfgDraft = ref('')
const cfgLoading = ref(false)
const cfgError = ref('')
const cfgSaving = ref(false)
const cfgRestart = ref(false)
const cfgSaved = ref(false)

async function loadConfig(name: string) {
  cfgLoading.value = true; cfgError.value = ''; cfg.value = null; cfgSaved.value = false
  try {
    const r = await api.get<ServiceConfig>(API.services.config(name))
    cfg.value = r
    cfgDraft.value = r.content
  } catch (e) {
    if (isUnsupported(e)) cfgError.value = '当前环境不支持在线编辑配置'
    else cfgError.value = errorText(e)
  } finally { cfgLoading.value = false }
}

function openConfig(s: Svc) {
  tab.value = 'config'
  if (!cfg.value) loadConfig(s.name)
}

async function saveConfig() {
  if (!modal.value || !cfg.value) return
  const name = modal.value.svc.name
  cfgSaving.value = true; cfgError.value = ''; cfgSaved.value = false
  try {
    await api.put(API.services.config(name), { content: cfgDraft.value, restart: cfgRestart.value })
    cfgSaved.value = true
    // 回填：重新拉取最新配置，并刷新服务状态/列表
    await loadConfig(name)
    const st = await api.get<{ name: string; state: string }>(API.services.status(name))
    if (modal.value && modal.value.svc.name === name) modal.value.svc.state = st.state
    load()
  } catch (e) { cfgError.value = errorText(e) }
  finally { cfgSaving.value = false }
}

function stateBadge(s: string) {
  return s === 'active' ? 'badge-ok' : s === 'failed' ? 'badge-danger'
    : (s === 'activating' || s === 'deactivating') ? 'badge-warn' : ''
}

// ─────────────── 危险操作确认 ───────────────

const confirmBox = ref<{ kind: 'stop' | 'remove'; name: string } | null>(null)
const confirmTitle = computed(() => confirmBox.value
  ? (confirmBox.value.kind === 'stop' ? `停止服务 ${confirmBox.value.name}` : `卸载软件 ${confirmBox.value.name}`) : '')
const confirmDetail = computed(() => {
  const c = confirmBox.value
  if (!c) return ''
  return c.kind === 'stop'
    ? '该服务不受面板托管，停止可能影响依赖它的业务，请确认你了解此操作的后果。'
    : `将从系统中卸载 ${c.name}（走任务队列执行包管理器 remove）。配置文件与用户数据一般会保留，请确认无正在进行的业务依赖。`
})
const confirmWord = computed(() => confirmBox.value?.kind === 'remove' ? confirmBox.value.name : undefined)

function askStop(s: Svc) {
  if (s.managed) svcAct(s, 'stop')
  else confirmBox.value = { kind: 'stop', name: s.name }
}
function askRemove(n: string) { confirmBox.value = { kind: 'remove', name: n } }

async function doConfirmed() {
  const c = confirmBox.value
  confirmBox.value = null
  if (!c) return
  if (c.kind === 'stop') {
    if (modal.value?.svc.name === c.name) await svcAct(modal.value.svc, 'stop')
  } else {
    await removePkg(c.name)
  }
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
          <tr v-for="s in svcs" :key="s.name" class="rowlink" @click="openSvc(s)">
            <td>
              {{ s.name }}
              <span v-if="!s.managed" class="badge badge-warn">未托管</span>
            </td>
            <td><span class="badge" :class="stateBadge(s.state)">{{ s.state }}</span></td>
            <td>{{ s.enabled ? '是' : '否' }}</td>
            <td class="dim">{{ s.description ?? '—' }}</td>
            <td class="acts"><button class="btn-ghost btn-sm">管理 ›</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="!svcs.length && !error" title="未发现服务" />
    </div>

    <!-- 服务管理弹窗 -->
    <div v-if="modal" class="mask" @click.self="closeModal">
      <div ref="modalBox" class="box" role="dialog" aria-modal="true">
        <header class="m-head">
          <div style="flex:1;min-width:0">
            <h3 class="mono">
              {{ modal.svc.name }}
              <span class="badge" :class="stateBadge(modal.svc.state)">{{ modal.svc.state }}</span>
              <span v-if="!modal.svc.managed" class="badge badge-warn">未托管</span>
            </h3>
            <p class="m-desc">{{ modal.svc.description ?? '无描述' }}</p>
          </div>
          <button class="btn-ghost btn-sm" @click="closeModal">✕</button>
        </header>

        <p v-if="svcError" class="err" style="margin:0">{{ svcError }}</p>

        <div class="m-acts">
          <button class="btn-ghost" :disabled="!canManage || !!busy || modal.svc.state === 'active'"
                  @click="svcAct(modal.svc, 'start')">
            {{ busy === modal.svc.name + ':start' ? '执行中…' : '启动' }}
          </button>
          <button class="btn-danger" :disabled="!canManage || !!busy || stopDisabled(modal.svc)"
                  :title="stopDisabled(modal.svc) ? '禁止停止 SSH 服务以防失联' : ''"
                  @click="askStop(modal.svc)">
            {{ busy === modal.svc.name + ':stop' ? '执行中…' : '停止' }}
          </button>
          <button class="btn-ghost" :disabled="!canManage || !!busy" @click="svcAct(modal.svc, 'restart')">
            {{ busy === modal.svc.name + ':restart' ? '执行中…' : '重启' }}
          </button>
          <span class="spacer" />
          <label class="switch-row">
            <span>开机自启</span>
            <span class="switch">
              <input type="checkbox" :checked="modal.svc.enabled"
                     :disabled="!canManage || !!busy" @change="toggleEnable(modal.svc)" /><i />
            </span>
          </label>
        </div>

        <p v-if="!modal.svc.managed" class="tip warn-tip">
          ⚠ 该服务不受面板托管，停止前请确认影响；sshd 的停止会被拒绝以防失联。
        </p>

        <div class="m-tabs">
          <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">日志</button>
          <button class="tab" :class="{ active: tab === 'config' }" :disabled="!canManage"
                  @click="openConfig(modal.svc)">配置</button>
        </div>

        <div v-if="tab === 'log'" class="m-log">
          <div class="sec-head">
            最近日志
            <span class="spacer" />
            <button class="btn-ghost btn-sm" :disabled="modal.jLoading" @click="loadJournal(modal.svc.name)">
              <Icon name="refresh" :size="14" /> 刷新
            </button>
          </div>
          <pre v-if="modal.jLoading" class="skeleton" style="height:140px" />
          <pre v-else-if="modal.journal.length" class="out">{{ modal.journal.join('\n') }}</pre>
          <p v-else class="tip dim" style="margin:0">暂无日志输出</p>
        </div>

        <div v-else-if="tab === 'config'" class="m-config">
          <p v-if="cfgLoading" class="skeleton" style="height:220px" />
          <p v-else-if="cfgError && !cfg" class="err">{{ cfgError }}</p>
          <template v-else-if="cfg">
            <p class="tip dim" style="margin:0 0 8px;font-family:var(--mono);word-break:break-all">{{ cfg.path }}</p>
            <p v-if="!cfg.writable" class="tip warn-tip" style="margin:0 0 8px">
              ⚠ 该文件位于发行版目录，修改可能在软件包升级时被覆盖。建议改用 drop-in：<br>
              <code class="mono">/etc/systemd/system/{{ modal.svc.name }}.d/override.conf</code>
            </p>
            <p v-if="cfgError" class="err" style="margin:0 0 8px">{{ cfgError }}</p>
            <textarea v-model="cfgDraft" class="cfg-edit" spellcheck="false" :disabled="cfgSaving" />
            <div class="cfg-foot">
              <label class="switch-row">
                <span>保存后重启服务</span>
                <span class="switch">
                  <input type="checkbox" v-model="cfgRestart" :disabled="cfgSaving" /><i />
                </span>
              </label>
              <span class="spacer" />
              <span v-if="cfgSaved" class="badge badge-ok">已保存</span>
              <button class="btn-ghost btn-sm" :disabled="cfgSaving" @click="loadConfig(modal.svc.name)">重置</button>
              <button class="btn-primary" :disabled="cfgSaving || !canManage" @click="saveConfig()">
                {{ cfgSaving ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <ConfirmDialog :open="!!confirmBox" :title="confirmTitle" :detail="confirmDetail"
                   :confirm-word="confirmWord" danger
                   @confirm="doConfirmed" @cancel="confirmBox = null" />
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

/* 服务管理弹窗 */
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 50; }
.box { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius);
       padding: 20px; width: min(680px, 94vw); max-height: 86vh; overflow: auto;
       display: flex; flex-direction: column; gap: 14px; }
.m-head { display: flex; align-items: flex-start; gap: 10px; }
.m-head h3 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.m-desc { margin: 4px 0 0; font-size: 13px; color: var(--c-text-dim); }
.m-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.m-log .sec-head { margin-bottom: 8px; }
.warn-tip { color: var(--c-warn); }

/* 配置编辑页签 */
.m-tabs { display: flex; gap: 4px; margin: 14px 0 0; border-bottom: 1px solid var(--c-border); }
.tab { background: none; border: none; padding: 8px 14px; font-size: 13.5px; color: var(--c-text-dim);
      cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover:not(:disabled) { color: var(--c-text); }
.tab.active { color: var(--c-text); border-bottom-color: var(--c-primary); font-weight: 600; }
.tab:disabled { opacity: .5; cursor: not-allowed; }

.m-config { padding-top: 12px; }
.cfg-edit { width: 100%; min-height: 260px; resize: vertical; box-sizing: border-box;
           padding: 12px 14px; background: var(--c-bg); color: var(--c-text);
           border: 1px solid var(--c-border); border-radius: var(--radius-sm);
           font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
           white-space: pre; overflow: auto; tab-size: 2; }
.cfg-edit:focus { outline: none; border-color: var(--c-primary); }
.cfg-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.mono { font-family: var(--mono); }

/* 开关 */
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--c-text-dim); cursor: pointer; }
.switch { position: relative; width: 34px; height: 19px; display: inline-block; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch i { position: absolute; inset: 0; border-radius: 999px; background: var(--c-hover); border: 1px solid var(--c-border); transition: background .15s; }
.switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--c-text-dim); transition: all .15s; }
.switch input:checked + i { background: var(--c-primary-soft); border-color: var(--c-primary); }
.switch input:checked + i::after { left: 17px; background: var(--c-primary); }
.switch input:disabled + i { opacity: .5; }
</style>

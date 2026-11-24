<script setup lang="ts">
/**
 * 计划任务（用户 cron，不是面板内部任务）。
 *
 * 表达式是**平台本地语义**：Linux 是 cron 五段。UI 的快捷设置只把常用周期
 * 编成规范字符串，且只识别自己生成的那几种格式；用户手写的复杂表达式
 * 原样保留，不做通用解析。校验仍由后端负责，错误原样展示。
 */
import { ref, onMounted, computed, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAsync } from '@/composables/useAsync'
import { focusCreateCard } from '@/composables/emptyStateCta'
import { useAuthStore } from '@/stores/auth'
import { CAP, cronKindLabel, fmtDateTime } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import CronScheduleBar from '@/components/CronScheduleBar.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import { matchFields } from '@/composables/listSearch'

interface Job {
  id: string; expr: string; command: string; user: string
  enabled: boolean; timeout_sec: number
  last_run_at: number | null; last_status: string | null; next: number[]
}

const auth = useAuthStore()
const jobs = ref<Job[]>([])

// 全站表格约定：分页 + 排序走 useTableControls，页脚用 <TablePager>。
// 计划任务的「名称」就是任务标识 Job.id（新建时的 name 落库为 id），故按 id 排序；
// 表达式/命令/用户为文本列；上次执行按时间降序（最近跑过的在前），
// 下次预览按最近一次命中升序（无下次命中 = 一年内不触发，排到最后）。
const cronSortCols: SortColumn<Job>[] = [
  { key: 'id', dir: 'asc', compare: (a, b) => (a.id ?? '').localeCompare(b.id ?? '') },
  { key: 'expr', dir: 'asc', compare: (a, b) => (a.expr ?? '').localeCompare(b.expr ?? '') },
  { key: 'command', dir: 'asc', compare: (a, b) => (a.command ?? '').localeCompare(b.command ?? '') },
  { key: 'user', dir: 'asc', compare: (a, b) => (a.user ?? '').localeCompare(b.user ?? '') },
  { key: 'last_run_at', dir: 'desc', compare: (a, b) => (a.last_run_at ?? 0) - (b.last_run_at ?? 0) },
  { key: 'next', dir: 'asc', compare: (a, b) => (a.next?.[0] ?? Number.MAX_SAFE_INTEGER) - (b.next?.[0] ?? Number.MAX_SAFE_INTEGER) },
]
// 任务名（Job.id）/ 表达式 / 命令 / 执行用户都是表里可见的字段：
// 搜「backup」找任务、搜「/opt/」找命令，比逐行扫表达式快得多。
const q = ref('')
const filteredJobs = computed(() => jobs.value.filter(j => matchFields(q.value, [
  j.id, j.expr, j.command, j.user,
])))
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<Job>({
    rows: filteredJobs, defaultSize: 100, defaultSort: { key: 'id', dir: 'asc' }, columns: cronSortCols,
    persistKey: 'cron.jobs',
  })
/** 改搜索词回第一页 */
watch(q, () => { page.value = 1 })
const { error, loading, run } = useAsync()
const note = ref('')
/**
 * 新建表单。字段集合对齐后端 `CreateReq`（cron.rs:143）与**编辑弹窗**——
 * 此前只有 name/expr/user/command，于是新建出来的任务一律「默认启用、超时 30 分钟、
 * 无 Webhook」，想改只能先建再点编辑；而编辑弹窗里超时/启用/Webhook 都是齐的。
 * 创建态与编辑态的字段不对等，是这条流程最反直觉的地方。
 */
const form = ref({
  name: '',
  expr: '',
  command: '',
  user: 'root',
  timeout_sec: 1800,
  enabled: true,
  webhook_url: '',
})
const del = ref<Job | null>(null)

/**
 * 名称格式判据——与后端 `panel_core::rules::is_valid_path_segment` 同口径
 * （字母数字、下划线、连字符；会作为 crontab 里的标识）。
 *
 * 前端先拦一遍不是为了「替代后端」，而是因为只靠后端时用户要等一次 400 才知道
 * 规则是什么。按项目约定，新增拒绝类约束必须「后端判定 + 前端提交前拦 + 文案提示」
 * 三处同步，缺一处就会变成「只见 400 不知改哪」。
 */
const NAME_RE = /^[A-Za-z0-9_-]+$/
function nameIssue(name: string): string | null {
  const v = name.trim()
  if (!v) return '请填写名称'
  if (!NAME_RE.test(v)) return '名称只允许字母、数字、下划线与连字符（会作为 crontab 标识）'
  return null
}
/** 表单内联错误：与页面级 error 分开，避免「填错一个字段」被当成整页失败。 */
const formErr = ref('')
const nameWarn = computed(() => (form.value.name ? nameIssue(form.value.name) : null))

// 编辑态：PATCH /api/v1/cron/jobs/{id}
const edit = ref<Job | null>(null)
const editForm = ref({ expr: '', command: '', user: '', enabled: true, timeout_sec: 60 })
const editBusy = ref(false)
const editError = ref('')

async function load() {
  error.value = ''
  // 请求级门控：系统无 crontab 时 scheduler.manage=no，列表端点返 501
  if (!auth.supported(CAP.SCHEDULER_MANAGE)) return
  await run(
    async () => { jobs.value = await api.get<Job[]>(API.cron.jobs()) },
    (e) => { jobs.value = []; error.value = errorText(e) },
  )
}

// 手动触发一次：后端把它排进任务队列并立刻返回 task_id，
// 不在请求里等脚本跑完（脚本可能跑几分钟，HTTP 请求等不起）。
const runBusy = ref<string | null>(null)
/** 刚提交执行得到的任务 id：提示条里要给它一个**真链接**（连同状态徽标一起显示）。 */
const lastTaskId = ref<number | null>(null)
async function runNow(j: Job) {
  runBusy.value = j.id; error.value = ''; note.value = ''; lastTaskId.value = null
  try {
    const r = await api.post<{ task_id: number; created: boolean }>(API.cron.run(j.id), {})
    // note 只留纯文本部分；跳转链接放模板里（纯文本串里的"任务中心"用户点不了）
    note.value = `已提交执行「${j.id}」（任务 #${r.task_id}）`
    lastTaskId.value = r.task_id
    load()
  } catch (e) { error.value = errorText(e) }
  finally { runBusy.value = null }
}
onMounted(() => { void load(); void loadTemplates() })

const canManage = computed(() => auth.enabled(CAP.SCHEDULER_MANAGE, 'cron.manage'))

// 创建按钮加 busy 态（审计 U8）：此前请求期间按钮可重复点击，产生重复任务
const createBusy = ref(false)
async function create() {
  error.value = ''; note.value = ''; formErr.value = ''
  // 前置校验：名称格式 + 超时范围（与编辑弹窗的约束同值，避免「新建能过、编辑被拒」）
  const bad = nameIssue(form.value.name)
  if (bad) { formErr.value = bad; return }
  const to = Number(form.value.timeout_sec)
  if (!Number.isFinite(to) || to < 1 || to > 604800) {
    formErr.value = '超时需为 1-604800 之间的整数（秒）'
    return
  }
  createBusy.value = true
  try {
    await api.post(API.cron.jobs(), {
      name: form.value.name.trim(), expr: form.value.expr,
      command: form.value.command, user: form.value.user,
      timeout_sec: to,
      enabled: form.value.enabled,
      // 空串 = 不设置（后端把空串当「未设置」）；不要传 null，YAML/JSON 语义会变
      webhook_url: form.value.webhook_url.trim(),
    })
    // 成功后 toast：同页的「执行」「Webhook 测试」都有反馈，创建这条主操作此前
    // 只静默清空表单，用户无法确认到底成没成（只能靠列表里是否多了一行）。
    toast(`已创建计划任务「${form.value.name.trim()}」`)
    form.value = {
      name: '', expr: '', command: '', user: 'root',
      timeout_sec: 1800, enabled: true, webhook_url: '',
    }
    load()
  } catch (e) { formErr.value = errorText(e) }
  finally { createBusy.value = false }
}

async function doDelete() {
  if (!del.value) return
  try { await api.del(API.cron.job(del.value.id)); del.value = null; load() }
  // 失败也关框：否则确认框继续盖着、错误在遮罩后
  catch (e) { del.value = null; toast(`删除任务失败：${errorText(e)}`, 'err') }
}

/**
 * 「上次执行结果」徽标配色。
 *
 * 后端 `run_outcome` 只产出三种形态：`ok` / `exit N` / `killed：…`，只有 `ok` 算成功，
 * 其余（含 exit 0 以外的任何退出码、被信号杀掉）一律红色失败。
 * ⚠ 不能直接借用 `taskStateBadge`：它的入参是 queued/running/… 六态，
 * 传 `exit 1` 会落到默认的 badge-warn（黄色）——失败显示成「警告」，与任务中心的
 * 红色失败徽标不一致。
 */
function lastStatusBadge(s: string): string {
  return s === 'ok' ? 'badge-ok' : 'badge-danger'
}

function openEdit(j: Job) {
  edit.value = j
  editForm.value = {
    expr: j.expr, command: j.command, user: j.user,
    enabled: j.enabled, timeout_sec: j.timeout_sec || 60,
  }
  editError.value = ''
}
function closeEdit() { edit.value = null; editBusy.value = false }

// Esc 关闭 + Tab 焦点陷阱 + 打开聚焦 + 关闭后焦点返还（此前本弹窗只有点遮罩和 ✕）。
// X / 点遮罩 / 取消按钮统一走 closeEditModal。
const editBox = ref<HTMLElement | null>(null)
const { close: closeEditModal } = useModal(() => !!edit.value, editBox, closeEdit)

// ── 表达式预览：POST /cron/preview（纯计算零副作用，本地时区语义） ──
const previewNext = ref<number[]>([])
const previewExpr = ref('')
const previewBusy = ref(false)

async function doPreview(expr: string) {
  if (!expr) return
  previewBusy.value = true
  try {
    const r = await api.post<{ expr: string; next: number[] }>(API.cron.preview(), { expr })
    previewNext.value = r.next ?? []
    previewExpr.value = r.expr
  } catch (e) {
    previewNext.value = []
    previewExpr.value = ''
    // 预览也可能发生在编辑弹窗内：页面级 error 会被 .mask 挡住，改走全局 toast
    toast(`预览失败：${errorText(e)}`, 'err')
  } finally { previewBusy.value = false }
}

async function saveEdit() {
  if (!edit.value) return
  if (!canManage.value) { editError.value = '无计划任务管理权限'; return }
  // P2：超时清空后 v-model.number 得 '' → Number('')=0，会下发非法超时；显式拦截
  const to = Number(editForm.value.timeout_sec)
  if (!Number.isFinite(to) || to < 1 || to > 604800) {
    editError.value = '超时需为 1-604800 之间的整数（秒）'
    return
  }
  editBusy.value = true; editError.value = ''
  try {
    await api.patch(API.cron.job(edit.value.id), {
      expr: editForm.value.expr,
      command: editForm.value.command,
      user: editForm.value.user,
      enabled: editForm.value.enabled,
      timeout_sec: to,
    })
    closeEdit(); load()
  } catch (e) { editError.value = errorText(e) }
  finally { editBusy.value = false }
}


// ── Webhook 测试 / 触发（cron.webhook/test + cron/jobs/{id}/webhook）──
const webhookUrl = ref('')
const webhookBusy = ref(false)
async function testWebhook() {
  if (!webhookUrl.value) return
  webhookBusy.value = true; error.value = ''; note.value = ''
  try {
    await api.post(API.cron.webhookTest(), { url: webhookUrl.value })
    note.value = `Webhook「${webhookUrl.value}」探测成功`
    toast('Webhook 探测成功')
  } catch (e) { error.value = errorText(e) }
  finally { webhookBusy.value = false }
}

const trigBusy = ref<string | null>(null)
async function triggerWebhook(j: Job) {
  trigBusy.value = j.id; error.value = ''; note.value = ''
  try {
    await api.post(API.cron.webhookTrigger(j.id), {})
    note.value = `已向任务「${j.id}」配置的 Webhook 发送测试事件`
    toast('已触发 Webhook')
  } catch (e) { error.value = errorText(e) }
  finally { trigBusy.value = null }
}

// ───────────────────────── 任务模板 ─────────────────────────
/**
 * 模板 = 「新建任务的预置字段」，不是「任务本体」。
 *
 * 三条设计前提：
 * 1. **只填充、不绑定**：选中模板后字段被灌进 form，之后随便改；模板与建出来的
 *    任务之间没有任何关联，删模板不影响已建任务（后端无外键，见迁移 037）。
 * 2. **不填充名称**：任务名在系统里唯一（落库即 crontab 标识），照模板名字填
 *    第二次就会撞重名。所以命中模板后清空名称并聚焦，由用户给这一次起名。
 * 3. **模板取不到/为空都要能手动建**：`templates` 为空时整条模板栏不渲染，
 *    新建表单与「没有模板功能」时完全一致。
 */
interface Tpl {
  id: number; name: string; description: string
  expr: string; command: string; user: string
  timeout_sec: number; webhook_url: string | null
  created_at: number; updated_at: number
}
const templates = ref<Tpl[]>([])
const tplPick = ref('')
const tplNote = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

async function loadTemplates() {
  // 模板是「锦上添花」：拉取失败不该把整页打成错误态（新建任务本身还能用）。
  // 静默降级为「没有模板」，只在控制台留痕。
  try {
    templates.value = await api.get<Tpl[]>(API.cron.templates())
  } catch (e) {
    templates.value = []
    console.warn('[cron] 任务模板加载失败，已降级为手动创建：', errorText(e))
  }
}

function applyTemplate() {
  const t = templates.value.find(x => String(x.id) === tplPick.value)
  if (!t) { tplNote.value = ''; return }
  form.value = {
    // 名称刻意留空：任务名唯一，沿用模板名必然撞重名
    name: '',
    expr: t.expr,
    command: t.command,
    user: t.user || 'root',
    timeout_sec: t.timeout_sec || 1800,
    enabled: true,
    webhook_url: t.webhook_url ?? '',
  }
  formErr.value = ''
  tplNote.value = `已按「${t.name}」填充${t.description ? `（${t.description}）` : ''}，请填写任务名称`
  // 焦点落到名称框：填充后唯一缺的就是名字
  requestAnimationFrame(() => nameInput.value?.focus())
}

// ── 模板管理弹窗：列出 / 新建 / 编辑 / 删除 ──
const tplOpen = ref(false)
const tplBox = ref<HTMLElement | null>(null)
const tplErr = ref('')
const tplBusy = ref(false)
/** 正在编辑的模板 id；null = 新建态 */
const tplEditing = ref<number | null>(null)
const tplForm = ref({
  name: '', description: '', expr: '', command: '',
  user: 'root', timeout_sec: 1800, webhook_url: '',
})
const tplDel = ref<Tpl | null>(null)

function resetTplForm() {
  tplEditing.value = null
  tplForm.value = {
    name: '', description: '', expr: '', command: '',
    user: 'root', timeout_sec: 1800, webhook_url: '',
  }
  tplErr.value = ''
}

function openTplManager() {
  tplOpen.value = true
  resetTplForm()
  loadTemplates()
}
function closeTplManager() {
  tplOpen.value = false
  tplDel.value = null
  resetTplForm()
}
const { close: closeTplModal } = useModal(() => tplOpen.value, tplBox, closeTplManager)

function editTemplate(t: Tpl) {
  tplEditing.value = t.id
  tplForm.value = {
    name: t.name, description: t.description, expr: t.expr, command: t.command,
    user: t.user, timeout_sec: t.timeout_sec, webhook_url: t.webhook_url ?? '',
  }
  tplErr.value = ''
}

const tplNameIssue = computed(() => {
  const v = tplForm.value.name.trim()
  if (!v) return null
  return v.length > 64 ? '模板名最多 64 个字符' : null
})

async function saveTemplate() {
  tplErr.value = ''
  // 前置校验与后端同口径：名称/表达式/命令必填，超时 1~604800
  const name = tplForm.value.name.trim()
  if (!name) { tplErr.value = '请填写模板名'; return }
  if (name.length > 64) { tplErr.value = '模板名最多 64 个字符'; return }
  if (tplForm.value.description.length > 200) { tplErr.value = '说明最多 200 个字符'; return }
  if (!tplForm.value.expr.trim()) { tplErr.value = '请填写 cron 表达式'; return }
  if (!tplForm.value.command.trim()) { tplErr.value = '请填写命令'; return }
  const to = Number(tplForm.value.timeout_sec)
  if (!Number.isFinite(to) || to < 1 || to > 604800) {
    tplErr.value = '超时需为 1-604800 之间的整数（秒）'
    return
  }
  tplBusy.value = true
  const body = {
    name, description: tplForm.value.description.trim(),
    expr: tplForm.value.expr.trim(), command: tplForm.value.command,
    user: tplForm.value.user.trim() || 'root',
    timeout_sec: to,
    webhook_url: tplForm.value.webhook_url.trim(),
  }
  try {
    if (tplEditing.value == null) {
      await api.post(API.cron.templates(), body)
      toast(`已创建模板「${name}」`)
    } else {
      await api.put(API.cron.template(tplEditing.value), body)
      toast(`已保存模板「${name}」`)
    }
    resetTplForm()
    await loadTemplates()
    // 选择框里的旧选项可能已被改名/删除，重置避免指向不存在的 id
    if (tplPick.value && !templates.value.some(t => String(t.id) === tplPick.value)) tplPick.value = ''
  } catch (e) { tplErr.value = errorText(e) }
  finally { tplBusy.value = false }
}

async function deleteTemplate() {
  if (!tplDel.value) return
  const t = tplDel.value
  tplDel.value = null
  tplErr.value = ''
  try {
    await api.del(API.cron.template(t.id))
    toast(`已删除模板「${t.name}」`)
    if (tplEditing.value === t.id) resetTplForm()
    if (tplPick.value === String(t.id)) { tplPick.value = ''; tplNote.value = '' }
    await loadTemplates()
  } catch (e) { tplErr.value = errorText(e) }
}
</script>

<template>
  <div>
    <EmptyState v-if="!auth.supported(CAP.SCHEDULER_MANAGE)"
      title="当前环境不支持计划任务"
      :reason="auth.capabilities[CAP.SCHEDULER_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
      <!-- 提示条：提交执行后给的是**可点的**任务中心深链（带 ?task=id 直达那条输出）。
           此前把「去任务中心可看输出」写成纯文本，用户只能自己找入口。 -->
      <p v-if="note" class="note" role="status">
        {{ note }}
        <RouterLink v-if="lastTaskId != null" class="note-link"
          :to="{ path: '/cron/tasks', query: { task: String(lastTaskId) } }">去任务中心查看输出</RouterLink>
      </p>

      <section class="card cron-create" id="cron-create-card">
        <div class="sec-head">
          <Icon name="clock" :size="16" /> 新建任务
          <span class="spacer" />
          <label class="head-switch">
            <span class="switch"><input type="checkbox" v-model="form.enabled" /><i /></span>
            启用
          </label>
        </div>
        <!-- 模板入口：只做「填充」，不做「绑定」。选了模板就把字段灌进下面的表单，
             之后怎么改都是这次新建的事，模板本身不受影响。
             没有模板时这一条整体不渲染——手动创建路径完全不受影响。 -->
        <div v-if="templates.length" class="tpl-bar">
          <label class="tpl-pick">
            <span>模板</span>
            <select v-model="tplPick" aria-label="从模板填充新建任务表单" @change="applyTemplate">
              <option value="">不使用模板（手动填写）</option>
              <option v-for="t in templates" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
            </select>
          </label>
          <span v-if="tplNote" class="tpl-note">{{ tplNote }}</span>
          <button v-if="canManage" type="button" class="btn-ghost btn-sm tpl-manage" @click="openTplManager">
            <Icon name="gear" :size="13" /> 管理模板
          </button>
        </div>
        <!-- 一个模板都没有时，仍给管理入口（否则第一次就永远建不了模板） -->
        <p v-else-if="canManage" class="tpl-empty">
          还没有任务模板。<button type="button" class="link-btn" @click="openTplManager">创建一个</button>
          ，之后新建任务可一键填充常用字段。
        </p>

        <CronScheduleBar v-model="form.expr" :disabled="createBusy" />

        <div class="cron-fields">
          <label>名称<input ref="nameInput" v-model="form.name" placeholder="backup-db"
            aria-describedby="cron-name-hint" /></label>
          <label>表达式<input v-model="form.expr" placeholder="0 3 * * *" /></label>
          <label>命令<input v-model="form.command" placeholder="/usr/local/bin/backup.sh" /></label>
          <label>执行用户<input v-model="form.user" placeholder="root" /></label>
          <label>超时(秒)<input v-model.number="form.timeout_sec" type="number" min="1" max="604800" /></label>
          <label>Webhook URL<input v-model="form.webhook_url" placeholder="留空 = 不回调" /></label>
        </div>
        <!-- 名称格式提示：只在用户真的开始输入后才出现，空表单不先甩红字 -->
        <p v-if="nameWarn" id="cron-name-hint" class="field-err">{{ nameWarn }}</p>
        <p v-if="formErr" class="err-bar" role="alert">{{ formErr }}</p>

        <div class="cron-actions">
          <button class="btn-primary" :disabled="!canManage || createBusy || !form.name || !form.expr || !form.command" @click="create">
            {{ createBusy ? '创建中…' : '创建' }}</button>
          <button class="btn-ghost" :disabled="!form.expr || previewBusy" @click="doPreview(form.expr)">
            {{ previewBusy ? '计算中…' : '预览执行时刻' }}
          </button>
        </div>
        <p v-if="previewExpr === form.expr" class="tip preview-tip">
          下次执行（本地时间）：<span class="mono">{{ previewNext.length ? previewNext.map(fmtDateTime).join('　') : '一年内无命中（检查日期字段）' }}</span>
        </p>
        <div class="webhook-test">
          <label>Webhook 测试地址<input v-model="webhookUrl" placeholder="https://example.com/hook" :disabled="webhookBusy" /></label>
          <button class="btn-ghost" :disabled="!canManage || !webhookUrl || webhookBusy" @click="testWebhook">
            <Icon name="bell" :size="14" /> {{ webhookBusy ? '测试中…' : '测试连通性' }}
          </button>
        </div>
      </section>

      <!-- 动作收进卡片顶栏（同 ProcessesView 范式）：去掉只放一个「刷新」的页面级
           page-head 横条；横滚交给内部 .t-scroll。
           ⚠️ 卡片不再用 v-if="jobs.length"——否则空列表时整张卡（含刷新）一起消失，
           刷新按钮就点不到了。空态改为下方独立的 v-if="!jobs.length"。 -->
      <div class="card flush toolbar-card">
        <div class="card-toolbar">
          <Icon name="clock" :size="16" />
          <span class="count">
            <template v-if="q.trim()">找到 {{ filteredJobs.length }} / 共 {{ jobs.length }} 个任务</template>
            <template v-else>共 {{ jobs.length }} 个任务</template>
          </span>
          <span class="spacer" />
          <input v-model="q" class="filter" type="search" placeholder="搜索名称 / 命令 / 表达式…"
            aria-label="搜索计划任务" />
          <button v-if="q" class="btn-ghost btn-sm" type="button" title="清空搜索" @click="q = ''">清空</button>
          <RefreshBtn sm @click="load" />
        </div>
        <div class="t-scroll">
        <div v-if="loading && !jobs.length" class="skeleton box" />
        <table v-else-if="jobs.length" class="fixed" v-table-nav>
          <!-- 列宽：命令为唯一弹性列；用户列窄屏隐藏（.col-opt，多为 root/面板用户）。 -->
          <colgroup>
            <col class="w-cjid" /><col class="w-cjexpr" /><col class="w-cjcmd" /><col class="w-cjuser" /><col class="w-cjlast" /><col class="w-cjnext" /><col class="w-cjacts" />
          </colgroup>
          <thead><tr>
            <SortTh label="名称" :active="isSorted('id')" :dir="sortDir" @sort="toggleSort('id')" />
            <SortTh label="表达式" :active="isSorted('expr')" :dir="sortDir" @sort="toggleSort('expr')" />
            <SortTh label="命令" :active="isSorted('command')" :dir="sortDir" @sort="toggleSort('command')" />
            <SortTh class="col-opt" label="用户" :active="isSorted('user')" :dir="sortDir" @sort="toggleSort('user')" />
            <SortTh label="上次执行" :active="isSorted('last_run_at')" :dir="sortDir" @sort="toggleSort('last_run_at')" />
            <SortTh class="col-next" label="下次预览" :active="isSorted('next')" :dir="sortDir" @sort="toggleSort('next')" />
            <th />
          </tr></thead>
          <tbody>
            <tr v-for="j in pageRows" :key="j.id">
              <td class="ellipsis" :title="j.id">{{ j.id }}</td>
              <td class="mono">{{ j.expr }}</td>
              <td class="mono dim ellipsis" :title="j.command">{{ j.command }}</td>
              <td class="col-opt">{{ j.user }}</td>
              <!-- 「上次执行」必须带成败：此前只显示时间，用户看到「10-20 03:00」却不知道
                   那次成没成（`last_status` 在后端有回写、前端类型里也声明了，但从没渲染）。
                   取值来自后端 `run_outcome`：ok / exit N / killed：… -->
              <td class="last-cell">
                <span class="last-time">{{ fmtDateTime(j.last_run_at) }}</span>
                <span v-if="j.last_run_at != null && j.last_status" class="badge last-status"
                  :class="lastStatusBadge(j.last_status)" :title="j.last_status">{{ j.last_status }}</span>
              </td>
              <td class="dim col-next">
                <span v-for="(t, i) in j.next.slice(0, 2)" :key="i">{{ fmtDateTime(t) }}<br /></span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || runBusy === j.id"
                  title="立即执行一次（不等到表达式触发的时刻）" @click="runNow(j)">
                  <Icon name="play" :size="14" /> {{ runBusy === j.id ? '提交中' : '执行' }}
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage"
          :title="canManage ? '' : '无 cron.manage 权限'" @click="openEdit(j)">编辑</button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage"
          :title="canManage ? '' : '无 cron.manage 权限'" @click="del = j">删除</button>
              </td>
            </tr>
            <tr v-if="!pageRows.length"><td colspan="7">
              <EmptyState :title="`没有匹配「${q.trim()}」的任务`"
                hint="换个关键词，或清空搜索查看全部任务。">
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
      <EmptyState v-if="!loading && !jobs.length" title="暂无计划任务"
        hint="用上方的「新建任务」卡片添加第一个定时任务，例如每天凌晨备份数据库。">
        <template #cta>
          <button class="btn-primary" type="button" :disabled="!canManage"
            @click="focusCreateCard('cron-create-card')">
            <Icon name="plus" :size="13" /> 去新建任务
          </button>
        </template>
      </EmptyState>

      <ConfirmDialog :open="!!del" danger title="删除计划任务"
        :detail="`将删除 ${del?.id}，该任务的后续执行会一并取消。`"
        @confirm="doDelete" @cancel="del = null" />

      <!-- 编辑弹窗：PATCH /cron/jobs/{id}。浮层 Teleport 到 body，避免被祖先裁切 -->
      <Teleport to="body">
      <div v-if="edit" class="mask" @click.self="closeEditModal">
        <div ref="editBox" class="modal wide stack" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-title">
              <h3 class="mono">{{ edit.id }}</h3>
              <p class="modal-lead">修改将直接写入 crontab 并同步面板元数据</p>
            </div>
            <!-- 统一关闭按钮（此前是文字符号 ✕，字重与基线随字体漂移） -->
            <button class="modal-close" type="button" aria-label="关闭" @click="closeEditModal">
              <Icon name="close" :size="16" />
            </button>
          </div>

          <p v-if="editError" class="err-bar" role="alert">{{ editError }}</p>

          <CronScheduleBar v-model="editForm.expr" :disabled="editBusy" />

          <div class="row">
            <label>表达式<input v-model="editForm.expr" placeholder="0 3 * * *" :disabled="editBusy" /></label>
            <label>执行用户<input v-model="editForm.user" placeholder="root" :disabled="editBusy" /></label>
            <label>超时(秒)<input v-model.number="editForm.timeout_sec" type="number" min="1" max="604800" :disabled="editBusy" /></label>
          </div>
          <div class="field"><label>命令</label><input v-model="editForm.command" placeholder="/usr/local/bin/backup.sh" :disabled="editBusy" /></div>
          <label class="switch-row">
            <span>启用</span>
            <span class="switch">
              <input type="checkbox" v-model="editForm.enabled" :disabled="editBusy" /><i />
            </span>
          </label>
          <p class="tip">按当前平台的 cron 格式填写；格式有误会在下方原样提示。</p>
          <p v-if="previewExpr === editForm.expr" class="tip">
            下次执行（本地时间）：<span class="mono">{{ previewNext.length ? previewNext.map(fmtDateTime).join('　') : '一年内无命中（检查日期字段）' }}</span>
          </p>

          <div class="modal-foot">
            <div class="modal-actions">
              <button class="btn-ghost" :disabled="editBusy" @click="closeEditModal">取消</button>
            <button class="btn-ghost" :disabled="!editForm.expr || previewBusy" @click="doPreview(editForm.expr)">
              {{ previewBusy ? '计算中…' : '预览执行时刻' }}
            </button>
            <button class="btn-ghost" :disabled="!canManage || trigBusy === edit?.id" @click="triggerWebhook(edit)">
              <Icon name="bell" :size="14" /> {{ trigBusy === edit?.id ? '触发中…' : '触发 Webhook' }}
            </button>
            <span class="spacer" />
            <button class="btn-primary" :disabled="editBusy || !editForm.expr || !editForm.command || !(Number(editForm.timeout_sec) >= 1 && Number.isFinite(Number(editForm.timeout_sec)))"
                    @click="saveEdit">
              {{ editBusy ? '保存中…' : '保存' }}
            </button>
            </div>
          </div>
        </div>
      </div>
      </Teleport>

      <!-- 确认框叠在模板管理弹窗之上：必须 level2，否则同 z-index 下谁在上碰运气 -->
      <ConfirmDialog :open="!!tplDel" danger level2 title="删除任务模板"
        :detail="`将删除模板「${tplDel?.name}」。已用它创建过的任务不受影响（模板只是新建时的预置字段）。`"
        @confirm="deleteTemplate" @cancel="tplDel = null" />

      <!-- 模板管理弹窗。⚠ 必须留在 v-if="tplOpen" 块之外的**根层级**：
           浮层若被塞进条件块内，编译器与单测都察觉不到，真机一个 .mask 都不出。
           且 Teleport 到 body——祖先有 backdrop-filter 会造 fixed 包含块。 -->
      <Teleport to="body">
      <div v-if="tplOpen" class="mask" @click.self="closeTplModal">
        <div ref="tplBox" class="modal wide stack" role="dialog" aria-modal="true" aria-label="任务模板管理">
          <div class="modal-head">
            <div class="modal-title">
              <h3>任务模板</h3>
              <p class="modal-lead">模板只是新建任务时的预置字段，改模板不会影响已创建的任务</p>
            </div>
            <button class="modal-close" type="button" aria-label="关闭" @click="closeTplModal">
              <Icon name="close" :size="16" />
            </button>
          </div>

          <p v-if="tplErr" class="err-bar" role="alert">{{ tplErr }}</p>

          <!-- 已有模板列表 -->
          <div v-if="templates.length" class="tpl-list">
            <div v-for="t in templates" :key="t.id" class="tpl-item" :class="{ 'is-editing': tplEditing === t.id }">
              <div class="tpl-item-main">
                <div class="tpl-item-name">
                  <span class="mono">{{ t.name }}</span>
                  <span v-if="t.description" class="tpl-item-desc">{{ t.description }}</span>
                </div>
                <div class="tpl-item-sub mono">{{ t.expr }} · {{ t.user }} · {{ t.timeout_sec }}s</div>
              </div>
              <button type="button" class="btn-ghost btn-sm" @click="editTemplate(t)">编辑</button>
              <button type="button" class="btn-ghost btn-sm danger-ghost" @click="tplDel = t">删除</button>
            </div>
          </div>
          <p v-else class="tip">还没有模板。填下表建第一个即可。</p>

          <div class="tpl-form">
            <div class="sec-head">{{ tplEditing == null ? '新建模板' : '编辑模板' }}</div>
            <CronScheduleBar v-model="tplForm.expr" :disabled="tplBusy" />
            <div class="row">
              <label>模板名<input v-model="tplForm.name" :disabled="tplBusy" placeholder="每日备份" aria-describedby="tpl-name-hint" /></label>
              <label>表达式<input v-model="tplForm.expr" :disabled="tplBusy" placeholder="0 3 * * *" /></label>
              <label>执行用户<input v-model="tplForm.user" :disabled="tplBusy" placeholder="root" /></label>
            </div>
            <p v-if="tplNameIssue" id="tpl-name-hint" class="field-err">{{ tplNameIssue }}</p>
            <div class="field">
              <label>说明<input v-model="tplForm.description" :disabled="tplBusy" placeholder="可选，例如：每天凌晨备份数据库" /></label>
            </div>
            <div class="field">
              <label>命令<input v-model="tplForm.command" :disabled="tplBusy" placeholder="/usr/local/bin/backup.sh" /></label>
            </div>
            <div class="row">
              <label>超时(秒)<input v-model.number="tplForm.timeout_sec" type="number" min="1" max="604800" :disabled="tplBusy" /></label>
              <label>Webhook URL<input v-model="tplForm.webhook_url" :disabled="tplBusy" placeholder="留空 = 不回调" /></label>
            </div>
            <div class="modal-actions">
              <button v-if="tplEditing != null" type="button" class="btn-ghost" :disabled="tplBusy" @click="resetTplForm">改为新建</button>
              <span class="spacer" />
              <button type="button" class="btn-primary"
                :disabled="tplBusy || !tplForm.name.trim() || !tplForm.expr.trim() || !tplForm.command.trim()"
                @click="saveTemplate">
                {{ tplBusy ? '保存中…' : (tplEditing == null ? '创建模板' : '保存修改') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
/* 弹窗取公共 .mask / .modal.wide.stack / .modal-head / .modal-close / .modal-actions；
   本页不再保留 .m-head / .m-desc / .m-acts 私有结构式样（与全站弹窗漂移） */

/* 编辑弹窗里的独立开关（不在 .row 内，保持横排） */
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--c-text-dim); cursor: pointer; user-select: none; }

/* 新建任务卡片：字段收进两列网格、开关移到标题栏、测试区单独成行。
   此前卡片实测 792px，把列表推到 y=934（首屏完全看不到任务）；目标压到 450px 内。 */
.cron-create { margin-bottom: 12px; }
.cron-create .sec-head { margin-bottom: 12px; }
.head-switch { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-13);
  color: var(--c-text-dim); cursor: pointer; user-select: none; }
.cron-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 988px; gap: 10px 14px; }
.cron-fields label { display: flex; flex-direction: column; gap: 4px; min-width: 0;
  font-size: var(--fs-12); color: var(--c-text-dim); }
.cron-fields input { width: 100%; height: 38px; }
.cron-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.preview-tip { margin-top: 8px; }
/* Webhook 测试是独立工具（可测任意地址，不等于上面任务的回调地址）；
   用一条分隔线 + 明确字段名把它和创建表单区分开，避免误当成两个重复输入框。 */
.webhook-test { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--c-border); }
.webhook-test label { flex: 0 1 320px; display: flex; flex-direction: column; gap: 4px;
  font-size: var(--fs-12); color: var(--c-text-dim); }
.webhook-test input { width: 100%; height: 38px; }

/* 任务表列宽：固定像素而非百分比——百分比在窄屏会把「命令」均摊到 37px。
   命令为唯一弹性列；上次执行/下次预览各自容两行，操作列容三个按钮不折行。 */
col.w-cjid { width: 118px; }
col.w-cjexpr { width: 116px; }
col.w-cjcmd { width: auto; }
col.w-cjuser { width: 72px; }
col.w-cjlast { width: 168px; }
col.w-cjnext { width: 140px; }
col.w-cjacts { width: 190px; }
/* 上次执行：时间戳与结果徽标分两行，行高不再被徽标文案撑成两种 */
.last-cell { white-space: normal; }
.last-time { display: block; font-variant-numeric: tabular-nums; }
.last-status { display: inline-block; margin-top: 3px; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
/* 窄屏依次收掉次要列，把宽度让给命令（比把每列都压到读不出强）。 */
@media (max-width: 1280px) {
  /* col 必须真正移除；只设 width:0 仍占一列，会让后面的 th/td 整体错位一列 */
  col.w-cjuser, th.col-opt, td.col-opt { display: none; }
}
@media (max-width: 1100px) {
  col.w-cjnext, th.col-next, td.col-next { display: none; }
  .cron-fields { grid-template-columns: minmax(0, 480px); }
}
/* 提交执行后的「去任务中心」链接：与提示文案同基线、主色可点 */
.note-link { margin-left: 10px; color: var(--c-primary); font-weight: 600; text-decoration: none; }
.note-link:hover { text-decoration: underline; }

/* ───────── 任务模板 ───────── */
/* 模板栏是「前置动作」不是表单字段：单行 inline 排布，压掉全局 select 的 100% 宽。 */
.tpl-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 8px; margin-bottom: 10px; border-bottom: 1px dashed var(--c-border); }
.tpl-pick { display: flex; flex-direction: row; align-items: center; gap: 8px;
  font-size: var(--fs-13); color: var(--c-text-dim); }
.tpl-pick select { width: auto; min-width: 200px; max-width: 100%; height: 34px; }
.tpl-note { font-size: var(--fs-13); color: var(--c-text-dim); flex: 1 1 200px; min-width: 0; }
/* 「管理模板」单独靠右，换行也靠右 */
.tpl-manage { margin-left: auto; white-space: nowrap; }
.tpl-empty { margin: 0 0 10px; font-size: var(--fs-13); color: var(--c-text-dim); }
.tpl-empty .link-btn { padding: 0; border: 0; background: none; color: var(--c-primary);
  font: inherit; font-weight: 600; cursor: pointer; }
.tpl-empty .link-btn:hover { text-decoration: underline; }

/* 模板列表：一行一个，名称与说明同排（说明可截断），副行放表达式/用户/超时 */
.tpl-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; }
.tpl-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border: 1px solid var(--c-border); border-radius: var(--r-sm, 8px); }
.tpl-item.is-editing { border-color: var(--c-primary); background: var(--c-primary-soft); }
.tpl-item-main { flex: 1 1 auto; min-width: 0; }
.tpl-item-name { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.tpl-item-name .mono { font-weight: 600; }
.tpl-item-desc { font-size: var(--fs-13); color: var(--c-text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpl-item-sub { font-size: var(--fs-13); color: var(--c-text-dim); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.danger-ghost:hover:not(:disabled) { color: var(--c-danger); border-color: var(--c-danger); }
/* 表单与列表之间留出呼吸空间 */
.tpl-form { margin-top: 12px; }
</style>

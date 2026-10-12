<script setup lang="ts">
/**
 * 计划任务（用户 cron，不是面板内部任务）。
 *
 * 刻意说清一件事：表达式是**平台本地语义**。Linux 是 cron 五段，
 * Windows/macOS 完全不同。所以 UI 只负责收集字符串，校验交给后端，
 * 并把后端返回的校验错误原样展示 —— 前端绝不自作聪明地"帮你解析"。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, cronKindLabel, fmtDateTime } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'

interface Job {
  id: string; expr: string; command: string; user: string
  enabled: boolean; timeout_sec: number
  last_run_at: number | null; last_status: string | null; next: number[]
}

const auth = useAuthStore()
const jobs = ref<Job[]>([])
const error = ref('')
const note = ref('')
const form = ref({ name: '', expr: '', command: '', user: 'root' })
const del = ref<Job | null>(null)

// 编辑态：PATCH /api/v1/cron/jobs/{id}
const edit = ref<Job | null>(null)
const editForm = ref({ expr: '', command: '', user: '', enabled: true, timeout_sec: 60 })
const editBusy = ref(false)
const editError = ref('')

async function load() {
  error.value = ''; note.value = ''
  // 请求级门控：系统无 crontab 时 scheduler.manage=no，列表端点返 501
  if (!auth.supported(CAP.SCHEDULER_MANAGE)) return
  try { jobs.value = await api.get<Job[]>(API.cron.jobs()) }
  catch (e) { error.value = errorText(e); jobs.value = [] }
}

// 手动触发一次：后端把它排进任务队列并立刻返回 task_id，
// 不在请求里等脚本跑完（脚本可能跑几分钟，HTTP 请求等不起）。
const runBusy = ref<string | null>(null)
async function runNow(j: Job) {
  runBusy.value = j.id; error.value = ''; note.value = ''
  try {
    const r = await api.post<{ task_id: number; created: boolean }>(API.cron.run(j.id), {})
    note.value = `已提交执行「${j.id}」（任务 #${r.task_id}），去任务中心可看输出`
    load()
  } catch (e) { error.value = errorText(e) }
  finally { runBusy.value = null }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.SCHEDULER_MANAGE, 'cron.manage'))

// 创建按钮加 busy 态（审计 U8）：此前请求期间按钮可重复点击，产生重复任务
const createBusy = ref(false)
async function create() {
  error.value = ''
  createBusy.value = true
  try {
    await api.post(API.cron.jobs(), {
      name: form.value.name, expr: form.value.expr,
      command: form.value.command, user: form.value.user,
    })
    form.value = { name: '', expr: '', command: '', user: 'root' }
    load()
  } catch (e) { error.value = errorText(e) }
  finally { createBusy.value = false }
}

async function doDelete() {
  if (!del.value) return
  try { await api.del(API.cron.job(del.value.id)); del.value = null; load() }
  catch (e) { error.value = errorText(e) }
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
    error.value = errorText(e)
  } finally { previewBusy.value = false }
}

async function saveEdit() {
  if (!edit.value) return
  if (!canManage.value) { editError.value = '无计划任务管理权限'; return }
  editBusy.value = true; editError.value = ''
  try {
    await api.patch(API.cron.job(edit.value.id), {
      expr: editForm.value.expr,
      command: editForm.value.command,
      user: editForm.value.user,
      enabled: editForm.value.enabled,
      timeout_sec: Number(editForm.value.timeout_sec),
    })
    closeEdit(); load()
  } catch (e) { editError.value = errorText(e) }
  finally { editBusy.value = false }
}

function fmt(ts: number | null) { return fmtDateTime(ts) }

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
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <button class="btn-primary" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.SCHEDULER_MANAGE)"
      title="当前环境不支持计划任务"
      :reason="auth.capabilities[CAP.SCHEDULER_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="note" class="note" role="status">{{ note }}</p>

      <section class="card">
        <div class="sec-head"><Icon name="clock" :size="16" /> 新建任务</div>
        <div class="row">
          <label>名称<input v-model="form.name" placeholder="backup-db" /></label>
          <label>表达式<input v-model="form.expr" placeholder="0 3 * * *" /></label>
          <label>执行用户<input v-model="form.user" placeholder="root" /></label>
        </div>
        <div class="field"><label>命令</label><input v-model="form.command" placeholder="/usr/local/bin/backup.sh" /></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn-primary" :disabled="!canManage || createBusy || !form.name || !form.expr || !form.command" @click="create">
            {{ createBusy ? '创建中…' : '创建' }}</button>
          <button class="btn-ghost" :disabled="!form.expr || previewBusy" @click="doPreview(form.expr)">
            {{ previewBusy ? '计算中…' : '预览执行时刻' }}
          </button>
        </div>
        <div class="field webhook-test">
          <label>测试 Webhook URL
            <input v-model="webhookUrl" placeholder="https://example.com/hook" :disabled="webhookBusy" />
          </label>
          <button class="btn-ghost" :disabled="!canManage || !webhookUrl || webhookBusy" @click="testWebhook">
            <Icon name="bell" :size="14" /> {{ webhookBusy ? '测试中…' : '测试连通性' }}
          </button>
        </div>
        <p v-if="previewExpr === form.expr" class="tip">
          下次执行（本地时间）：<span class="mono">{{ previewNext.length ? previewNext.map(fmt).join('　') : '一年内无命中（检查日期字段）' }}</span>
        </p>
        <p class="tip">表达式格式由当前平台决定，校验错误将原样返回。</p>
      </section>

      <div class="card flush" v-if="jobs.length">
        <table class="fixed">
          <!-- 列宽：命令为唯一弹性列；用户列窄屏隐藏（.col-opt，多为 root/面板用户）。 -->
          <colgroup>
            <col class="w-cjid" /><col class="w-cjexpr" /><col class="w-cjcmd" /><col class="w-cjuser" /><col class="w-cjlast" /><col class="w-cjnext" /><col class="w-cjacts" />
          </colgroup>
          <thead><tr><th>名称</th><th>表达式</th><th>命令</th><th class="col-opt">用户</th><th>上次执行</th><th>下次预览</th><th /></tr></thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td class="ellipsis" :title="j.id">{{ j.id }}</td>
              <td class="mono">{{ j.expr }}</td>
              <td class="mono dim ellipsis" :title="j.command">{{ j.command }}</td>
              <td class="col-opt">{{ j.user }}</td>
              <td class="nowrap">{{ fmt(j.last_run_at) }}</td>
              <td class="dim">
                <span v-for="(t, i) in j.next.slice(0, 2)" :key="i">{{ fmt(t) }}<br /></span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || runBusy === j.id"
                  title="立即执行一次（不等到表达式触发的时刻）" @click="runNow(j)">
                  <Icon name="play" :size="14" /> {{ runBusy === j.id ? '提交中' : '执行' }}
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage" @click="openEdit(j)">编辑</button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage" @click="del = j">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无计划任务" />

      <ConfirmDialog :open="!!del" danger title="删除计划任务"
        :detail="`将删除 ${del?.id}，该任务的后续执行会一并取消。`"
        @confirm="doDelete" @cancel="del = null" />

      <!-- 编辑弹窗：PATCH /cron/jobs/{id} -->
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
          <p class="tip">表达式格式由当前平台决定，校验错误将原样返回。</p>
          <p v-if="previewExpr === editForm.expr" class="tip">
            下次执行（本地时间）：<span class="mono">{{ previewNext.length ? previewNext.map(fmt).join('　') : '一年内无命中（检查日期字段）' }}</span>
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
            <button class="btn-primary" :disabled="editBusy || !editForm.expr || !editForm.command"
                    @click="saveEdit">
              {{ editBusy ? '保存中…' : '保存' }}
            </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 弹窗取公共 .mask / .modal.wide.stack / .modal-head / .modal-close / .modal-actions；
   本页不再保留 .m-head / .m-desc / .m-acts 私有结构式样（与全站弹窗漂移） */
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--c-text-dim); cursor: pointer; user-select: none; }
/* 实心主色底 + 白滑块、42×24：旧版 --c-primary-soft 浅色底开销/关都偏浅橙、对比弱。
   与 ServiceDetailView（开机自启）、SitesView（自动续期）保持同一套开关外观。 */
/* 任务表列宽（站点表范式）：命令为唯一弹性列；操作列 220px 容下
   执行 / 编辑 / 删除 3 个按钮（「提交中…」文案更宽）。 */
col.w-cjid { width: 10%; }
col.w-cjexpr { width: 12%; }
col.w-cjcmd { width: auto; }
col.w-cjuser { width: 8%; }
col.w-cjlast { width: 15%; }
col.w-cjnext { width: 15%; }
col.w-cjacts { width: 220px; }
/* Webhook 测试行：输入与按钮底部对齐 */
.webhook-test { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.webhook-test label { flex: 1 1 280px; }
.webhook-test input { width: 100%; }
</style>

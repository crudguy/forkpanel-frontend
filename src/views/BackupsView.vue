<script setup lang="ts">
/**
 * 备份（本地）。
 *
 * 能力边界：备份计划（panel = 面板自身数据；site = 站点文件）+ 立即执行 + 产物列表。
 * **恢复**是高危操作（覆盖当前数据），后端尚未接入，此处按钮置灰并说明。
 * 远端存储（S3/WebDAV）亦为后续。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

interface Plan {
  id: number; kind: string; target: string; cron_expr: string | null
  keep_count: number; dest_dir: string; enabled: boolean
  last_run_at: number | null; last_result: string | null
}
interface Artifact { name: string; size: number; mtime: number }

const auth = useAuthStore()
const plans = ref<Plan[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const form = ref({ kind: 'panel', target: 'panel', dest_dir: 'plans', cron_expr: '', keep_count: 7 })

const curArtifacts = ref<{ plan: Plan; items: Artifact[] } | null>(null)

const canManage = computed(() => auth.enabled(CAP.BACKUP_MANAGE, 'backup.manage'))

async function load() {
  error.value = ''; notice.value = ''
  try { plans.value = await api.get<Plan[]>(API.backups.list()) }
  catch (e) { error.value = errorText(e); plans.value = [] }
}
onMounted(load)

async function create() {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.post(API.backups.create(), {
      kind: form.value.kind,
      target: form.value.kind === 'panel' ? 'panel' : form.value.target.trim(),
      dest_dir: form.value.dest_dir.trim() || 'plans',
      cron_expr: form.value.cron_expr.trim() || undefined,
      keep_count: form.value.keep_count,
    })
    form.value = { kind: 'panel', target: 'panel', dest_dir: 'plans', cron_expr: '', keep_count: 7 }
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

async function runPlan(p: Plan) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const r = await api.post<{ task_id: number }>(API.backups.run(p.id), {})
    notice.value = `已提交备份任务 #${r.task_id}（在任务中心可见）；稍后点「产物」查看`
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false; await load() }
}

async function del(p: Plan) {
  if (!window.confirm(`确认删除备份计划 #${p.id}（${p.kind}/${p.target}）？\n\n注意：**不会删除已生成的产物文件**。`)) return
  busy.value = true; error.value = ''
  try { await api.del(API.backups.remove(p.id)); await load() }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

async function showArtifacts(p: Plan) {
  error.value = ''
  try {
    const items = await api.get<Artifact[]>(API.backups.artifacts(p.id))
    curArtifacts.value = { plan: p, items }
  } catch (e) { error.value = errorText(e) }
}

/** 选中的产物名（恢复目标）。产物按名称倒序，默认取最新一份。 */
const selName = ref('')

/**
 * 从选中产物恢复（**高危**）。
 *
 * 后端三道闸门：确认词 + 产物名白名单 + 任务内自动先备份当前态。
 * 前端这里只负责把"确认"这件事做实：必须手输确认词，不接受一个随手点的 OK。
 */
async function restoreFrom() {
  error.value = ''
  notice.value = ''
  if (!curArtifacts.value) return
  const plan = curArtifacts.value.plan

  // panel 库是面板自身运行中的库：在线覆盖会损坏 SQLite WAL —— 诚实拒绝，不给假按钮
  if (plan.kind === 'panel') {
    notice.value =
      '面板库不支持在线恢复：它是面板自身运行中的库，在线覆盖会损坏 SQLite WAL。请先停止 panel 服务后手动替换。'
    return
  }
  const name = selName.value || curArtifacts.value.items[0]?.name
  if (!name) {
    error.value = '该计划还没有任何产物，请先执行一次备份'
    return
  }

  const word = window.prompt(
    `即将用「${name}」覆盖 ${plan.target} 的当前数据。\n\n` +
      '任务内会自动先备份当前态（safety 快照，可从任务详情取回），但此操作仍不可逆。\n\n' +
      '请输入「覆盖恢复」以继续：',
  )
  if (word === null) return
  if (word.trim() !== '覆盖恢复') {
    error.value = '确认词不匹配，已取消'
    return
  }

  busy.value = true
  try {
    const r = await api.post<{ task_id: string }>(API.backups.restore(plan.id), {
      artifact: name,
      confirm_token: '覆盖恢复',
    })
    notice.value = `恢复任务已提交（${r.task_id}）。可在「任务中心」查看进度；如需回滚，任务详情里的 output_path 指向恢复前的快照。`
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtTime(t: number | null) {
  return t ? new Date(t * 1000).toLocaleString() : '—'
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">备份</h2>
        <p class="page-sub">本地备份计划 · 手动执行 · 产物列表（恢复为高危后续）</p>
      </div>
      <span class="spacer" />
      <button class="btn-primary" :disabled="busy" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.BACKUP_MANAGE)"
      title="当前环境不支持备份"
      :reason="auth.capabilities[CAP.BACKUP_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="note" role="alert">{{ error }}</p>
      <p v-if="notice" class="ok-note">{{ notice }}</p>

      <section class="card">
        <div class="sec-head"><Icon name="disk" :size="16" /> 新建备份计划</div>
        <div class="row">
          <label>类型
            <select v-model="form.kind">
              <option value="panel">面板数据（SQLite 在线备份）</option>
              <option value="site">站点文件（tar.gz）</option>
            </select>
          </label>
          <label>目标
            <input v-model="form.target" :disabled="form.kind === 'panel'"
              :placeholder="form.kind === 'panel' ? 'panel' : '站点名（如 my-site）'" />
          </label>
          <label>产物子目录
            <input v-model="form.dest_dir" placeholder="plans（相对面板备份根）" />
          </label>
          <label>保留份数<input v-model.number="form.keep_count" type="number" min="1" max="365" /></label>
          <label>cron（可空）
            <input v-model="form.cron_expr" placeholder="留空=仅手动" />
          </label>
          <button class="btn-primary" :disabled="!canManage || busy || (form.kind === 'site' && !form.target.trim())" @click="create">添加</button>
        </div>
        <p class="tip">产物落在面板备份根目录之下（相对路径，防越界）。<b>不提供远端存储</b>（S3/WebDAV 后续）。</p>
      </section>

      <div class="card flush" v-if="plans.length">
        <table>
          <thead><tr><th>#</th><th>类型</th><th>目标</th><th>产物目录</th><th>保留</th><th>上次执行</th><th /></tr></thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td>{{ p.id }}</td>
              <td>{{ p.kind }}</td>
              <td class="mono">{{ p.target }}</td>
              <td class="dim mono">{{ p.dest_dir }}</td>
              <td>{{ p.keep_count }}</td>
              <td class="dim">
                {{ fmtTime(p.last_run_at) }}
                <span class="badge" :class="p.last_result === 'ok' ? 'badge-ok' : 'badge-danger'" v-if="p.last_result">
                  {{ p.last_result }}
                </span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy" @click="runPlan(p)"><Icon name="play" :size="13" /> 执行</button>
                <button class="btn-ghost btn-sm" @click="showArtifacts(p)"><Icon name="list" :size="13" /> 产物</button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage" @click="del(p)"><Icon name="trash" :size="13" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无备份计划" />

      <section class="card" v-if="curArtifacts">
        <div class="sec-head">
          <Icon name="disk" :size="16" /> 产物：{{ curArtifacts.plan.kind }}/{{ curArtifacts.plan.target }}
          <span class="spacer" />
          <select v-if="curArtifacts.items.length" v-model="selName" class="sel">
            <option value="" disabled>选择产物…</option>
            <option v-for="a in curArtifacts.items" :key="a.name" :value="a.name">{{ a.name }}</option>
          </select>
          <button
            class="btn-ghost btn-sm danger"
            :disabled="!canManage || busy || !curArtifacts.items.length"
            title="覆盖当前数据：任务内会先自动备份当前态，需手输确认词"
            @click="restoreFrom"
          >
            <Icon name="restart" :size="13" /> 从此产物恢复（高危）
          </button>
          <button class="btn-ghost btn-sm" @click="curArtifacts = null">关闭</button>
        </div>
        <table v-if="curArtifacts.items.length">
          <thead><tr><th>文件</th><th>大小</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="a in curArtifacts.items" :key="a.name">
              <td class="mono">{{ a.name }}</td>
              <td>{{ fmtSize(a.size) }}</td>
              <td class="dim">{{ fmtTime(a.mtime) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="dim">该计划暂无产物（点「执行」生成）</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ok-note { color: var(--c-ok, #3fb950); font-size: 13px; margin: 0 0 12px; }
</style>

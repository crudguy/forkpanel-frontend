<script setup lang="ts">
/**
 * 备份（本地 + 可选远端副本）。
 *
 * 能力边界：备份计划（panel = 面板自身数据；site = 站点文件）+ 可选远端副本
 * （WebDAV / S3 兼容）+ 立即执行 + 产物列表 + 从产物恢复（高危，需手输确认词）。
 *
 * 远端相关的两条前端纪律：
 * 1. **凭据永不回显**（后端只回 `remote_has_secret`），所以凭据框永远为空，
 *    空值语义 = "不改动"——与后端的三态约定严格对齐。想清空凭据请改为匿名访问
 *    （清空用户名），而不是把密码框留空（留空不会清掉任何东西）。
 * 2. 前端的必填校验只为**少跑一趟 400**。真正的注入 / SSRF / 配对校验在后端。
 *
 * 状态语义：`last_result` 的 `partial` 表示**本地成功、远端上传失败**——
 * 本地那份是真的，所以不判为失败；但异地副本没成，必须让人一眼看见。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, emptyRemote, type RemoteConfig } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RemoteTargetForm from '@/components/RemoteTargetForm.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Plan {
  id: number; kind: string; target: string; cron_expr: string | null
  keep_count: number; dest_dir: string; enabled: boolean
  last_run_at: number | null; last_result: string | null
  /** 产物是否静态加密（AES-256-GCM；主密钥不落库，丢了就解不开） */
  encrypt: boolean
  /** 远端副本类型；null = 仅本地 */
  remote_kind: string | null
  remote_url: string | null
  remote_bucket: string | null
  remote_prefix: string | null
  remote_region: string | null
  remote_user: string | null
  /** 是否已存凭据。**只有这个布尔**——凭据值永远不会下发 */
  remote_has_secret: boolean
}
interface Artifact { name: string; size: number; mtime: number }

const auth = useAuthStore()
const plans = ref<Plan[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const form = ref({
  kind: 'panel', target: 'panel', dest_dir: 'plans',
  cron_expr: '', keep_count: 7, encrypt: false,
  remote: emptyRemote(),
})

/** 正在编辑远端的计划（null = 面板关闭）。cfg 的 secret 恒为空初值：凭据不回显。 */
const editRemote = ref<{ plan: Plan; cfg: RemoteConfig } | null>(null)

// ── 计划字段编辑（审计 F15）：后端 PatchReq 早已支持 cron/保留份数/加密/启停，
// 此前前端只有「改远端」入口——计划要改只能删了重建，丢历史产物关联。
const editPlan = ref<{
  plan: Plan; cron: string; keep: number; encrypt: boolean; enabled: boolean; dest: string
} | null>(null)

function openEditPlan(p: Plan) {
  error.value = ''; notice.value = ''
  editPlan.value = {
    plan: p,
    cron: p.cron_expr ?? '', keep: p.keep_count,
    encrypt: p.encrypt, enabled: p.enabled, dest: p.dest_dir,
  }
}

async function saveEditPlan() {
  const e = editPlan.value; if (!e) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.patch(API.backups.patch(e.plan.id), {
      // cron：Some("") = 清空（仅手动执行）；表单已回填现值，只改想要的字段即可
      cron_expr: e.cron.trim(),
      keep_count: e.keep,
      encrypt: e.encrypt,
      enabled: e.enabled,
      dest_dir: e.dest.trim() || undefined, // 留空 = 不改目标目录
    })
    notice.value = `已更新计划 #${e.plan.id}`
    editPlan.value = null
    await load()
  } catch (err) { error.value = errorText(err) }
  finally { busy.value = false }
}

/**
 * 表单 → 请求体。
 *
 * 凭据为空时**整个字段省略**，与后端"缺省/空串 = 保留已存凭据"的三态语义对齐；
 * 不能发空串去表达"清空"，那会让用户每次改 URL 都顺手把凭据抹掉。
 * s3 → webdav 切换时显式把 bucket/prefix/region 置空，避免残留上一套配置。
 */
function remotePayload(c: RemoteConfig): Record<string, string> {
  if (!c.kind) return { remote_kind: 'none' }
  const p: Record<string, string> = {
    remote_kind: c.kind,
    remote_url: c.url.trim(),
    remote_user: c.user.trim(),
    remote_bucket: c.kind === 's3' ? c.bucket.trim() : '',
    remote_prefix: c.kind === 's3' ? c.prefix.trim() : '',
    remote_region: c.kind === 's3' ? c.region.trim() : '',
  }
  if (c.secret) p.remote_secret = c.secret
  return p
}

/** last_result → 徽章文案。未知值原样显示，不硬套三档（后端将来加值也看得见）。 */
function resultLabel(r: string | null) {
  if (r === 'ok') return 'ok'
  if (r === 'partial') return '本地 ok · 远端失败'
  if (r === 'fail') return '失败'
  return r ?? ''
}
function resultClass(r: string | null) {
  if (r === 'ok') return 'badge-ok'
  return r === 'partial' ? 'badge-warn' : 'badge-danger'
}

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
      encrypt: form.value.encrypt,
      remote: remotePayload(form.value.remote),
    })
    form.value = {
      kind: 'panel', target: 'panel', dest_dir: 'plans',
      cron_expr: '', keep_count: 7, encrypt: false, remote: emptyRemote(),
    }
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

/** 打开某个计划的远端配置（凭据框留空 = 不改动）。 */
function openRemote(p: Plan) {
  error.value = ''; notice.value = ''
  const k = p.remote_kind === 'webdav' || p.remote_kind === 's3' ? p.remote_kind : ''
  editRemote.value = {
    plan: p,
    cfg: {
      kind: k,
      url: p.remote_url ?? '',
      bucket: p.remote_bucket ?? '',
      prefix: p.remote_prefix ?? '',
      region: p.remote_region ?? '',
      user: p.remote_user ?? '',
      secret: '', // 永不回显
    },
  }
}

async function saveRemote() {
  if (!editRemote.value) return
  const id = editRemote.value.plan.id
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.patch(API.backups.patch(id), { remote: remotePayload(editRemote.value.cfg) })
    notice.value = `已更新计划 #${id} 的远端配置${
      editRemote.value.cfg.kind ? '；执行一次备份即可验证实际上传' : '（已关闭远端副本）'}`
    editRemote.value = null
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

/**
 * 连接自检。复用该计划已存的凭据（plan_id），因此"改了 URL 没重输密码"也能直接测。
 * 后端会真的 PUT 一个探针对象再删掉——比"能不能连上"更接近实际要用的能力。
 */
async function testRemote() {
  if (!editRemote.value) return
  const id = editRemote.value.plan.id
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const r = await api.post<{ ok: boolean; probe_url: string }>(API.backups.testRemote(), {
      plan_id: id,
      remote: remotePayload(editRemote.value.cfg),
    })
    notice.value = `远端可用：探针对象 ${r.probe_url} 已上传并删除`
  } catch (e) {
    error.value = `远端连接失败：${errorText(e)}`
  } finally { busy.value = false }
}

async function runPlan(p: Plan) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const r = await api.post<{ task_id: number }>(API.backups.run(p.id), {})
    notice.value = `已提交备份任务 #${r.task_id}（在任务中心可见）；稍后点「产物」查看`
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false; await load() }
}

/** 待删除计划（审计 U5：window.confirm → ConfirmDialog） */
const delPlan = ref<Plan | null>(null)
async function del(p: Plan) {
  busy.value = true; error.value = ''
  try { await api.del(API.backups.remove(p.id)); delPlan.value = null; await load() }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

/** 待确认恢复的产物（审计 U5：window.prompt → ConfirmDialog 确认词模式） */
const restoreConfirm = ref<{ plan: Plan; name: string } | null>(null)
function askRestore(plan: Plan, name: string) {
  error.value = ''; notice.value = ''
  // panel 库是面板自身运行中的库：在线覆盖会损坏 SQLite WAL —— 诚实拒绝，不给假按钮
  if (plan.kind === 'panel') {
    notice.value =
      '面板库不支持在线恢复：它是面板自身运行中的库，在线覆盖会损坏 SQLite WAL。请先停止 panel 服务后手动替换。'
    return
  }
  restoreConfirm.value = { plan, name }
}

async function restoreFrom() {
  const rc = restoreConfirm.value
  if (!rc) return
  const { plan, name } = rc

  busy.value = true
  try {
    const r = await api.post<{ task_id: string }>(API.backups.restore(plan.id), {
      artifact: name,
      confirm_token: '覆盖恢复',
    })
    notice.value = `恢复任务已提交（${r.task_id}）。可在「任务中心」查看进度；如需回滚，任务详情里的 output_path 指向恢复前的快照。`
    restoreConfirm.value = null
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

async function showArtifacts(p: Plan) {
  error.value = ''
  // 切换计划时必须清空上一次选中的产物名：否则在 A 计划选过产物后打开 B 计划，
  // 恢复目标是 A 的产物（selName 全局复用），会导致误恢复。
  selName.value = ''
  try {
    const items = await api.get<Artifact[]>(API.backups.artifacts(p.id))
    curArtifacts.value = { plan: p, items }
  } catch (e) { error.value = errorText(e) }
}

/** 选中的产物名（恢复目标）。产物按名称倒序，默认取最新一份。 */
const selName = ref('')

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
      <p v-if="error" class="err" role="alert">{{ error }}</p>
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
          <label class="chk" title="AES-256-GCM 加密产物。主密钥在 /etc/panel/master.key 且不落库——丢失后备份无法恢复，请先确认已单独备份主密钥">
            <input v-model="form.encrypt" type="checkbox" /> 静态加密
          </label>
          <label>cron（可空）
            <input v-model="form.cron_expr" placeholder="留空=仅手动" />
          </label>
          <button class="btn-primary" :disabled="!canManage || busy || (form.kind === 'site' && !form.target.trim())" @click="create">添加</button>
        </div>

        <RemoteTargetForm v-model="form.remote" :disabled="!canManage" />

        <p class="tip">
          产物落在面板备份根目录之下（相对路径，防越界）。可选<b>静态加密</b>（AES-256-GCM，主密钥不落库——丢了就解不开，请先单独备份主密钥）。
          可选<b>远端副本</b>（WebDAV / S3 兼容）：凭据加密存储且<b>永不回显</b>；远端上传失败<b>不会</b>让本地备份变成失败，但计划会标记 <code>partial</code> 并推一条通知——本地那份是真的，异地那份没成也必须看得见。
        </p>
      </section>

      <div class="card flush" v-if="plans.length">
        <table>
          <thead><tr><th>#</th><th>类型</th><th>目标</th><th>产物目录</th><th>保留</th><th>加密</th><th>远端</th><th>上次执行</th><th /></tr></thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td>{{ p.id }}</td>
              <td>{{ p.kind }}</td>
              <td class="mono">{{ p.target }}</td>
              <td class="dim mono">{{ p.dest_dir }}</td>
              <td>{{ p.keep_count }}</td>
              <td :class="p.encrypt ? '' : 'dim'">{{ p.encrypt ? '已加密' : '未加密' }}</td>
              <td class="dim">
                <template v-if="p.remote_kind">
                  {{ p.remote_kind }}
                  <span v-if="p.remote_has_secret" class="badge badge-ok" title="凭据已加密存储，永不回显">凭据</span>
                </template>
                <template v-else>—</template>
                <div v-if="p.remote_url" class="tiny mono">{{ p.remote_url }}</div>
              </td>
              <td class="dim">
                {{ fmtTime(p.last_run_at) }}
                <span class="badge" :class="resultClass(p.last_result)" v-if="p.last_result">
                  {{ resultLabel(p.last_result) }}
                </span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy" @click="runPlan(p)"><Icon name="play" :size="13" /> 执行</button>
                <button class="btn-ghost btn-sm" @click="showArtifacts(p)"><Icon name="list" :size="13" /> 产物</button>
                <button class="btn-ghost btn-sm" :disabled="!canManage" @click="openEditPlan(p)"><Icon name="edit" :size="13" /> 编辑</button>
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy" @click="openRemote(p)"><Icon name="globe" :size="13" /> 远端</button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage" @click="delPlan = p"><Icon name="trash" :size="13" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无备份计划" />

      <section class="card" v-if="editRemote">
        <div class="sec-head">
          <Icon name="globe" :size="16" />
          远端副本：计划 #{{ editRemote.plan.id }}（{{ editRemote.plan.kind }}/{{ editRemote.plan.target }}）
          <span class="spacer" />
          <button class="btn-ghost btn-sm" :disabled="busy || !editRemote.cfg.kind" @click="testRemote">
            <Icon name="bolt" :size="13" /> 测试连接
          </button>
          <button class="btn-primary btn-sm" :disabled="!canManage || busy" @click="saveRemote">保存</button>
          <button class="btn-ghost btn-sm" @click="editRemote = null">关闭</button>
        </div>

        <RemoteTargetForm v-model="editRemote.cfg" :disabled="!canManage"
          :has-secret="editRemote.plan.remote_has_secret" />

        <p class="tip">
          「测试连接」会真的**上传一个探针对象再删掉**——用备份实际要用的操作验证，
          比"能不能连上"更接近真相。「保存」只改进当前计划的远端配置（类型/目标不在此处改）。
          凭据框为空表示<b>沿用已保存的凭据</b>；要清空请把用户名也清空改为匿名访问。
        </p>
      </section>

      <section class="card" v-if="editPlan">
        <div class="sec-head">
          <Icon name="edit" :size="16" />
          编辑计划 #{{ editPlan.plan.id }}（{{ editPlan.plan.kind }}/{{ editPlan.plan.target }}）
          <span class="spacer" />
          <button class="btn-primary btn-sm" :disabled="!canManage || busy" @click="saveEditPlan">保存</button>
          <button class="btn-ghost btn-sm" @click="editPlan = null">关闭</button>
        </div>

        <div class="row">
          <label>cron（清空 = 仅手动）
            <input v-model="editPlan.cron" placeholder="0 3 * * *" />
          </label>
          <label>保留份数（1-365）
            <input v-model.number="editPlan.keep" type="number" min="1" max="365" />
          </label>
          <label class="chk" title="AES-256-GCM 加密产物。主密钥不落库，丢失后备份无法恢复">
            <input v-model="editPlan.encrypt" type="checkbox" /> 静态加密
          </label>
          <label class="chk">
            <input v-model="editPlan.enabled" type="checkbox" /> 启用
          </label>
          <label>输出目录（留空 = 不改）
            <input v-model="editPlan.dest" placeholder="plans" />
          </label>
        </div>

        <p class="tip">修改保存后立即生效；改 cron/启用无需删除重建，历史产物关联保持不变。</p>
      </section>

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
            @click="askRestore(curArtifacts.plan, selName || curArtifacts.items[0]?.name || '')"
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

    <!-- 删除计划（审计 U5：window.confirm → ConfirmDialog） -->
    <ConfirmDialog
      :open="!!delPlan" danger title="删除备份计划"
      :detail="delPlan ? `确认删除备份计划 #${delPlan.id}（${delPlan.kind}/${delPlan.target}）？注意：不会删除已生成的产物文件。` : ''"
      @confirm="delPlan && del(delPlan)" @cancel="delPlan = null"
    />

    <!-- 从产物恢复（审计 U5：window.prompt → ConfirmDialog 确认词模式） -->
    <ConfirmDialog
      :open="!!restoreConfirm" danger title="从产物恢复（高危）"
      :detail="restoreConfirm ? `即将用「${restoreConfirm.name}」覆盖 ${restoreConfirm.plan.target} 的当前数据。任务内会自动先备份当前态（safety 快照，可从任务详情取回），但此操作仍不可逆。` : ''"
      confirm-word="覆盖恢复" @confirm="restoreFrom" @cancel="restoreConfirm = null"
    />
  </div>
</template>

<style scoped>
.ok-note { color: var(--c-ok, #3fb950); font-size: 13px; margin: 0 0 12px; }
/* 远端地址可能很长：缩小 + 允许断行，避免把整张表撑出横向滚动 */
.tiny { font-size: 11.5px; margin-top: 2px; word-break: break-all; }
.tip code { font-size: 11.5px; }
/* 勾选项：与其它 label（纵向排布）不同，需要横排才不会把文字挤到下一行 */
.chk { flex-direction: row; align-items: center; gap: 5px; cursor: help; }
.chk input { width: auto; }
</style>

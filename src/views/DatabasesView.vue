<script setup lang="ts">
/**
 * 数据库管理。
 *
 * 能力边界：连接管理 + 备份任务 + **只读浏览**（库→表→行预览，分页）
 * + **只读 SQL 控制台**（仅 SQLite）。
 *
 * 关于 SQL 控制台：此前刻意不提供 Web SQL 终端（怕它变成任意写库的入口）。
 * 现在提供的是**只读**版本，且只对 SQLite 开放——它的连接以只读模式打开，
 * 写语句物理上就会失败；mysql/pg 没有这个保证，后端诚实 501，
 * 前端如实展示原因，而不是假装没有这个功能。
 *
 * 引擎差异：SQLite 为面板内建引擎（已实装浏览与查询）；MySQL/PostgreSQL 需外部客户端，
 * 缺少外部客户端的连接由后端标记 `client_ready=false`，此处置灰。
 * 注意它**不代表连接可达**——只表示本机有没有 psql/mysqldump 这类工具。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useModal } from '@/composables/useModal'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import SqlConsole from '@/components/SqlConsole.vue'
import { toast } from '@/composables/useToast'

interface Conn {
  id: number; name: string; engine: string; host: string | null
  port: number | null; default_db: string | null; client_ready: boolean; has_password: boolean
}
interface DbTableInfo { name: string; rows: number; engine: string | null }
interface RowsData { columns: string[]; rows: (string | null)[][]; page: number; total: number }

const PAGE_SIZE = 50

const auth = useAuthStore()
const conns = ref<Conn[]>([])
const error = ref('')
const busy = ref(false)
/** 打开 SQL 控制台的连接（null = 关闭） */
const sqlConn = ref<Conn | null>(null)
/** 空表单。port/user/password 仅 mysql/postgres 需要（口令后端 AES 加密、永不回显）。 */
function emptyForm() {
  return { name: '', engine: 'sqlite', host: '127.0.0.1', port: '', user: '', password: '', default_db: '' }
}
const form = ref(emptyForm())

/** 成功类提示走独立通道（此前备份成功却写 error，被渲染成红色错误条）。 */

async function load() {
  error.value = ''
  try { conns.value = await api.get<Conn[]>(API.db.connections()) }
  catch (e) { error.value = errorText(e); conns.value = [] }
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.DBMS_MANAGE, 'db.manage'))

async function create() {
  busy.value = true; error.value = ''
  try {
    const ext = form.value.engine !== 'sqlite'
    await api.post(API.db.connections(), {
      name: form.value.name, engine: form.value.engine,
      host: form.value.host || undefined, default_db: form.value.default_db || undefined,
      // 此前漏发 port/user/password：mysql/postgres 连接建出来必然不可用，且无编辑入口无法补救
      port: ext && form.value.port ? Number(form.value.port) : undefined,
      user: ext && form.value.user ? form.value.user : undefined,
      password: ext && form.value.password ? form.value.password : undefined,
    })
    form.value = emptyForm()
    toast('连接已创建')
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

async function backup(c: Conn) {
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ task_id: number }>(API.db.backup(c.id), {
      id: c.id, out: `backup-${c.name}-${Date.now()}.sql`,
    })
    toast(`已提交备份任务 #${r.task_id}（请在任务面板查看）`)
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// ── 恢复（高危，覆盖当前库）──
const restoreTarget = ref<Conn | null>(null)
const restoreForm = ref({ file: '', confirm: '' })

function openRestore(c: Conn) {
  error.value = ''
  restoreForm.value = { file: '', confirm: '' }
  restoreTarget.value = c
}

// 恢复弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const restoreBox = ref<HTMLElement | null>(null)
// 统一关闭出口：X / 点遮罩 / 取消按钮 / Esc 都走它（离场动画 + 焦点返还）
const { close: closeRestore } = useModal(() => !!restoreTarget.value, restoreBox, () => { restoreTarget.value = null })

async function doRestore() {
  const c = restoreTarget.value; if (!c) return
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ task_id?: number }>(API.db.restore(c.id), {
      file: restoreForm.value.file.trim(),
      confirm_token: restoreForm.value.confirm,
    })
    toast(r.task_id ? `已提交恢复任务 #${r.task_id}（请在任务面板查看）` : '恢复完成')
    restoreTarget.value = null
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// ── 只读浏览：连接 → 库 → 表 → 行预览 ──
const browse = ref<{
  conn: Conn; dbs: string[]; db: string; tables: DbTableInfo[]; table: string; data: RowsData | null
} | null>(null)

async function openBrowse(c: Conn) {
  error.value = ''
  browse.value = { conn: c, dbs: [], db: '', tables: [], table: '', data: null }
  try { browse.value.dbs = await api.get<string[]>(API.db.databases(c.id)) }
  catch (e) { error.value = errorText(e) }
}

async function pickDb(db: string) {
  const b = browse.value; if (!b) return
  b.db = db; b.table = ''; b.data = null; b.tables = []
  try { b.tables = await api.get<DbTableInfo[]>(API.db.tables(b.conn.id, db)) }
  catch (e) { error.value = errorText(e) }
}

async function pickTable(table: string, page = 1) {
  const b = browse.value; if (!b || !table) { if (b) b.data = null; return }
  b.table = table
  const url = `${API.db.rows(b.conn.id, b.db, table)}?page=${page}&page_size=${PAGE_SIZE}`
  try { b.data = await api.get<RowsData>(url) }
  catch (e) { error.value = errorText(e); b.data = null }
}

function closeBrowse() { browse.value = null }
</script>

<template>
  <div>
    <div class="page-head">
      <h2 class="page-title"><Icon name="database" :size="18" /> 数据库</h2>
      <span class="spacer" />
      <button class="btn-ghost" :disabled="busy" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.DBMS_MANAGE)"
      title="未检测到可用的数据库引擎"
      hint="SQLite 为内建引擎；MySQL/PostgreSQL 需外部客户端"
      :reason="auth.capabilities[CAP.DBMS_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section class="card">
        <div class="sec-head"><Icon name="database" :size="16" /> 新增连接</div>
        <div class="row">
          <label>名称<input v-model="form.name" placeholder="myapp" /></label>
          <label>引擎
            <select v-model="form.engine">
              <option value="sqlite">SQLite</option>
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </label>
          <label>主机<input v-model="form.host" :disabled="form.engine === 'sqlite'" /></label>
          <template v-if="form.engine !== 'sqlite'">
            <label>端口<input v-model="form.port" inputmode="numeric" :placeholder="form.engine === 'mysql' ? '3306' : '5432'" /></label>
            <label>用户名<span style="color:#e5484d;margin-left:2px" title="MySQL/PostgreSQL 连接必须指定账号">*</span><input v-model="form.user" autocomplete="off" :placeholder="form.engine === 'mysql' ? 'root' : 'postgres'" /></label>
            <label>口令<input v-model="form.password" type="password" autocomplete="new-password" /></label>
          </template>
          <label>{{ form.engine === 'sqlite' ? '数据库文件' : '库名' }}
            <input v-model="form.default_db" :placeholder="form.engine === 'sqlite' ? '/path/to/app.db' : 'myapp'" />
          </label>
          <button class="btn-primary" :disabled="!canManage || busy || !form.name || (form.engine !== 'sqlite' && !form.user.trim())" @click="create">添加</button>
        </div>
        <p class="tip">SQLite 为内建引擎，可<b>只读浏览与查询</b>（SQL 控制台仅接受只读语句）；MySQL / PostgreSQL 需本机装有对应客户端，仅提供<b>备份与恢复</b>。出于安全与资源隔离，不提供写库入口。</p>
      </section>

      <div class="card flush" v-if="conns.length">
        <table>
          <thead><tr><th>名称</th><th>引擎</th><th>主机</th><th>库 / 文件</th><th>客户端</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in conns" :key="c.id">
              <td>{{ c.name }}</td>
              <td>{{ c.engine }}</td>
              <td class="mono">{{ c.host ?? '—' }}{{ c.port ? ':' + c.port : '' }}</td>
              <td class="dim mono">{{ c.default_db ?? '—' }}</td>
              <td>
                <!-- 该字段只代表「外部客户端有无安装」，不代表连接可达。
                     旧文案「可用」会让用户在绿色徽标下点备份然后失败，且无从归因。 -->
                <span class="badge" :class="c.client_ready ? 'badge-ok' : 'badge-warn'"
                      :title="c.client_ready
                        ? '已安装所需客户端工具；不代表此连接可以连通（口令/网络/权限要在操作时才验证）'
                        : '未安装该引擎所需的客户端工具，相关操作已置灰'">
                  {{ c.client_ready ? '客户端就绪' : '缺客户端' }}
                </span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!c.client_ready || busy" @click="openBrowse(c)"><Icon name="search" :size="13" /> 浏览</button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="busy"
                  :title="c.engine === 'sqlite' ? '执行只读查询' : '仅 SQLite 支持只读查询（其它引擎的连接不是只读的）'"
                  @click="sqlConn = c"
                ><Icon name="terminal" :size="13" /> SQL</button>
                <button class="btn-ghost btn-sm" :disabled="!c.client_ready || !canManage || busy" @click="backup(c)">备份</button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="!c.client_ready || !canManage || busy"
                  :title="c.engine === 'sqlite' ? '从备份文件恢复（覆盖当前库）' : 'mysql/postgres 恢复需外部客户端，本环境不可用'"
                  @click="openRestore(c)"
                >恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无连接" />

      <!-- 只读浏览面板 -->
      <section class="card" v-if="browse">
        <div class="sec-head">
          <Icon name="database" :size="16" /> 浏览：{{ browse.conn.name }}
          <span class="spacer" />
          <button class="btn-ghost btn-sm" @click="closeBrowse">关闭</button>
        </div>

        <div class="crumbs" v-if="browse.dbs.length">
          <span class="crumb">库</span>
          <template v-for="d in browse.dbs" :key="d">
            <span class="sep">/</span>
            <span class="crumb" :class="{ active: browse.db === d }" @click="pickDb(d)">{{ d }}</span>
          </template>
        </div>

        <div class="row" v-if="browse.db">
          <label>表
            <select :value="browse.table" @change="pickTable(($event.target as HTMLSelectElement).value)">
              <option value="">选择表…</option>
              <option v-for="t in browse.tables" :key="t.name" :value="t.name">{{ t.name }}（{{ t.rows }} 行）</option>
            </select>
          </label>
        </div>

        <div class="card flush" v-if="browse.data">
          <table>
            <thead><tr><th v-for="col in browse.data.columns" :key="col">{{ col }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in browse.data.rows" :key="i">
                <td v-for="(v, j) in r" :key="j" class="mono">{{ v ?? 'NULL' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="pager">
            <button class="btn-ghost btn-sm" :disabled="browse.data.page <= 1" @click="pickTable(browse.table, browse.data.page - 1)">上一页</button>
            <span class="dim">第 {{ browse.data.page }} 页 · 共 {{ browse.data.total }} 行</span>
            <button class="btn-ghost btn-sm"
              :disabled="browse.data.page * PAGE_SIZE >= browse.data.total"
              @click="pickTable(browse.table, browse.data.page + 1)">下一页</button>
          </div>
        </div>
        <p v-else-if="browse.db && browse.tables.length === 0" class="dim">该库无表</p>
        <p v-else-if="browse.db" class="dim">请选择要预览的表</p>
      </section>
    </template>

    <SqlConsole v-if="sqlConn" :conn="sqlConn" @close="sqlConn = null" />

    <!-- 恢复弹窗（高危）：确认词与备份恢复同源（「覆盖恢复」） -->
    <div v-if="restoreTarget" class="mask" @click.self="closeRestore">
      <div ref="restoreBox" class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">恢复「{{ restoreTarget.name }}」</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeRestore">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <!-- 覆盖库的后果预警：公共 .hint-note.is-warn（此前 .restore-warn 硬编码 #FF5A36） -->
        <p class="hint-note is-warn">
          <Icon name="alert" :size="14" class="ic" />
          <span>将用指定备份文件<b>覆盖当前库</b>，恢复过程中库不可用。仅支持
            SQLite 立即恢复；文件必须位于文件管理允许根内。</span>
        </p>
        <label class="blk">备份文件路径
          <input v-model="restoreForm.file" placeholder="/backups/myapp-2026.sql" />
        </label>
        <label class="blk">输入「覆盖恢复」以确认
          <input v-model="restoreForm.confirm" autocomplete="off" placeholder="覆盖恢复" />
        </label>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" :disabled="busy" @click="closeRestore">取消</button>
            <!-- 危险主操作 → 实心 .btn-danger（此前 btn-primary + 硬编码 background:#C73E1F） -->
            <button
              class="btn-danger"
              :disabled="busy || !restoreForm.file.trim() || restoreForm.confirm.trim() !== '覆盖恢复'"
              @click="doRestore"
            >{{ busy ? '恢复中…' : '开始恢复' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0 12px; }
.crumb { padding: 2px 8px; border-radius: 6px; cursor: pointer; color: var(--c-text-dim); }
.crumb:hover { color: var(--c-text); }
.crumb.active { background: rgba(255, 90, 54, .16); color: #FF5A36; }
.sep { color: var(--c-text-dim); }
.pager { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 字段 / 操作条 / 后果预警一律取 main.css 的公共式样。
   此前这里私有复刻了 .restore-warn（硬编码 #FF5A36）、.modal-actions、.danger-btn（#C73E1F）。 */
</style>

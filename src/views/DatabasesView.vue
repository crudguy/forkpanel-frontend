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
import { useAsync } from '@/composables/useAsync'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import SqlConsole from '@/components/SqlConsole.vue'
import { toast } from '@/composables/useToast'
import InlineRemark from '@/components/InlineRemark.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  dbCrumbs, dbHint, dbLevel, defaultSchema, hasSchemaLayer, tableOptionLabel,
  type DbLevelInput, type DbSchemaNode,
} from '@/composables/dbBrowsePath'

interface Conn {
  id: number; name: string; engine: string; host: string | null
  port: number | null; default_db: string | null; client_ready: boolean; has_password: boolean
  /** 对象说明（备注，022）：≤500 字，随连接列表返回，空串 = 无 */
  remark: string
}
/**
 * 表对象。`kind` 区分表与视图（后端 `DbTable.kind` 下发）——
 * 视图也是可预览对象，所以「有 1 个视图、0 张表」不该被判成空库；
 * 而 `rows` 取不到时后端**如实**给 -1，绝非"负数行"，渲染前必须转换
 * （见 composables/dbBrowsePath.ts 的 `tableOptionLabel`）。
 */
interface DbTableInfo { name: string; rows: number; engine: string | null; kind?: 'table' | 'view' }
interface RowsData { columns: string[]; rows: (string | null)[][]; page: number; total: number }

const PAGE_SIZE = 50

const auth = useAuthStore()
const conns = ref<Conn[]>([])
const { error, loading, run } = useAsync()
const busy = ref(false)
/** 帮助抽屉（A6）：页面头部「?」打开，承载引擎差异与能力边界的完整说明 */
const helpOpen = ref(false)
/** 打开 SQL 控制台的连接（null = 关闭） */
const sqlConn = ref<Conn | null>(null)
/** 空表单。port/user/password 仅 mysql/postgres 需要（口令后端 AES 加密、永不回显）。 */
function emptyForm() {
  return { name: '', engine: 'sqlite', host: '127.0.0.1', port: '', user: '', password: '', default_db: '' }
}
const form = ref(emptyForm())

/** 成功类提示走独立通道（此前备份成功却写 error，被渲染成红色错误条）。 */

async function load() {
  await run(
    async () => { conns.value = await api.get<Conn[]>(API.db.connections()) },
    (e) => { conns.value = []; error.value = errorText(e) },
  )
}
onMounted(load)

const canManage = computed(() => auth.enabled(CAP.DBMS_MANAGE, 'db.manage'))

async function create() {
  busy.value = true; error.value = ''
  const ext = form.value.engine !== 'sqlite'
  // P2：外部引擎端口范围校验（仅当填写了端口时；留空走后端默认端口）
  if (ext && form.value.port !== '' && form.value.port != null) {
    const p = Number(form.value.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      error.value = '端口需为 1-65535 之间的整数'
      busy.value = false
      return
    }
  }
  try {
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

// ── 编辑 / 删除连接（PATCH/DELETE /db/connections/{id}）──
// username/password 列表不回显（后端只回 has_password）→ 编辑态留空 = 不修改
const editTarget = ref<Conn | null>(null)
const editForm = ref(emptyForm())
const editSaving = ref(false)
const editError = ref('')
const delTarget = ref<Conn | null>(null)

function openEdit(c: Conn) {
  editTarget.value = c
  editError.value = ''
  editForm.value = {
    name: c.name, engine: c.engine, host: c.host ?? '127.0.0.1',
    port: c.port != null ? String(c.port) : '', user: '', password: '',
    default_db: c.default_db ?? '',
  }
}

async function saveEdit() {
  const c = editTarget.value; if (!c) return
  const ext = editForm.value.engine !== 'sqlite'
  if (ext && editForm.value.port !== '' && editForm.value.port != null) {
    const p = Number(editForm.value.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) { editError.value = '端口需为 1-65535 之间的整数'; return }
  }
  editSaving.value = true; editError.value = ''
  try {
    await api.patch(API.db.conn(c.id), {
      name: editForm.value.name, engine: editForm.value.engine,
      host: editForm.value.host || undefined, default_db: editForm.value.default_db || undefined,
      port: ext && editForm.value.port ? Number(editForm.value.port) : undefined,
      // user/password 留空 = 不修改（后端缺省保留现值）
      user: ext && editForm.value.user ? editForm.value.user : undefined,
      password: ext && editForm.value.password ? editForm.value.password : undefined,
    })
    editTarget.value = null
    toast('连接已更新')
    load()
  } catch (e) { editError.value = errorText(e) }
  finally { editSaving.value = false }
}

async function doDel() {
  const c = delTarget.value; delTarget.value = null
  if (!c) return
  try {
    await api.del(API.db.conn(c.id))
    toast(`已删除连接 ${c.name}`)
    load()
  } catch (e) { error.value = errorText(e) }
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

/** 对象说明（备注，022）：内联保存。conn 传 id（后端 id / name 双解析）；
 *  失败由 InlineRemark 就地展示，不弹窗、不翻页。 */
async function saveRemark(c: Conn, v: string) {
  await api.patch(API.db.remark(c.id), { remark: v })
  c.remark = v
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

// ── 只读浏览：连接 → 库 →（schema）→ 表 → 行预览 ──
//
// 「库」的下一级在三个引擎里不是同一种东西（MySQL 库下直接是表；PG 库下是 schema；
// SQLite 的「库」其实是文件里的 catalog），所以 `schemas` 是**后端如实回答的结果**，
// 空数组 = 该引擎没有这一层，而不是「这一层是空的」。层级判定与文案见
// composables/dbBrowsePath.ts（那边有测试钉住"每层说每层的话"）。
//
// `tablesLoading` 单独存在的原因：`tables` 为空既可能是「真没有」也可能是「还没查回来」
// 这两种情况该说的话完全不同，共用一个判据就会出现"刚点进去闪一下空库再变成有表"。
const browse = ref<{
  conn: Conn
  dbs: string[]
  db: string
  schemas: DbSchemaNode[]
  schema: string
  tables: DbTableInfo[]
  tablesLoading: boolean
  table: string
  data: RowsData | null
} | null>(null)

// 层级判定输入集中一处：模板里不再写 `browse.db && browse.tables.length === 0` 这类
// 复合表达式——那正是「点哪一层都说无表」的来源。
const browseInput = computed<DbLevelInput>(() => {
  const b = browse.value
  if (!b) return { db: '', schemas: [], schema: '', tables: [], tablesLoading: false }
  return {
    db: b.db, schemas: b.schemas, schema: b.schema,
    tables: b.tables, tablesLoading: b.tablesLoading,
  }
})
const bLevel = computed(() => dbLevel(browseInput.value))
const bHint = computed(() =>
  browse.value ? dbHint(bLevel.value, browseInput.value, browse.value.conn.engine) : null)
const bCrumbs = computed(() => dbCrumbs(browseInput.value))

async function openBrowse(c: Conn) {
  error.value = ''
  browse.value = {
    conn: c, dbs: [], db: '', schemas: [], schema: '',
    tables: [], tablesLoading: false, table: '', data: null,
  }
  try { browse.value.dbs = await api.get<string[]>(API.db.databases(c.id)) }
  catch (e) { error.value = errorText(e) }
}

/** 选库：清空所有下游状态，再按该库**重新**查下一级与表清单 */
async function pickDb(db: string) {
  const b = browse.value; if (!b) return
  b.db = db
  b.schemas = []; b.schema = ''
  b.tables = []; b.table = ''; b.data = null
  b.tablesLoading = true
  try {
    b.schemas = await api.get<DbSchemaNode[]>(API.db.schemas(b.conn.id, db))
    // 有 schema 层时**自动选中可预览的第一个**（PG 恒为 public）。原因见 defaultSchema 注释：
    // tables() 本来就只读 public，界面停在"未选"与事实不符。
    b.schema = defaultSchema(b.schemas)
  } catch (e) { error.value = errorText(e) }
  await loadTables()
}

/** 选 schema（仅 PG 有这一层）：换 schema 必须重查表，否则表清单还是上一个 schema 的 */
async function pickSchema(schema: string) {
  const b = browse.value; if (!b) return
  b.schema = schema
  b.table = ''; b.data = null
  await loadTables()
}

async function loadTables() {
  const b = browse.value; if (!b || !b.db) return
  b.tablesLoading = true
  try { b.tables = await api.get<DbTableInfo[]>(API.db.tables(b.conn.id, b.db)) }
  catch (e) { error.value = errorText(e); b.tables = [] }
  finally { b.tablesLoading = false }
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
    <EmptyState v-if="!auth.supported(CAP.DBMS_MANAGE)"
      title="未检测到可用的数据库引擎"
      hint="SQLite 为内建引擎；MySQL/PostgreSQL 需外部客户端"
      :reason="auth.capabilities[CAP.DBMS_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>

      <section class="card">
        <!-- 说明按钮挂在常驻的新增卡上：列表卡在零连接时不渲染，挂上去会随空列表消失 -->
        <div class="sec-head">
          <Icon name="database" :size="16" /> 新增连接
          <span class="spacer" />
          <HelpBtn title="数据库说明" aria-label="数据库说明" :expanded="helpOpen" @click="helpOpen = true" />
        </div>
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
            <label>用户名<span style="color:var(--c-danger);margin-left:2px" title="MySQL/PostgreSQL 连接必须指定账号">*</span><input v-model="form.user" autocomplete="off" :placeholder="form.engine === 'mysql' ? 'root' : 'postgres'" /></label>
            <label>口令<input v-model="form.password" type="password" autocomplete="new-password" /></label>
          </template>
          <label>{{ form.engine === 'sqlite' ? '数据库文件' : '库名' }}
            <input v-model="form.default_db" :placeholder="form.engine === 'sqlite' ? '/path/to/app.db' : 'myapp'" />
          </label>
          <button class="btn-primary" :disabled="!canManage || busy || !form.name || (form.engine !== 'sqlite' && !form.user.trim())" @click="create">添加</button>
        </div>
      </section>

      <!-- 完整说明收进帮助抽屉（A6）：能力边界不再铺在页面上；「?」在「新增连接」卡头 -->
      <HelpDrawer :open="helpOpen" title="数据库说明" @close="helpOpen = false">
        <p>SQLite 为内建引擎，可<b>只读浏览与查询</b>（SQL 控制台仅接受只读语句）；MySQL / PostgreSQL 需本机装有对应客户端，仅提供<b>备份与恢复</b>。出于安全与资源隔离，不提供写库入口。</p>
        <h4>客户端就绪 ≠ 连接可达</h4>
        <p>「客户端」列只表示本机有没有 psql / mysqldump 这类工具，<b>不代表目标库连得上</b>；连接可用性以实际执行结果为准。</p>
      </HelpDrawer>

    <!-- 首屏必须先给骨架：此前本页 `useAsync()` 只解构了 `{ error, run }`，
         请求还在飞就渲染了「暂无…」空态（带 CTA），数据到达后整块跳变；
         且加载失败时列表区与空列表长得一样，用户分不清是"没有"还是"没加载出来"。 -->
      <div v-if="loading && !conns.length" class="skeleton box" />
      <div v-else-if="conns.length" class="card flush toolbar-card">
        <div class="card-toolbar">
          <span class="count">共 {{ conns.length }} 个连接</span>
          <span class="spacer" />
          <RefreshBtn :disabled="busy" sm @click="load" />
        </div>
        <!-- 横滚只发生在表格上：卡片已改 overflow:hidden，否则窄屏横滚会把工具条一起带走 -->
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽同站点表范式：库/文件为唯一弹性列（width:auto）吸收余量；
               操作列 270px 容下浏览/SQL/备份/恢复 4 个带文字按钮；
               备注列（022）固定 170px，ellipsis + title 兜长文。客户端列次要，窄屏隐藏。 -->
          <colgroup>
            <col class="w-dbname" /><col class="w-dbremark" /><col class="w-dbeng" /><col class="w-dbhost" /><col class="w-dbdb" /><col class="w-dbcli" /><col class="w-dbacts" />
          </colgroup>
          <thead><tr><th scope="col">名称</th><th scope="col" class="col-opt">备注</th><th scope="col">引擎</th><th scope="col">主机</th><th scope="col">库 / 文件</th><th scope="col" class="col-opt">客户端</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in conns" :key="c.id">
              <td class="ellipsis" :title="c.name">{{ c.name }}</td>
              <td class="remark-cell col-opt">
                <InlineRemark :model-value="c.remark" :editable="canManage"
                  :saver="(v) => saveRemark(c, v)" />
              </td>
              <td>{{ c.engine }}</td>
              <td class="mono">{{ c.host ?? '—' }}{{ c.port ? ':' + c.port : '' }}</td>
              <td class="dim mono ellipsis" :title="c.default_db ?? ''">{{ c.default_db ?? '—' }}</td>
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
              <td class="nowrap acts">
                <button class="btn-ghost btn-sm" :disabled="!c.client_ready || busy"
          :title="c.client_ready ? '' : '该引擎缺少客户端工具，无法浏览'" @click="openBrowse(c)"><Icon name="search" :size="13" /> 浏览</button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="busy"
                  :title="c.engine === 'sqlite' ? '执行只读查询' : '仅 SQLite 支持只读查询（其它引擎的连接不是只读的）'"
                  @click="sqlConn = c"
                ><Icon name="terminal" :size="13" /> SQL</button>
                <button class="btn-ghost btn-sm" :disabled="!c.client_ready || !canManage || busy"
          :title="!canManage ? '无 db.manage 权限' : (c.client_ready ? '' : '该引擎缺少客户端工具，无法备份')" @click="backup(c)">备份</button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="!c.client_ready || !canManage || busy"
                  :title="c.engine === 'sqlite' ? '从备份文件恢复（覆盖当前库）' : 'mysql/postgres 恢复需外部客户端，本环境不可用'"
                  @click="openRestore(c)"
                >恢复</button>
                <button v-if="canManage" class="btn-ghost btn-sm" :disabled="busy" @click="openEdit(c)"><Icon name="edit" :size="13" /> 编辑</button>
                <button v-if="canManage" class="btn-ghost btn-sm danger" :disabled="busy" @click="delTarget = c"><Icon name="trash" :size="13" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <EmptyState v-else title="暂无连接" />

      <!-- 只读浏览面板 -->
      <section class="card" v-if="browse">
        <div class="sec-head">
          <Icon name="database" :size="16" /> 浏览：{{ browse.conn.name }}
          <span class="badge">{{ browse.conn.engine }}</span>
          <span class="spacer" />
          <button class="btn-ghost btn-sm" @click="closeBrowse">关闭</button>
        </div>

        <!-- 面包屑：只出真实存在的层（没有 schema 层就不补一段空路径）。
             每段可点回退到该层，末段是当前位置。 -->
        <nav v-if="bCrumbs.length" class="crumbs" aria-label="浏览路径">
          <template v-for="(c, i) in bCrumbs" :key="c.text">
            <span v-if="i" class="sep">/</span>
            <button
              v-if="!c.current && i === 0"
              type="button" class="crumb is-link" @click="pickDb(c.text)"
            >{{ c.text }}</button>
            <span v-else-if="!c.current" class="crumb is-link" @click="pickSchema(c.text)">{{ c.text }}</span>
            <span v-else class="crumb active" aria-current="page">{{ c.text }}</span>
          </template>
        </nav>

        <!-- 三层路径合并成**一行**（窄屏自动换行）。
             ⚠ 曾经把三层各写成一个 .path-row 直接挂在 .card 下：每个 .path-row 自己
             确实是 flex 横排，但它们彼此是三个**块级兄弟**，于是仍然各占一行、
             竖向堆成 44px × 3。横排必须在同一个容器里才成立。 -->
        <div class="path-bar">
          <!-- ① 库这一层：所有库平铺成下拉。
               用专属 .path-row 而不是公共 .row——公共 `.row > label` 是**表单**口径
               （label 在上、控件占满一行），三层路径堆起来会占三行；
               这里是导航，标签与控件同行更紧凑。 -->
          <div class="path-row" v-if="browse.dbs.length">
            <label>库
              <select
                :value="browse.db"
                @change="pickDb(($event.target as HTMLSelectElement).value)"
              >
                <option value="">选择库…</option>
                <option v-for="d in browse.dbs" :key="d" :value="d">{{ d }}</option>
              </select>
            </label>
          </div>

          <!-- ② schema 这一层：只有后端真的返回了下一级才渲染。
               不可预览的 schema 明确标注原因，而不是让人点进去看一句"无表"。 -->
          <div class="path-row" v-if="browse.db && hasSchemaLayer(browse.schemas)">
            <label>schema
              <select
                :value="browse.schema"
                @change="pickSchema(($event.target as HTMLSelectElement).value)"
              >
                <!-- 不要放「public（默认）」的空选项：清单里本来就有真实的 public，
                     两个都叫 public 会让人以为选哪个不一样（而且留空与选 public
                     在实现上是同一条路径）。空值 = 还没选，由提示语说明"本版只读 public"。 -->
                <option value="">选择 schema…</option>
                <option v-for="s in browse.schemas" :key="s.name" :value="s.name">
                  {{ s.name }}{{ s.previewable === false ? '（本版不可预览）' : '' }}
                </option>
              </select>
            </label>
          </div>

          <!-- ③ 表 / 视图这一层 -->
          <div class="path-row" v-if="browse.db && (bLevel === 'tables' || bLevel === 'objects')">
            <label>表
              <select
                :value="browse.table"
                :disabled="!browse.tables.length"
                @change="pickTable(($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ browse.tables.length ? '选择表…' : '（无可选对象）' }}</option>
                <option v-for="t in browse.tables" :key="t.name" :value="t.name">
                  {{ tableOptionLabel(t) }}
                </option>
              </select>
            </label>
          </div>
        </div>

        <!-- 层级提示：文案由 dbHint 按「当前层 + 实际事实」生成，不再是
             一个 tables.length === 0 就把所有情况都说成「该库无表」。
             外观直接复用公共 .hint-note（含已验证的 flex item 修法与 is-warn 配色），
             不在本视图另造一套——两套必然会漂移。`data-hint` 是稳定标识，供测试定位。 -->
        <p v-if="bHint" class="hint-note" :class="{ 'is-warn': bHint.tone === 'warn' }" :data-hint="bHint.key">
          <Icon :name="bHint.tone === 'warn' ? 'alert' : 'info'" :size="14" class="ic" />
          <span>{{ bHint.text }}</span>
        </p>

        <div class="card flush" v-if="browse.data">
          <table v-table-nav>
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
        <!-- 选了表但没取到行：单独说，不占用"这一层没有对象"那句话 -->
        <p v-else-if="browse.table" class="dim">正在读取「{{ browse.table }}」的数据…</p>
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

    <!-- 编辑连接弹窗：username/password 不回显 → 留空=不修改 -->
    <div v-if="editTarget" class="mask" @click.self="editTarget = null">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">编辑连接「{{ editTarget.name }}」</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="editTarget = null">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <p v-if="editError" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ editError }}</span>
        </p>
        <div class="row">
          <label>名称<input v-model="editForm.name" :disabled="editSaving" /></label>
          <label>引擎
            <select v-model="editForm.engine" :disabled="editSaving">
              <option value="sqlite">SQLite</option>
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </label>
          <label>主机<input v-model="editForm.host" :disabled="editForm.engine === 'sqlite' || editSaving" /></label>
          <template v-if="editForm.engine !== 'sqlite'">
            <label>端口<input v-model="editForm.port" inputmode="numeric" :disabled="editSaving" /></label>
            <label>用户名<input v-model="editForm.user" autocomplete="off" placeholder="留空=不修改" :disabled="editSaving" /></label>
            <label>口令<input v-model="editForm.password" type="password" autocomplete="new-password"
              :placeholder="editTarget.has_password ? '已设口令，留空=不修改' : '未设口令'" :disabled="editSaving" /></label>
          </template>
          <label>{{ editForm.engine === 'sqlite' ? '数据库文件' : '库名' }}
            <input v-model="editForm.default_db" :disabled="editSaving" />
          </label>
        </div>
        <p class="dim tiny">用户名 / 口令留空表示不修改（为安全起见不回显当前值）。</p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="editTarget = null" :disabled="editSaving">取消</button>
            <button class="btn-primary" :disabled="editSaving || !editForm.name.trim()" @click="saveEdit">
              {{ editSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除连接确认（仅删面板登记，不动真实库/文件） -->
    <ConfirmDialog v-if="delTarget" :open="!!delTarget" danger title="删除数据库连接"
      :detail="`将删除连接「${delTarget.name}」的面板登记。不会删除真实的数据库或文件，已创建的备份不受影响。`"
      @confirm="doDel" @cancel="delTarget = null" />
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0 12px; }
/* 面包屑段：第一段是 <button>（回退到库层），第二段是 <span>（回退到 schema 层），
   末段是 <span>（当前位置）。三者必须**看起来一致**，否则「同一排里有的能点有的不能点」
   会让人误判。统一 padding / 字号 / 行高，并把 button 的原生外观清掉。 */
.crumb {
  padding: 2px 8px; border-radius: 6px; font-size: inherit; font-family: inherit;
  line-height: 1.5; background: none; border: 0; color: var(--c-text-dim);
}
.crumb.is-link { cursor: pointer; }
.crumb.is-link:hover { color: var(--c-text); background: var(--c-hover); }
.crumb.active { background: var(--c-primary-soft); color: var(--c-primary); }
.sep { color: var(--c-text-dim); }
/* 浏览路径的三层选择：整个 path-bar 是一行弹性容器（窄屏换行）。
   每一段里标签与控件**同行**（导航语义，不是表单）。
   公共 `.row > label` 是竖排表单口径，三层叠起来白占三行高度。 */
.path-bar { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.path-row { display: flex; align-items: center; }
.path-row > label {
  display: flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: var(--fs-12); color: var(--c-text-dim);
}
.path-row > label select { min-width: 150px; max-width: 300px; }
/* 「表」是最长、最常看的一层，给它更宽的余量 */
.path-row:last-child > label select { min-width: 220px; max-width: 380px; }
.pager { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 字段 / 操作条 / 后果预警一律取 main.css 的公共式样。
   此前这里私有复刻了 .restore-warn（硬编码 #FF5A36）、.modal-actions、.danger-btn（#C73E1F）。 */
/* 连接表列宽（站点表范式）：库/文件为唯一弹性列；操作列 270px 容下
   浏览 / SQL / 备份 / 恢复 4 个带文字按钮。 */
col.w-dbname { width: 10%; }
col.w-dbremark { width: 170px; }  /* 备注（022）：ellipsis + title 兜长文 */
col.w-dbeng { width: 8%; }
col.w-dbhost { width: 14%; }
col.w-dbdb { width: auto; }
col.w-dbcli { width: 11%; }
col.w-dbacts { width: 390px; }
/* 操作列下限（审计 U-窄屏）：auto 布局下 col 的 width 只是建议，min-width 须落
   在 td 上；浏览/SQL/备份/恢复 4 按钮需 270px，窄屏随「备注」列隐藏一并收敛。
   注意 .nowrap 已在单元格 class 上提供不换行，这里只补下限宽度。 */
.acts { white-space: nowrap; min-width: 390px; }
/* 备注单元格：内联编辑组件自带内边距，单元格再收紧一点保持行高紧凑 */
td.remark-cell { padding: 4px 10px; }
</style>

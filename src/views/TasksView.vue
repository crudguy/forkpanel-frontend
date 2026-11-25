<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { fmtDateTime, taskStateBadge, taskStateLabel, TASK_STATE_OPTIONS } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import TaskRunDetail from '@/components/TaskRunDetail.vue'
import { useAsync } from '@/composables/useAsync'
import { usePolling } from '@/composables/usePolling'
import { PAGE_SIZE_ALL, useTableControls, type SortColumn } from '@/composables/useTableControls'
import { toast } from '@/composables/useToast'

/** 与后端 task_runs 实态对齐（契约 Task schema） */
interface Task {
  id: number; key: string; kind: string; state: string; progress: number
  started_at: number | null; finished_at: number | null; exit_code: number | null
  output_path?: string | null; duration_secs?: number | null; needs_human?: boolean
}

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
// 准入与取消动作分别对应后端 tasks.rs 的 TASK_VIEW / TASK_MANAGE（无能力位门控）。
const canView = computed(() => auth.can('task.view'))
const canCancel = computed(() => auth.can('task.manage'))

const tasks = ref<Task[]>([])
// ── 任务表：分页 + 排序（全站表格约定；只切当前页数据，不动 `sel` 选中逻辑）──
// 状态按后端枚举原文比较（不按中文标签）：标签文案调整不会让同一任务的排序位置漂移。
const taskSortCols: SortColumn<Task>[] = [
  { key: 'id', dir: 'desc', compare: (a, b) => a.id - b.id },
  { key: 'key', dir: 'asc', compare: (a, b) => (a.key || a.kind || '').localeCompare(b.key || b.kind || '') },
  { key: 'state', dir: 'asc', compare: (a, b) => (a.state ?? '').localeCompare(b.state ?? '') },
  { key: 'progress', dir: 'desc', compare: (a, b) => (a.progress ?? 0) - (b.progress ?? 0) },
  { key: 'started_at', dir: 'desc', compare: (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0) },
]
// 默认 #（id）倒序：任务 id 自增，最新提交的备份/部署任务最需要盯着；列表轮询时新任务是
// 追加在数组末尾的，倒序后它会出现在第一页首行，而不是被挤到最后一页看不到。
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<Task>({
    rows: tasks, defaultSize: 100, defaultSort: { key: 'id', dir: 'desc' }, columns: taskSortCols,
    persistKey: 'tasks.list',
  })

/**
 * 状态筛选（后端支持 `?state=`，此前前端没有入口）。
 * 统一用「全部」选项而不是可清空的输入框：状态是有限枚举，下拉比手打更不容易出错。
 */
const stateFilter = ref('')
const stateTabs = TASK_STATE_OPTIONS

/**
 * 请求行数 = 当前每页条数（含「全部」档）。
 *
 * ⚠ 这不是纯客户端分页：`task_runs` 会无限增长，一次全量拉库会随使用时长劣化。
 * 但 `TablePager` 的「全部」档语义就是整表，而服务端分页（size 当 limit/offset）
 * 与客户端的 `useTableControls` 切片又是两套东西。这里取折中：按 size 取数，
 * 「全部」映射成后端约定的 0（=不限，受 1000 条上限兜底）。
 *
 * 修的是原先**默认 100 却只拿回 50 条**的错位：分页器按 100/页算出页数、
 * 实际只有 50 行 ⇒ 表现为「第 2 页是空的」「共 50 个任务」后者还只是显示错，
 * 前者会让用户以为任务丢了。
 */
const requestLimit = computed(() =>
  size.value === PAGE_SIZE_ALL ? 0 : size.value,
)

/** 列表的 loading/error 生命周期交给 useAsync（与其余 12 个视图同一套）；
 *  本页只保留 `output` 自己的加载态——任务输出是另一路请求，与服务端无关。 */
const { loading, error, run } = useAsync(true)
const sel = ref<Task | null>(null)
const output = ref('')
const outLoading = ref(false)

async function fetchTasks(): Promise<void> {
  const r = await api.get<Task[]>(API.tasks.list({
    state: stateFilter.value || undefined,
    limit: requestLimit.value,
  }))
  tasks.value = Array.isArray(r) ? r : []
}
/** 用户触发的加载（重试按钮 / 刷新按钮 / 首屏）：失败要落错误条。 */
function load() { return run(fetchTasks) }
/** 后台静默刷新：轮询专用，不闪骨架、不落错误条。
 *  ⚠ 不能给 load 加 `silent = false` 形参后继续把它绑在 `@click="load"` 上：
 *    Vue 会把 PointerEvent 当第一个实参传进来，silent 变成 truthy，
 *    用户点的「重试」会静默吞掉错误（vue-tsc 也能抓到这个类型错）。 */
function loadSilent() { return run(fetchTasks, undefined, { silent: true }) }
onMounted(() => { if (canView.value) load() })

/**
 * 深链恢复：`/cron/tasks?task=12` 直接打开该任务详情。
 *
 * 只传一个 `{ id }` 占位行给 `open()`——它内部会拉单体详情拿全字段，
 * 列表行的其余字段本来就只是兜底。任务不存在时 open 的两路请求都会失败，
 * 但 `sel` 仍是占位行，界面上表现为「详情开了但无输出」，不会白屏。
 */
function restoreFromUrl() {
  if (!canView.value) return
  const raw = route.query.task
  const id = Number(typeof raw === 'string' ? raw : '')
  if (!Number.isInteger(id) || id <= 0) return
  if (sel.value?.id === id) return
  void open({ id, key: '', kind: '', state: '', progress: 0, started_at: null, finished_at: null, exit_code: null })
}
// 首屏 + 之后任何来源的 task 参数变化（含浏览器前进/后退）都恢复对应详情
watch(() => route.query.task, () => restoreFromUrl(), { immediate: true })

// 筛选 / 每页条数变化 ⇒ 必须重新向服务端要数（limit 变了，本地缓存的行数就不够）：
// 这两者在客户端切片里只意味「换一页」，但本页的行数是**按 limit 取回来的**，
// 不重拉就会把「选 100 仍只有 50 行」的错位从服务端搬到客户端。
watch([stateFilter, size], () => { if (canView.value) void load() })

function isLive(t: Task | null) { return !!t && (t.state === 'running' || t.state === 'queued') }

/** 列表轮询（F-06）。
 *
 *  副标题承诺「运行中每 2 秒自动刷新」，但此前唯一的 usePolling 只在**打开详情**
 *  时拉单体进度（enabled 依赖 sel）；停在列表页时进度永远停在首屏，文案是假的。
 *  enabled 每 tick 求值：列表里出现 running/queued 就自动补拉，全部结束即空转，
 *  不需要 watcher，也不需要手动 stop/restart。silent 让后台刷新不闪骨架、
 *  不落错误条（瞬时失败交给下一轮自愈，与详情轮询同口径）。 */
usePolling({
  ms: 2000,
  enabled: () => canView.value && tasks.value.some(isLive),
  fn: () => { void loadSilent() },
})

/** 运行中任务每 2s 轮询单体详情刷新进度。
 *
 *  「是否在轮」由 enabled 表达（sel 是运行中任务），任务结束时 enabled 变假、
 * 链空转——不再需要手写 stopPoll 清理句柄；只有"用户主动关闭详情"才永久停。
 *  换看另一个任务时 restart() 解除永久停（上一个任务跑完时停过）。 */
const taskPoll = usePolling({
  ms: 2000,
  enabled: () => canView.value && isLive(sel.value),
  fn: async () => {
    if (!sel.value) return
    try {
      const d = await api.get<Task>(API.tasks.get(sel.value.id))
      sel.value = d
      if (!isLive(d)) { taskPoll.stop(); load() }
    } catch { /* 瞬时错误忽略，下一轮重试 */ }
  },
})

/**
 * 输出区文案：后端对「路径还在但文件已被清理」会降级成 200 + note，
 * 这时要把「输出不可用」讲清楚，不能显示误导性的「(无输出)」或错误堆栈。
 */
function formatTaskOutput(r: { lines?: string[]; note?: string }): string {
  if (r.note && r.note !== '无输出文件') return `⚠ ${r.note}`
  return r.lines?.length ? r.lines.join('\n') : '(无输出)'
}

async function open(t: Task) {
  sel.value = { ...t }; outLoading.value = true; output.value = ''
  syncUrl(t.id)
  // 详情（拿派生字段 duration_secs 等）；失败则退回列表行数据
  try { sel.value = await api.get<Task>(API.tasks.get(t.id)) }
  catch { /* 列表行兜底 */ }
  // 输出：后端返回 {id, lines[]}（不是 output 字符串——旧代码在这里永远显示"无输出"）
  try {
    const r = await api.get<{ id: number; lines: string[]; note?: string }>(API.tasks.output(t.id))
    output.value = formatTaskOutput(r)
  } catch (e) { output.value = errorText(e) }
  finally { outLoading.value = false }
  taskPoll.restart()
}

/** 关闭详情（同时清掉 URL 里的 task 参数，避免"关掉了但刷新又冒出来"）。 */
function close() {
  taskPoll.stop()
  sel.value = null
  syncUrl(null)
}

/**
 * 详情选中态同步到 `?task=<id>`：刷新 / 切页签 / 把链接发给同事都能落回同一条输出。
 * 用 `router.replace` 而不是 `push`：选任务不是导航，不该把浏览器返回栈撑满
 * （否则用户按返回要连点十几次才回到上一页）。
 * 查询串里其它参数原样保留——本页目前没有别的参数，但将来加筛选时不该被清掉。
 */
function syncUrl(id: number | null) {
  const q = { ...route.query }
  if (id == null) delete q.task
  else q.task = String(id)
  // 与当前完全一致时不 replace：避免 watch/再入造成多余的 history 操作
  const now = JSON.stringify(route.query)
  if (JSON.stringify(q) === now) return
  void router.replace({ query: q })
}

async function cancel(t: Task) {
  if (!canCancel.value) return
  try {
    await api.post(API.tasks.cancel(t.id))
    toast(`已请求取消任务 #${t.id}`)
    // await：重载完成前列表还是旧状态；后面的 open 也要等它自己那两路请求回来
    await load()
    if (sel.value?.id === t.id) await open(t)
  // 行级动作的失败走 toast，不占列表级 error 条：那条错误挂在页面顶部、还带一个
  // 只会「重新拉列表」的重试按钮——用户点它并不会重试取消，会重试的是别的事。
  } catch (e) { toast(`取消任务失败：${errorText(e)}`, 'err') }
}

// 状态徽标/文案统一走共享词表（src/api/types.ts）：此前只认 'ok'，
// 且把英文 state 直接甩给用户；服务页判的却是 'done'——同一任务两处颜色不同
function stateClass(s: string) { return taskStateBadge(s) }
const stateText = taskStateLabel
/** 失败判定（含历史脏值）：只有失败的任务才有意义显示退出码。 */
function isFailed(t: Task) { return t.state === 'failed' }
</script>

<template>
  <div>
    <p v-if="error" class="err">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
    <EmptyState v-if="!canView" title="无任务查看权限" reason="需要 task.view" />
    <div v-else-if="loading" class="skeleton box" />
    <template v-else>
      <!-- 动作收进卡片顶栏（同 ProcessesView 范式）：去掉只放一个「刷新」的页面级
           page-head 横条，工具条紧贴它操作的表；横滚交给内部 .t-scroll。 -->
      <div class="card flush toolbar-card">
        <div class="card-toolbar">
          <Icon name="clock" :size="16" />
          <span class="count">
            <template v-if="stateFilter">共 {{ tasks.length }} 个「{{ stateText(stateFilter) }}」任务</template>
            <template v-else>共 {{ tasks.length }} 个任务</template>
          </span>
          <span class="spacer" />
          <!-- 状态筛选：宽 auto + flex:0 1 140px 压掉全局 select{width:100%}，
               否则筛选条里一个下拉会吃满整行（全站筛选条约定）。 -->
          <select v-model="stateFilter" class="filter filter-sel" aria-label="按状态筛选任务">
            <option value="">全部状态</option>
            <option v-for="o in stateTabs" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <RefreshBtn :disabled="loading" sm @click="load" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <colgroup>
            <col class="w-tid" /><col class="w-tname" /><col class="w-tstate" /><col class="w-tprog" /><col class="w-tstart" /><col class="w-tacts" />
          </colgroup>
          <thead><tr>
            <SortTh label="#" :active="isSorted('id')" :dir="sortDir" @sort="toggleSort('id')" />
            <SortTh label="任务" :active="isSorted('key')" :dir="sortDir" @sort="toggleSort('key')" />
            <SortTh label="状态" :active="isSorted('state')" :dir="sortDir" @sort="toggleSort('state')" />
            <SortTh class="num" label="进度" :active="isSorted('progress')" :dir="sortDir" @sort="toggleSort('progress')" />
            <SortTh label="开始时间" :active="isSorted('started_at')" :dir="sortDir" @sort="toggleSort('started_at')" />
            <th />
          </tr></thead>
          <tbody>
            <!-- 深链 / 切页后选中的任务不在当前页：详情退到表首，仍比原来的「页面最底部」近。 -->
            <tr v-if="sel && !pageRows.some((t) => t.id === sel?.id)" class="detail-row">
              <td colspan="6">
                <TaskRunDetail :task="sel" :output="output" :out-loading="outLoading" @close="close" />
              </td>
            </tr>
            <template v-for="t in pageRows" :key="t.id">
            <!-- 键盘可达（审计 P10）：行可 Tab 聚焦，Enter/Space 打开详情 -->
            <tr :class="{ active: sel?.id === t.id }" @click="open(t)"
                tabindex="0" role="button" :aria-label="`查看任务 #${t.id} 详情`"
                @keydown.enter="open(t)" @keydown.space.prevent="open(t)" style="cursor:pointer">
              <td class="mono">{{ t.id }}</td>
              <td class="mono dim ellipsis" :title="t.key || t.kind">{{ t.key || t.kind }}</td>
              <td>
                <span class="badge" :class="stateClass(t.state)">{{ stateText(t.state) }}</span>
                <span v-if="t.needs_human" class="badge" title="任务被中断，需人工确认后续影响">需人工</span>
                <!-- 失败任务的退出码是「错在哪」的第一线索，此前只在点开详情后才看得到 -->
                <span v-if="isFailed(t) && t.exit_code != null" class="badge badge-danger exit-chip"
                      :title="`退出码 ${t.exit_code}`">exit {{ t.exit_code }}</span>
              </td>
              <td class="num">
                <div class="mini">
                  <div class="progress"><i :style="{ width: (t.progress ?? 0) + '%' }" /></div>
                  <span>{{ t.progress ?? 0 }}%</span>
                </div>
              </td>
              <td class="muted nowrap">{{ fmtDateTime(t.started_at) }}</td>
              <td class="nowrap">
                <button class="btn-sm" @click.stop="open(t)"><Icon name="terminal" :size="14" /> 输出</button>
                <button v-if="isLive(t) && canCancel" class="btn-ghost btn-sm danger" title="取消任务" @click.stop="cancel(t)">取消</button>
              </td>
            </tr>
            <!-- 详情就地展开在所点击的行下面：任务多时不必滑到页面最底部。 -->
            <tr v-if="sel?.id === t.id" class="detail-row">
              <td colspan="6">
                <TaskRunDetail :task="sel" :output="output" :out-loading="outLoading" @close="close" />
              </td>
            </tr>
            </template>
            <tr v-if="!total"><td colspan="6">
              <EmptyState v-if="stateFilter" :title="`没有「${stateText(stateFilter)}」状态的任务`"
                hint="换个状态看看，或切回「全部状态」。">
                <template #cta>
                  <button class="btn-ghost" type="button" @click="stateFilter = ''">查看全部状态</button>
                </template>
              </EmptyState>
              <EmptyState v-else title="暂无任务" hint="安装软件、备份、恢复等耗时操作提交后会出现在这里。" />
            </td></tr>
          </tbody>
        </table>
        </div>
        <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
          @update:page="gotoPage" @update:size="changeSize" />
      </div>

    </template>
  </div>
</template>

<style scoped>
.box { height: 320px; border-radius: var(--radius); }
.mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.mini .progress { flex: 1; }
.mini span { font-size: var(--fs-12); color: var(--c-text-dim); font-variant-numeric: tabular-nums; }
tr.active { background: var(--c-active) !important; }
/* 详情行不画自己的边框/内边距，交给内部 .detail-card，避免 td 与卡片双层盒子。 */
tr.detail-row > td { padding: 0 0 8px; border-bottom: 0; }
/* 任务表显式列宽（与站点/进程页统一范式：table-layout:fixed + colgroup）。
   任务标识（kind/key）为唯一弹性列，可能较长，ellipsis 截断、完整值走 title。 */
.w-tid { width: 6%; }
.w-tname { width: auto; }     /* 弹性列 */
/* 状态列要容下「状态 + 需人工 + exit N」三个徽标（失败任务两个同时出现），
   12% 会把 exit 徽标挤成换行、把行高顶起来。 */
.w-tstate { width: 18%; }
.w-tprog { width: 13%; }      /* 含迷你进度条（min-width 120px） */
.w-tstart { width: 16%; }
.w-tacts { width: 160px; }    /* 输出 + 取消两个带文字按钮 */

/* 筛选条下拉：先 width:auto 压掉全局 select{width:100%}，再用 flex 定基准宽 */
.filter-sel { width: auto; flex: 0 1 140px; }
/* 徽标之间留一点缝：状态下方的第二、三个徽标此前紧贴成一片 */
.exit-chip { margin-left: 6px; font-family: var(--mono); }

</style>

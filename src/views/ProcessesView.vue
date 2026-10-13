<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, ProcessInfo } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import PageLayout from '@/components/PageLayout.vue'

// 直接复用契约类型 ProcessInfo（与后端 panel_os::ProcessInfo 逐字段对齐：
// pid/ppid/name/cpu_pct/rss_kib/cmdline/user）。不再维护仅含子集的局部 Proc——
// 否则 ppid/cmdline 缺失、user 被错标成 string，字段一旦在后端改名就静默渲染成"—"。
type Proc = ProcessInfo

const auth = useAuthStore()
const procs = ref<ProcessInfo[]>([])
const error = ref('')
const pending = ref('')
const loading = ref(true)
const busy = ref<number | null>(null)

async function load(silent = false) {
  // silent=true 是轮询刷新：不能重置 loading，否则表格每 3 秒闪一次骨架
  if (!silent) { error.value = ''; pending.value = ''; loading.value = true }
  try {
    // limit=0（或省略）= 展示全部进程，由前端即时排序，不回源。
    // r 已是拆信封后的裸数组 ProcessInfo[]（client.ts 自动取 body.data）；
    // 原 Array.isArray(r) ? r : r.processes 分支是旧信封时代的死代码，删去。
    const r = await api.get<ProcessInfo[]>(API.processes.list(), { params: { limit: 0, sort: 'cpu' } })
    procs.value = r
    // 仅手动刷新/首次加载才清错误：轮询失败不该让常驻的表格抖动，
    // 但也不能把错误静默吞掉——下一轮成功即自愈。
    if (!silent) { error.value = ''; pending.value = '' }
  } catch (e) {
    if (isUnsupported(e)) pending.value = '进程管理功能即将推出（进程快照尚未接入）'
    else if (!silent) error.value = errorText(e)
  }
  finally { if (!silent) loading.value = false }
}

// ── 自动刷新 ──
// 进程是"活"数据：谁在吃 CPU、有没有新进程起来，都要能一眼看出。
//
// 为什么必须自动刷新而不是只用手动按钮：**进程的 cpu_pct 是两次
// /proc 采样的增量**（后端 LinuxMetrics 持有 prev 快照，无基线时恒为 0）。
// 手动点一次刷新只能拿到一个瞬时值；要有可读趋势就得连续采样。
//
// 3 秒：本机 438 个进程实测单次 /processes 往返约 40ms、75KB（见
// 提交说明），3 秒间隔完全无压力，且比 ProfessionalView 的 2 秒更
// 克制——进程列表不需要那么高的刷新率。
let timer: number | undefined

function stop() { if (timer) { clearInterval(timer); timer = undefined } }
function start() { stop(); timer = window.setInterval(() => load(true), 3000) }

/** 页面隐藏时停轮询：后台标签页持续拉 438 进程纯属浪费。 */
function onVisibility() {
  if (document.hidden) { stop(); return }
  load(true)
  start()
}

onMounted(() => {
  load()
  start()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  stop()
  document.removeEventListener('visibilitychange', onVisibility)
})

// ── 表头排序（纯前端，数据已全量拉回，点击即时排序，不回源）──
type SortKey = 'pid' | 'name' | 'user' | 'cpu' | 'mem'
const sortKey = ref<SortKey>('cpu')
const sortDir = ref<'asc' | 'desc'>('desc')
const sorted = computed(() => {
  const arr = procs.value.slice()
  const dir = sortDir.value === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    switch (sortKey.value) {
      case 'pid': return (a.pid - b.pid) * dir
      case 'cpu': return ((a.cpu_pct ?? 0) - (b.cpu_pct ?? 0)) * dir
      case 'mem': return (a.rss_kib - b.rss_kib) * dir
      case 'name': return (a.name ?? '').localeCompare(b.name ?? '') * dir
      case 'user': return (a.user ?? '').localeCompare(b.user ?? '') * dir
    }
  })
  return arr
})
function toggleSort(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = k
    // 数值列默认降序（高占用在前），文本列默认升序（A→Z）
    sortDir.value = (k === 'pid' || k === 'cpu' || k === 'mem') ? 'desc' : 'asc'
  }
}
function sortInd(k: SortKey): string {
  if (sortKey.value !== k) return ''
  return sortDir.value === 'asc' ? ' ▲' : ' ▼'
}

/**
 * 三种信号操作，语义差别很大，故用显式联合类型而非布尔开关——
 * 布尔（force）会让"是不是强制"散落在按钮、title、弹窗多处 if 里，
 * 加第三种时必漏。
 *
 *  - reload 重载：SIGHUP(1)，daemon 重新读配置而**不退出**（nginx 等）
 *  - 结束：     SIGTERM(15)，请求退出，允许保存数据/关连接
 *  - 立即终止： SIGKILL(9)，内核直接杀，无收尾机会
 *
 * 文案用「立即终止」而非「强制」——"强制"没说明强在哪，用户不敢点。
 */
type ProcAction = 'reload' | 'term' | 'kill'

const ACTION_META: Record<ProcAction, { label: string; title: string; danger: boolean }> = {
  reload: {
    label: '重载',
    title: '重载配置：发送 SIGHUP，进程重新读取配置但不退出。适用于 nginx 这类守护进程——不中断服务',
    danger: false,
  },
  term: {
    label: '结束',
    title: '正常退出：发送 SIGTERM，进程可以保存数据、关闭连接后自行退出',
    danger: true,
  },
  kill: {
    label: '立即终止',
    title: '立即终止：发送 SIGKILL，进程没有保存数据、关闭连接的收尾机会，未落盘内容会丢失。仅在它卡死不响应时使用',
    danger: true,
  },
}

const killTarget = ref<Proc | null>(null)
const action = ref<ProcAction>('term')

function askKill(p: Proc, a: ProcAction = 'term') { killTarget.value = p; action.value = a }

const ACTION_SIGNAL: Record<ProcAction, string> = { reload: 'hup', term: 'term', kill: 'kill' }

const killTitle = computed(() => ({
  reload: '重载进程配置', term: '结束进程', kill: '立即终止进程',
}[action.value]))

/** 确认弹窗正文：说清"会发生什么"与"何时该用/不该用"，
 *  并给出退路（"若无响应可改用立即终止"），避免用户因不确定而不敢操作。 */
const ACTION_DETAIL: Record<ProcAction, (p: Proc) => string> = {
  reload: (p) => `将向 ${p.name}（PID ${p.pid}）发送 SIGHUP，让它重新读取配置而**不退出**。`
    + `适用于 nginx 这类守护进程的热重载——服务不中断。`
    + `注意：并非所有进程都实现了重载语义，普通的应用程序收到后可能什么都不做。`,
  term: (p) => `将向 ${p.name}（PID ${p.pid}）发送 SIGTERM，允许它保存数据、关闭连接后自行退出。`
    + `若无响应，可回来改用「立即终止」。系统关键进程（PID ≤ 1）已被禁止。`,
  kill: (p) => `即将立即终止 ${p.name}（PID ${p.pid}）。它没有保存数据、关闭连接的收尾机会，`
    + `未写入磁盘的内容会丢失——请仅在它已卡死、点了「结束」无响应时使用。`,
}

async function doKill() {
  const p = killTarget.value
  if (!p) return
  busy.value = p.pid
  try {
    await api.post(API.processes.kill(String(p.pid)), { signal: ACTION_SIGNAL[action.value] })
    killTarget.value = null
    await load()
  }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = null }
}
</script>

<template>
  <PageLayout>
    <EmptyState v-if="!auth.supported(CAP.PROCESS_LIST)"
      title="当前环境不支持进程管理" :reason="auth.capabilities[CAP.PROCESS_LIST]?.reason ?? undefined" />

    <template v-else>
      <p v-if="pending" class="note">{{ pending }}</p>
      <p v-if="error" class="err">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button></p>

      <div v-if="loading" class="skeleton box" />
      <div v-else class="card flush procs-card">
        <!-- 表头工具条：进程数 + 刷新。作为卡片顶栏紧贴表格，与下方 thead
             合成一个统一的"表头区"，避免原先「悬浮条 + 卡片内列头」两层表头
             各自为政、视觉割裂。（其它列表页刷新在 page-head，本页操作对象只
             有这张表，故把工具条收进卡片顶栏更紧凑，也保留"刷新贴着表"的直觉） -->
        <div class="procs-toolbar">
          <Icon name="process" :size="16" />
          <span class="count">共 {{ sorted.length }} 个进程</span>
          <span class="spacer" />
          <button class="btn-ghost btn-sm" :disabled="loading" @click="load()">
            <Icon name="refresh" :size="14" /> 刷新
          </button>
        </div>
        <!-- B8：容器自己滚 + 表头吸顶（.t-scroll）。进程常有数百行，滚动时看不见列头
             就只能靠记住列序——这是"信息密度"之外同样致命的可读性问题。 -->
        <div class="procs-scroll t-scroll">
        <table v-table-nav>
          <colgroup>
            <col class="w-pid" /><col /><col class="w-user" /><col class="w-cpu" /><col class="w-mem" /><col class="w-acts" />
          </colgroup>
          <thead>
            <tr>
              <th class="num sortable" :class="{ active: sortKey === 'pid' }" @click="toggleSort('pid')">PID{{ sortInd('pid') }}</th>
              <th class="sortable" :class="{ active: sortKey === 'name' }" @click="toggleSort('name')">进程{{ sortInd('name') }}</th>
              <th class="sortable" :class="{ active: sortKey === 'user' }" @click="toggleSort('user')">用户{{ sortInd('user') }}</th>
              <th class="num sortable" :class="{ active: sortKey === 'cpu' }" @click="toggleSort('cpu')">CPU{{ sortInd('cpu') }}</th>
              <th class="num sortable" :class="{ active: sortKey === 'mem' }" @click="toggleSort('mem')">内存{{ sortInd('mem') }}</th>
              <th class="acts-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in sorted" :key="p.pid">
              <td class="pid mono num">{{ p.pid }}</td>
              <td class="proc-name" :title="p.name">{{ p.name }}</td>
              <td>{{ p.user ?? '-' }}</td>
              <td class="num">{{ (p.cpu_pct ?? 0).toFixed(1) }}%</td>
              <td class="num">{{ (p.rss_kib / 1024).toFixed(0) }} MB</td>
              <td class="acts-col nowrap">
                <!-- 操作改为纯图标：颜色即语义、节省列宽。
                     重载=中性灰(refresh↻) / 结束=琥珀(stop■) / 立即终止=红(bolt⚡)，
                     危险度梯度对应 SIGHUP<SIGTERM<SIGKILL；图标形状差异大，一眼可辨。
                     文字说明保留在确认弹窗，hover 仍有 title 提示。 -->
                <button class="btn-icon act-reload" :disabled="busy === p.pid || p.pid <= 1"
                  :title="ACTION_META.reload.title" @click="askKill(p, 'reload')">
                  <Icon name="refresh" :size="16" />
                </button>
                <button class="btn-icon act-term" :disabled="busy === p.pid || p.pid <= 1"
                  :title="ACTION_META.term.title" @click="askKill(p, 'term')">
                  <Icon name="stop" :size="16" />
                </button>
                <button class="btn-icon act-kill" :disabled="busy === p.pid || p.pid <= 1"
                  :title="ACTION_META.kill.title" @click="askKill(p, 'kill')">
                  <Icon name="bolt" :size="16" />
                </button>
              </td>
            </tr>
            <tr v-if="!sorted.length"><td colspan="6"><EmptyState title="无进程数据" /></td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </template>

    <ConfirmDialog :open="!!killTarget" :danger="ACTION_META[action].danger"
      :title="killTitle"
      :detail="killTarget ? ACTION_DETAIL[action](killTarget) : ''"
      @confirm="doKill" @cancel="killTarget = null" />
  </PageLayout>
</template>

<style scoped>
.box { height: 320px; border-radius: var(--radius); }
/* 卡片只负责圆角裁切；横向滚动交给内部 .procs-scroll，
   这样顶栏（进程数 + 刷新）在窄屏不被表内容带着横滚。 */
.card.flush.procs-card { overflow: hidden; }
/* 表头工具条：与 thead 合成统一表头区，下边线与 thead 的上沿相接，
   视觉上是一整块"表头"而非悬浮条 + 卡片列头两层。 */
.procs-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--c-border); }
.procs-toolbar .icon { color: var(--c-primary); }
.procs-toolbar .count { font-weight: 600; font-size: var(--fs-14); }
/* 限高 = 容器真的会滚 = 吸顶表头才有意义（不限高时滚动发生在页面上，
   sticky 贴的是容器顶边，滚动时它跟着一起走，等于没加）。
   260px ≈ 顶栏 58 + 内容区上下内边距 62 + 卡片工具条 45 + 页头与留白 ~95。
   给 min-height：进程很少时不至于把卡片压成一条缝。 */
.procs-scroll {
  overflow: auto;
  max-height: calc(100vh - 260px);
  min-height: 200px;
}

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
/* 上下内边距必须走 --row-py（密度档），**不能写死**：scoped 编译成 `td[data-v-x]`
   = 特异性 (0,1,1)，永远压过 main.css 里全局的 `th, td` (0,0,1)——写死 9px 时
   这里是"紧凑/宽松"两档完全失效、行高恒定 53px（实机实测），而构建与守卫全绿。
   左右保持 12px 是本表原有取值，不动。 */
th, td { padding: var(--row-py) 12px; text-align: left; font-size: var(--fs-13); border-bottom: 1px solid var(--c-border); }
/* 与全站表格表头一致：用 text-dim 而非更暗的 text-mute，
   此前单列头偏灰、与 Firewall/Services 等列表页对不齐。 */
th { color: var(--c-text-dim); font-weight: 600; }
td.num, th.num { text-align: right; }
tbody tr:hover { background: var(--c-hover); }
.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.sortable:hover { color: var(--c-text); }
.sortable.active { color: var(--c-primary); }

/* 列宽：固定布局，避免进程名长短不定把 CPU/内存列挤到视口外。
   类名用 w- 前缀，与单元格自身的 class（.pid/.proc-name）区分开。 */
col.w-pid  { width: 80px; }
col.w-user { width: 110px; }
col.w-cpu  { width: 84px; }
col.w-mem  { width: 96px; }
col.w-acts { width: 144px; }   /* 纯图标按钮：3×34 + 间距 + 单元格内边距，足够且不撑宽 */

/* 操作列：按钮右对齐，与数值列的视觉重心一致；表头也右对齐，
   否则「操作」二字悬在左、下方按钮靠右，看着像两列。 */
th.acts-col, td.acts-col { text-align: right; }

/* 纯图标操作按钮：颜色即语义，节省列宽。
   重载(neutral) / 结束(amber, 温和停止) / 立即终止(red, 强制) 形成危险度梯度，
   与 SIGHUP < SIGTERM < SIGKILL 的信号强度一致；hover 仍有 title 解释，
   文字说明保留在确认弹窗。图标 refresh/stop/bolt 形状差异大，一眼可辨。 */
.act-reload { color: var(--c-text-dim); }
.act-reload:hover:not(:disabled) { color: var(--c-text); }
.act-term { color: var(--c-warn); border-color: var(--c-warn); background: var(--c-warn-bg); }
.act-term:hover:not(:disabled) { color: var(--c-warn); border-color: var(--c-warn); background: var(--c-warn-bg); filter: brightness(1.08); }
.act-kill { color: var(--c-danger); border-color: var(--c-danger); background: var(--c-danger-soft); }
.act-kill:hover:not(:disabled) { color: var(--c-danger); border-color: var(--c-danger); background: var(--c-danger-soft); filter: brightness(1.08); }

/* 进程名可能极长（容器/内核线程的完整名可达数十字符），固定布局下必须
   省略号截断，否则会顶开列宽把右侧列挤出视口；完整名走 title 悬停。 */
td.proc-name {
  max-width: 0;               /* 配合 table-layout:fixed 允许内容省略 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

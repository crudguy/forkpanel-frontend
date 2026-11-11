<script setup lang="ts">
/**
 * Compose Tab（ContainersView 拆分）：面板编排卡片 + Compose 项目列举 + 下钻 + 生命周期动作。
 *
 * ## 为什么它自己拉容器列表
 * 下钻要回答「这个 compose 项目下有哪些容器」，数据源是容器列表的
 * `com.docker.compose.project` 标签。原先直接复用父级的 `containers`，但那份数据
 * **只在「容器」Tab 轮询刷新**——切到 Compose 后它就不再更新，下钻看到的可能是
 * 几分钟前的容器集合，甚至误报「compose 报告 N 个、实际匹配 0 个」。
 * 现在本 Tab 激活时自己拉一次容器列表，与项目清单同源同刻，比对才有意义。
 *
 * ## 轮询
 * 刻意**不轮询**：项目清单随 `docker compose up/down` 显式变化，没有"不刷新就
 * 失去意义"的实时字段；工具栏「刷新」即可（与帮助抽屉口径一致）。
 */
import { computed, ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { containerStateBadge, containerStateLabel } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import SortTh from '@/components/SortTh.vue'
import StackEditorDialog from '@/components/StackEditorDialog.vue'
import StackImportDialog from '@/components/StackImportDialog.vue'
import TablePager from '@/components/TablePager.vue'
import { COMPOSE_ACTIONS, type ComposeActionKey } from '@/composables/composeActions'
import {
  containersOfProject, drillEmptyHint, projectCountMismatch,
} from '@/composables/composeDrill'
import type { StackServicePayload } from '@/composables/stackForm'
import { useAsync } from '@/composables/useAsync'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import { toast } from '@/composables/useToast'

/** compose 行（`docker compose ls --all --format json`）。status 是组合语义串
 *  （running(1) / exited(2)…，括号内为容器数），同口径不翻译。 */
interface ComposeProjectLine {
  name: string; status: string; config_files: string
}
/** 下钻只用到这几个字段（容器列表的子集）。 */
interface DrillContainer {
  id: string; name: string; state: string; image: string
  compose_project?: string | null; compose_service?: string | null
}
/** 面板管理的编排项目（对应 GET /containers/stacks） */
interface StackRow {
  project: string
  dir: string
  config_file: string
  services: StackServicePayload[]
  /** compose.yaml 被外部改过——此时不允许在面板里覆盖保存 */
  externally_modified: boolean
}

const props = defineProps<{
  active: boolean
  /** container.manage：生命周期动作与「新建编排」需要 */
  canManage: boolean
  /** 能力位：daemon 是否可用（读操作的门槛，与权限无关） */
  supported: boolean
}>()

const composeProjects = ref<ComposeProjectLine[]>([])
/** 本 Tab 自己拉的一份容器列表（下钻用，见文件头说明） */
const containers = ref<DrillContainer[]>([])
// 状态机（loading/error/失败分支）统一走 useAsync；本 Tab 一次拉两份数据，故不用 useRowLoad
const { loading, error, run } = useAsync()

/** 当前展开下钻的 Compose 项目名（null = 未展开） */
const drillProject = ref<string | null>(null)
const drillContainers = computed(() =>
  drillProject.value ? containersOfProject(containers.value, drillProject.value) : [],
)
const drillRow = computed(() =>
  drillProject.value ? composeProjects.value.find((p) => p.name === drillProject.value) ?? null : null,
)
/** compose 自报数量 vs 面板实际看到的数量（不一致要如实提示）。 */
const drillMismatch = computed(() =>
  projectCountMismatch(drillRow.value?.status ?? '', drillContainers.value.length),
)
function toggleDrill(name: string) {
  drillProject.value = drillProject.value === name ? null : name
}

// ── 生命周期动作（写，container.manage）──
// 危险度分级：up/stop/restart 可逆、日常，点了就执行；
// down 会**整项目停服**，需在确认框里手输项目名。
const composeBusy = ref(false)
const composeDownOpen = ref(false)
const composeDownTarget = ref<string | null>(null)
/** down 弹窗里展示的服务数，让用户在停之前看清影响范围 */
const composeDownCount = computed(() => drillContainers.value.length)

// ── 面板编排（stack 定义，写的是面板自己的文件，不依赖 daemon）──
const stacks = ref<StackRow[]>([])
const stackEditOpen = ref(false)
const stackEditTarget = ref<StackRow | null>(null)
const stackBusy = ref(false)
const stackImportOpen = ref(false)

async function loadStacks() {
  if (!props.supported) return
  try {
    stacks.value = await api.get<StackRow[]>(API.containers.stacks())
  } catch {
    // 编排列表失败不应拖垮整个 Tab：清空即可，页面上仍有项目清单
    stacks.value = []
  }
}

function openStackEditor(row?: StackRow) {
  stackEditTarget.value = row ?? null
  stackEditOpen.value = true
}

function openStackImport() {
  stackImportOpen.value = true
}

async function onStackSubmit(project: string, services: StackServicePayload[]) {
  stackBusy.value = true
  try {
    await api.put(API.containers.stack(project), { services })
    toast(`已保存编排：${project}`)
    stackEditOpen.value = false
    stackImportOpen.value = false
    await loadStacks()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    stackBusy.value = false
  }
}

async function load() {
  // 能力位关着：不发请求，也不点亮骨架（否则会永远卡在加载中）
  if (!props.supported) return
  await run(
    async () => {
      const [projects, list] = await Promise.all([
        api.get<ComposeProjectLine[]>(API.containers.composeProjects()),
        api.get<DrillContainer[]>(API.containers.list()),
      ])
      composeProjects.value = projects
      containers.value = list
    },
    (e) => {
      composeProjects.value = []; containers.value = []
      error.value = errorText(e)
    },
  )
  await loadStacks()
}

watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

async function runComposeAct(action: ComposeActionKey) {
  const project = drillProject.value
  if (!project || composeBusy.value) return
  composeBusy.value = true
  try {
    // up 需要工作目录：compose 靠它找配置文件（后端会强制校验）
    const body: Record<string, unknown> = { action }
    if (action === 'up') {
      const dir = projectWorkingDir(project)
      if (!dir) {
        error.value = '无法从配置文件路径推断工作目录，请用 docker compose CLI 手动启动该项目'
        return
      }
      body.working_dir = dir
    }
    await api.post(API.containers.composeAct(project), body)
    toast(`已执行 ${action}：${project}`)
    await load()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    composeBusy.value = false
  }
}

/** 从项目的 config_files（compose 配置文件绝对路径）推断工作目录。
 *
 *  取第一个文件的**所在目录**：compose 默认就在该目录下找 compose.yaml。
 *  推断不出来返回空串，由调用方提示用户改用 CLI——**不猜一个路径**：
 *  猜错会让 up 在错误目录执行，可能拉起完全不相干的服务。 */
function projectWorkingDir(project: string): string {
  const row = composeProjects.value.find((p) => p.name === project)
  const first = (row?.config_files ?? '').split(',')[0]?.trim() ?? ''
  if (!first.startsWith('/')) return ''
  const idx = first.lastIndexOf('/')
  return idx > 0 ? first.slice(0, idx) : ''
}

function askComposeDown() {
  if (!drillProject.value) return
  composeDownTarget.value = drillProject.value
  composeDownOpen.value = true
}

async function doComposeDown() {
  const project = composeDownTarget.value
  if (!project) return
  composeBusy.value = true
  try {
    // confirm_token 由 ConfirmDialog 的 confirm-word 校验（必须是项目名本身）
    await api.post(API.containers.composeAct(project), { action: 'down', confirm_token: project })
    toast(`已停止并清理：${project}`)
    composeDownOpen.value = false
    drillProject.value = null
    await load()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    composeBusy.value = false
    composeDownTarget.value = null
  }
}

// ── 三张表的分页 + 排序（全站约定：useTableControls + SortTh + TablePager）──
// 三张表各自独立记忆每页条数。默认都按名称升序（编排 / 项目 / 容器都以名字定位）；
// 编排表的「服务」是条数指标，首次点击按规范把条数多的排前面。
const stackSortCols: SortColumn<StackRow>[] = [
  { key: 'project', dir: 'asc', compare: (a, b) => (a.project ?? '').localeCompare(b.project ?? '') },
  { key: 'services', dir: 'desc', compare: (a, b) => (a.services?.length ?? 0) - (b.services?.length ?? 0) },
  { key: 'dir', dir: 'asc', compare: (a, b) => (a.dir ?? '').localeCompare(b.dir ?? '') },
]
const {
  size: stackSize, page: stackPage, pageCount: stackPageCount, pageRows: stackRows,
  total: stackTotal, sortDir: stackSortDir, toggleSort: toggleStackSort,
  changeSize: changeStackSize, gotoPage: gotoStackPage, isSorted: isStackSorted,
} = useTableControls<StackRow>({
  rows: stacks, defaultSize: 100, defaultSort: { key: 'project', dir: 'asc' }, columns: stackSortCols,
  persistKey: 'compose.stacks',
})

const projectSortCols: SortColumn<ComposeProjectLine>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'status', dir: 'asc', compare: (a, b) => (a.status ?? '').localeCompare(b.status ?? '') },
  { key: 'config_files', dir: 'asc', compare: (a, b) => (a.config_files ?? '').localeCompare(b.config_files ?? '') },
]
const {
  size: projSize, page: projPage, pageCount: projPageCount, pageRows: projRows,
  total: projTotal, sortDir: projSortDir, toggleSort: toggleProjSort,
  changeSize: changeProjSize, gotoPage: gotoProjPage, isSorted: isProjSorted,
} = useTableControls<ComposeProjectLine>({
  rows: composeProjects, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' }, columns: projectSortCols,
  persistKey: 'compose.projects',
})

const drillSortCols: SortColumn<DrillContainer>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'compose_service', dir: 'asc', compare: (a, b) => (a.compose_service ?? '').localeCompare(b.compose_service ?? '') },
  { key: 'state', dir: 'asc', compare: (a, b) => (a.state ?? '').localeCompare(b.state ?? '') },
  { key: 'image', dir: 'asc', compare: (a, b) => (a.image ?? '').localeCompare(b.image ?? '') },
]
const {
  size: drillSize, page: drillPage, pageCount: drillPageCount, pageRows: drillRows,
  total: drillTotal, sortDir: drillSortDir, toggleSort: toggleDrillSort,
  changeSize: changeDrillSize, gotoPage: gotoDrillPage, isSorted: isDrillSorted,
} = useTableControls<DrillContainer>({
  rows: drillContainers, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' }, columns: drillSortCols,
  persistKey: 'compose.drill',
})
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button>
    </p>

    <RiskBanner level="info"
      text="项目级日志（docker compose logs）未接入面板，请到「终端」页用 docker CLI 查看；项目的启动 / 停止 / 清理已在下方开放。" />

    <!-- ── 面板编排（stack 定义）：不依赖 composeProjects.length ──
         空环境里恰恰最需要这个入口（一个项目都没跑起来时仍要能建第一个）。 -->
    <div class="card flush stack-card">
      <div class="card-toolbar">
        <span class="count">面板编排 · 已定义 {{ stacks.length }} 个</span>
        <span class="spacer" />
        <!-- 导入入口始终可见（即便还没有任何编排）：从别处拿来的 yaml+env 一键部署 -->
        <button v-if="canManage" class="btn-ghost btn-sm" type="button"
          @click="openStackImport()">导入编排</button>
        <!-- 空态时由下方 EmptyState 的 #cta 承担入口，这里不重复出现 -->
        <button v-if="canManage && stacks.length" class="btn-primary btn-sm" type="button"
          @click="openStackEditor()">新建编排</button>
      </div>
      <div v-if="stackTotal" class="t-scroll">
        <table class="fixed">
          <colgroup><col class="w-sname" /><col class="w-snum" /><col /><col class="w-sact" /></colgroup>
          <thead>
            <tr>
              <SortTh label="项目" :active="isStackSorted('project')" :dir="stackSortDir" @sort="toggleStackSort('project')" />
              <SortTh label="服务" :active="isStackSorted('services')" :dir="stackSortDir" @sort="toggleStackSort('services')" />
              <SortTh label="目录" :active="isStackSorted('dir')" :dir="stackSortDir" @sort="toggleStackSort('dir')" />
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in stackRows" :key="s.project">
              <td class="mono ellipsis" :title="s.project">
                {{ s.project }}
                <!-- 外部改过的文件必须显式标出来：面板不会覆盖它，用户得知道为什么改不动 -->
                <span v-if="s.externally_modified" class="ext-mark"
                  title="compose.yaml 已在面板外被修改；面板不会覆盖它">外部修改</span>
              </td>
              <td class="mono dim">{{ s.services.length }}</td>
              <td class="mono dim ellipsis" :title="s.dir">{{ s.dir }}</td>
              <td>
                <button class="btn-ghost btn-sm" type="button" :disabled="!canManage"
                  @click="openStackEditor(s)">编辑</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="还没有编排定义"
        hint="面板可以在这里定义服务并生成 compose.yaml（不支持特权模式与宿主敏感挂载）。已有项目请用 docker compose CLI 管理。">
        <template v-if="canManage" #cta>
          <button class="btn-primary btn-sm" type="button" @click="openStackEditor()">新建编排</button>
        </template>
      </EmptyState>
      <TablePager :total="stackTotal" :page="stackPage" :size="stackSize" :page-count="stackPageCount"
        @update:page="gotoStackPage" @update:size="changeStackSize" />
    </div>

    <!-- ── Compose 项目（docker compose ls --all --format json） ── -->
    <div v-if="loading && !composeProjects.length" class="skeleton shimmer box" />
    <div v-else-if="composeProjects.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ composeProjects.length }} 个项目</span>
        <span class="spacer" />
        <RefreshBtn sm :disabled="!supported" title="立即刷新一次 Compose 项目清单" @click="load" />
      </div>
      <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 项目名弹性吸收余量；状态按组合语义串最长形态取值；
               配置文件路径为宿主机长路径，ellipsis + title 悬停完整值。 -->
          <colgroup>
            <col class="w-cpname" /><col class="w-cpstatus" /><col class="w-cpconf" />
          </colgroup>
          <thead>
            <tr>
              <SortTh label="项目" :active="isProjSorted('name')" :dir="projSortDir" @sort="toggleProjSort('name')" />
              <SortTh label="状态" :active="isProjSorted('status')" :dir="projSortDir" @sort="toggleProjSort('status')" />
              <SortTh label="配置文件" :active="isProjSorted('config_files')" :dir="projSortDir" @sort="toggleProjSort('config_files')" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in projRows" :key="p.name">
              <td class="mono ellipsis" :title="p.name">
                <!-- 项目名可点：展开该项目下的容器（下钻）。
                     按钮而非整行可点——整行点击与文字选择/复制路径会打架。 -->
                <button class="drill-toggle" :aria-expanded="drillProject === p.name"
                  @click="toggleDrill(p.name)">
                  <span class="caret" :class="{ open: drillProject === p.name }">▸</span>
                  {{ p.name }}
                </button>
              </td>
              <td class="mono dim">{{ p.status || '—' }}</td>
              <td class="mono dim ellipsis" :title="p.config_files">{{ p.config_files || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TablePager :total="projTotal" :page="projPage" :size="projSize" :page-count="projPageCount"
        @update:page="gotoProjPage" @update:size="changeProjSize" />

      <!-- 下钻面板：该项目下的容器。只在展开时出现，与上方表格同级（不是浮层）。 -->
      <div v-if="drillProject" class="drill-panel">
        <div class="drill-head">
          <b>{{ drillProject }}</b>
          <span class="count">· {{ drillContainers.length }} 个容器</span>
          <span v-if="drillMismatch.differs" class="drill-warn">
            ⚠ compose 报告 {{ drillMismatch.declared }} 个，实际匹配到 {{ drillMismatch.actual }} 个
            —— 可能有容器刚被删除，或它们运行在其他 Docker 守护进程上
          </span>
          <span class="spacer" />
          <!-- 动作按危险度分级：up/stop/restart 可逆、日常；down 整项目停服，需手输项目名 -->
          <template v-if="canManage">
            <button v-for="a in COMPOSE_ACTIONS" :key="a.key" class="btn-ghost btn-sm"
              :disabled="composeBusy" @click="runComposeAct(a.key)">
              {{ a.label }}
            </button>
            <button class="btn-ghost btn-sm danger" :disabled="composeBusy" @click="askComposeDown">
              停止并清理
            </button>
          </template>
        </div>
        <table class="fixed" v-if="drillTotal">
          <colgroup><col class="w-dname" /><col class="w-dservice" /><col class="w-dstate" /><col /></colgroup>
          <thead>
            <tr>
              <SortTh label="容器" :active="isDrillSorted('name')" :dir="drillSortDir" @sort="toggleDrillSort('name')" />
              <SortTh label="服务" :active="isDrillSorted('compose_service')" :dir="drillSortDir" @sort="toggleDrillSort('compose_service')" />
              <SortTh label="状态" :active="isDrillSorted('state')" :dir="drillSortDir" @sort="toggleDrillSort('state')" />
              <SortTh label="镜像" :active="isDrillSorted('image')" :dir="drillSortDir" @sort="toggleDrillSort('image')" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in drillRows" :key="c.id">
              <td class="mono ellipsis" :title="c.name">{{ c.name }}</td>
              <td class="mono dim">{{ c.compose_service || '—' }}</td>
              <td>
                <span class="badge" :class="containerStateBadge(c.state)">{{ containerStateLabel(c.state) }}</span>
              </td>
              <td class="mono dim ellipsis" :title="c.image">{{ c.image }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="drill-empty">{{ drillEmptyHint(drillMismatch.declared) }}</p>
        <TablePager :total="drillTotal" :page="drillPage" :size="drillSize" :page-count="drillPageCount"
          @update:page="gotoDrillPage" @update:size="changeDrillSize" />
      </div>
    </div>
    <EmptyState v-else-if="!loading" title="暂无 Compose 项目"
      hint="daemon 未返回任何 Compose 项目。项目由 docker compose up 创建（默认取 compose 文件所在目录名）；该清单含已停止项目（--all）。" />

    <!-- Compose「停止并清理（down）」：危险度最高的 compose 动作。
         确认词是**项目名本身**（不是固定的"删除"）——要求用户真的看清在停哪个项目。
         ⚠ 后端永不传 -v：命名卷会保留，本弹窗文案必须如实说明。 -->
    <ConfirmDialog :open="composeDownOpen" danger title="停止并清理 Compose 项目"
      :detail="`将停止并移除项目「${composeDownTarget ?? ''}」的 ${composeDownCount} 个容器与其专用网络。`"
      :confirm-word="composeDownTarget ?? ''" @confirm="doComposeDown"
      @cancel="composeDownOpen = false">
      <p class="down-note">
        <b>命名卷不会被删除</b>（面板不传 <code>-v</code>）——容器里的持久化数据仍保留在卷中，
        重新 up 后会挂回原卷。若确实要连同卷一起删除，请用 <code>docker compose down -v</code> 手动执行。
      </p>
    </ConfirmDialog>

    <StackEditorDialog :open="stackEditOpen" :busy="stackBusy"
      :project="stackEditTarget?.project" :services="stackEditTarget?.services"
      @submit="onStackSubmit" @cancel="stackEditOpen = false" />

    <StackImportDialog :open="stackImportOpen" :busy="stackBusy"
      @submit="onStackSubmit" @cancel="stackImportOpen = false" />
  </div>
</template>

<style scoped>
/* 列宽必须留在本组件（scoped 不跨组件） */
col.w-cpname { width: auto; }
col.w-cpstatus { width: 120px; }
col.w-cpconf { width: 320px; }
col.w-sname { width: 220px; }
col.w-snum { width: 72px; }
col.w-sact { width: 88px; }
col.w-dname { width: 240px; }
col.w-dservice { width: 120px; }
col.w-dstate { width: 96px; }

/* 下钻：项目名可点（按钮而非整行——避免与文字选择/复制路径打架） */
.drill-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.drill-toggle:hover { color: var(--c-primary); }
.caret { display: inline-block; transition: transform .15s ease; color: var(--c-text-mute); }
.caret.open { transform: rotate(90deg); }
.drill-panel {
  margin: 0 12px 12px;
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  background: var(--c-surface-2);
}
.drill-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.drill-head .count { color: var(--c-text-mute); }
.drill-warn { color: var(--c-warn); font-size: var(--fs-12); }
.drill-empty { color: var(--c-text-mute); font-size: var(--fs-13); margin: 0; }

/* down 弹窗里的"卷不会删"说明：用中性色而不是警示色——它讲的是"没你想的那么危险" */
.down-note {
  margin: 0;
  font-size: var(--fs-13);
  color: var(--c-text-dim);
  line-height: 1.6;
}
.down-note code {
  font-family: var(--mono);
  font-size: var(--fs-12);
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-inset);
}

/* ── 面板编排（stack 定义）── */
.stack-card { margin-bottom: 14px; }
/* 外部修改标记：这不是错误（用户有权改），但必须显眼到能解释"为什么保存不了" */
.ext-mark {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: var(--fs-12);
  background: var(--c-warn-bg);
  color: var(--c-warn);
}
.box { height: 260px; }
</style>

<script setup lang="ts">
/**
 * 容器（Docker）——列举 / 镜像 / 创建 / 生命周期 / 安装 / 加组 / 备注。
 *
 * 能力边界的处理是本页的重点：
 * `container.manage` 由后端按 **Docker 守护进程 socket 可达性** 判定，而不是
 * "装了 docker 没有"。所以这里必须区分两种不可用，并给出**可操作的**引导。
 *
 * 关键原则（方案 C 收尾）：诊断不是让用户"复制命令去终端执行"，而是**可视化点点点**——
 * `daemon_unreachable` 下直接给三个按钮（启动 Docker 服务 / 把面板用户加入 docker 组 /
 * 重启面板），后端按面板进程真实身份执行，用户无需手敲任何命令。
 *
 * 已开放：创建容器（`docker create`，默认不启动；禁特权/`/`/etc`/proc/sys/var/run/docker.sock
 * 挂载 + 二次确认词「创建容器」）、拉取镜像。刻意不开放：镜像删除（磁盘回收风险）。
 * 已开放日志查看（`docker logs`，只读最近 N 行，需 container.view）、资源用量快照
 * （`docker stats --no-stream --all`，「资源」Tab，需 container.view；实时感由 3s 轮询近似）、
 * 网络列举（`docker network ls --no-trunc`，「网络」Tab，需 container.view；只读、不自动轮询）、
 * 卷列举（`docker volume ls`，「卷」Tab，需 container.view；只读、不自动轮询）、
 * Compose 项目列举（`docker compose ls --all --format json`，「Compose」Tab，需
 * container.view；只读、不自动轮询）。
 * 暂未实现（非安全刻意排除）：`docker exec`、网络的创建/删除与容器接入/断开、
 * 卷的创建/删除、compose 生命周期写操作（up/down/restart/logs）、stack。
 */
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { useAsync } from '@/composables/useAsync'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, containerStateLabel, containerStateBadge } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import TabBar from '@/components/TabBar.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import CreateContainerDialog from '@/components/CreateContainerDialog.vue'
import StackEditorDialog from '@/components/StackEditorDialog.vue'
import type { StackServicePayload } from '@/composables/stackForm'
import { usePolling } from '@/composables/usePolling'
import { POPULAR_IMAGES, filterPopular, groupByCategory, isPulled } from '@/composables/popularImages'
import PullImageDialog from '@/components/PullImageDialog.vue'
import ContainerLogsDialog from '@/components/ContainerLogsDialog.vue'
import { toast } from '@/composables/useToast'
import { containersOfProject, drillEmptyHint, projectCountMismatch } from '@/composables/composeDrill'

interface Container {
  id: string; name: string; image: string; state: string
  status: string; ports: string; created: string
  /** 对象说明（备注，022）：容器不入库，备注存 container_remarks 引用表，列表端点联查挂载；无则为空串 */
  remark: string
  /** 所属 Compose 项目/服务（后端读 com.docker.compose.* 标签）。非 compose 创建的
   *  容器为 null —— 后端刻意用 null 而非空串，以便区分「没有项目」和「项目名是空」。 */
  compose_project?: string | null
  compose_service?: string | null
}
interface Image {
  id: string; repository: string; tag: string; size: string; created: string
}
/** 创建容器载荷（与 CreateContainerDialog emit 结构一致；未填可选项省略）。 */
interface CreateContainerPayload {
  name: string; image: string; confirm_token: string
  cmd?: string[]; ports?: string[]; env?: string[]; volumes?: string[]
  restart?: string; cpu_quota?: number; mem_limit?: string
}

const auth = useAuthStore()
const tab = ref<'containers' | 'images' | 'stats' | 'networks' | 'volumes' | 'compose'>('containers')
// 顶部 Tab（容器/镜像/资源/网络/卷/Compose）走本地状态，复用通用 TabBar 组件（细分段控件 + 渐变激活），
// 与主机监控等页面外观统一；图标位可选，激活态白底上随 currentColor 变白。
const tabs = [
  { value: 'containers', label: '容器', icon: 'server' },
  { value: 'images', label: '镜像', icon: 'disk' },
  { value: 'stats', label: '资源', icon: 'gauge' },
  { value: 'networks', label: '网络', icon: 'network' },
  { value: 'volumes', label: '卷', icon: 'database' },
  { value: 'compose', label: 'Compose', icon: 'tasks' },
]
const containers = ref<Container[]>([])
const images = ref<Image[]>([])
const { loading, error, run } = useAsync()
/** 按容器 ID 跟踪"正在执行生命周期动作"的行级状态——避免一个动作禁用整页所有按钮
 *  （旧实现用单个 busy，会误伤其它行）。 */
const acting = ref<Set<string>>(new Set())
function isActing(id: string) { return acting.value.has(id) }
function setActing(id: string, on: boolean) {
  const s = new Set(acting.value)
  if (on) s.add(id); else s.delete(id)
  acting.value = s
}
/** 帮助抽屉（A6）：页面头部「?」打开，承载「刻意不提供哪些操作」的完整说明 */
const helpOpen = ref(false)
const delTarget = ref<Container | null>(null)
/** 强制删除开关（确认框内默认不勾选的显式 opt-in）：勾选→后端 docker rm -f */
const delForce = ref(false)

// 日志查看（docker logs，只读快照）：弹窗 + GET，受 container.view 门控。
const logsTarget = ref<Container | null>(null)
const logsOpen = ref(false)

/** 资源用量快照行（docker stats --no-stream --all 的一行）。百分比/用量一律按
 *  docker 原始格式化串展示（如 "1.52%"、"12.5MiB / 2GiB"）——后端不二次解析，
 *  避免把 "0B" / "--" 之类边界形态算错；前端等宽渲染即可。 */
interface StatLine {
  name: string; cpu_perc: string; mem_usage: string; mem_perc: string
  net_io: string; block_io: string; pids: string
}
const stats = ref<StatLine[]>([])
/** 资源 Tab 的自动刷新开关（默认开：用量数据不刷新就失去意义）。 */
const statsAuto = ref(true)

/** Docker 网络行（`docker network ls --no-trunc` 的一行）。driver / scope 为 docker
 *  原始串（bridge / host / overlay / macvlan…；local / swarm / global），与面板其它
 *  docker 直出字段同口径不翻译——二次映射容易把自定义驱动译错；id 为完整 64 位，
 *  展示按惯例截 12 位、完整值走 title 悬停（与容器/镜像表一致）。 */
interface NetworkLine {
  name: string; driver: string; scope: string; id: string
}
const networks = ref<NetworkLine[]>([])

/** Docker 卷行（`docker volume ls --format` 的一行）。driver 为 docker 原始串
 *  （local / nfs / cifs…），同口径不翻译；mountpoint 是卷数据在宿主机上的
 *  实际路径（排查磁盘占用用），长路径 ellipsis + title 悬停。卷无独立 ID，
 *  以名称为键（与 docker 一致）。 */
interface VolumeLine {
  name: string; driver: string; mountpoint: string
}
const volumes = ref<VolumeLine[]>([])

/** Compose 项目行（`docker compose ls --all --format json` 的一行）。status 为
 *  compose 的组合语义串（running(1) / exited(2)…，括号内为容器数），同口径不翻译；
 *  config_files 是 compose 配置文件绝对路径（多 `-f` 时为逗号分隔串），长路径
 *  ellipsis + title 悬停。项目无独立 ID，以名称为键（与 docker compose 一致）。 */
interface ComposeProjectLine {
  name: string; status: string; config_files: string
}
const composeProjects = ref<ComposeProjectLine[]>([])

/** 当前展开下钻的 Compose 项目名（null = 未展开）。点项目行切换。 */
const drillProject = ref<string | null>(null)
/** 下钻面板：该项目下的容器（按容器列表里的 compose_project 标签精确匹配）。 */
const drillContainers = computed(() =>
  drillProject.value ? containersOfProject(containers.value, drillProject.value) : [],
)
/** 当前展开项目的 compose 行（取 status 用于比对容器数）。 */
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

// ── Compose 生命周期动作（写，container.manage）──
// 危险度分级：up/stop/restart 可逆、日常，点了就执行；
// down 会**整项目停服**，需在确认框里手输项目名——不是随手点 OK 能过。
const composeBusy = ref(false)
const composeDownOpen = ref(false)
const composeDownTarget = ref<string | null>(null)
/** down 弹窗里展示的服务数，让用户在停之前看清影响范围 */
const composeDownCount = computed(() => drillContainers.value.length)

// ── 面板编排（stack 定义，写的是面板自己的文件，不依赖 daemon）──
/** 面板管理的编排项目（对应 GET /containers/stacks） */
interface StackRow {
  project: string
  dir: string
  config_file: string
  services: StackServicePayload[]
  /** compose.yaml 被外部改过——此时不允许在面板里覆盖保存 */
  externally_modified: boolean
}
const stacks = ref<StackRow[]>([])
const stackEditOpen = ref(false)
const stackEditTarget = ref<StackRow | null>(null)
const stackBusy = ref(false)

async function loadStacks() {
  if (!supported.value) return
  try {
    stacks.value = await api.get<StackRow[]>(API.containers.stacks())
  } catch {
    // 编排列表失败不应拖垮整个页面：清空即可，页面上仍有容器/镜像等 Tab
    stacks.value = []
  }
}

function openStackEditor(row?: StackRow) {
  stackEditTarget.value = row ?? null
  stackEditOpen.value = true
}

// ── 常用镜像（内置清单，只列镜像名；tag 在拉取弹窗里确认）──
const popularQ = ref('')
/** 传给拉取弹窗的预填值（空串=从"拉取/更新镜像"按钮进入，不预填） */
const pullPreset = ref('')
const popularGroups = computed(() => groupByCategory(filterPopular(POPULAR_IMAGES, popularQ.value)))
/** 已在本地存在的镜像名集合（任一 tag 有即算），用于显示「已拉取」 */
const pulledRefs = computed(() => {
  const set = new Set<string>()
  for (const i of POPULAR_IMAGES) {
    if (isPulled(i.ref, images.value)) set.add(i.ref)
  }
  return set
})

/** 统一拉取入口：列表按钮带预填，工具栏按钮不带 */
function openPull(ref = '') {
  pullPreset.value = ref
  pullOpen.value = true
}

async function onStackSubmit(project: string, services: StackServicePayload[]) {
  stackBusy.value = true
  try {
    await api.put(API.containers.stack(project), { services })
    toast(`已保存编排：${project}`)
    stackEditOpen.value = false
    await loadStacks()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    stackBusy.value = false
  }
}

/** Compose 生命周期动作——**按钮与帮助文案共用这一份**。
 *
 *  ⚠ 为什么要有这个常量：帮助里曾写「仍不提供 up / down / restart」，而按钮
 *  就在同一屏——文案与实现漂移过一次（用户读到"不提供"就不会去点，功能白做）。
 *  动作清单收敛成一处后，增删动作时文案跟着变，从结构上消除这种漂移。
 *  `down` 单独处理：危险色 + 需手输项目名确认，不在这个循环里。 */
const COMPOSE_ACTIONS = [
  { key: 'up' as const, label: '启动 up' },
  { key: 'restart' as const, label: '重启' },
  { key: 'stop' as const, label: '停止' },
]
/** 帮助文案里用的动作枚举（由上面那份派生，不手写第二遍） */
const COMPOSE_ACTIONS_TEXT = COMPOSE_ACTIONS.map((a) => a.label).join(' / ')

async function runComposeAct(action: 'up' | 'stop' | 'restart') {
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

// 创建容器（docker create，默认不启动）：弹窗 + POST，受 container.manage 门控。
// 不放特权开关——后端对 privileged=true 直接拒绝，前端不提供该入口。
const createOpen = ref(false)
const createBusy = ref(false)
async function onCreated(p: CreateContainerPayload) {
  createBusy.value = true
  try {
    const r = await api.post<{ id: string; name: string; state: string }>(API.containers.create(), p)
    toast(`已创建容器 ${r.name}（状态 ${r.state}，请在列表启动）`)
    createOpen.value = false
    if (tab.value !== 'containers') tab.value = 'containers'
    await load()
  } catch (e) { toast(errorText(e), 'err') }
  finally { createBusy.value = false }
}

// 拉取 / 更新镜像（docker pull，写操作）：弹窗 + POST，受 container.manage 门控。
const pullOpen = ref(false)
const pullBusy = ref(false)
async function onPull(image: string) {
  pullBusy.value = true
  try {
    const r = await api.post<{ repository: string; tag: string }>(API.containers.pull(), { image })
    toast(`已拉取镜像 ${r.repository}:${r.tag}（可在「镜像」页查看）`)
    pullOpen.value = false
    if (tab.value !== 'images') tab.value = 'images'
    await load()
  } catch (e) { toast(errorText(e), 'err') }
  finally { pullBusy.value = false }
}

// 安装 Docker：诊断分支下的交互状态
const installOpen = ref(false)
const installBusy = ref(false)
const installTaskId = ref<string | null>(null)
const installError = ref('')

// 诊断分支下的"修复"交互状态（daemon_unreachable：把复制命令换成按钮）
const fixBusy = ref(false)
const fixError = ref('')
const startOpen = ref(false)
const joinOpen = ref(false)
const restartOpen = ref(false)

const supported = computed(() => auth.supported(CAP.CONTAINER_MANAGE))
const canManage = computed(() => auth.enabled(CAP.CONTAINER_MANAGE, 'container.manage'))
/** 日志是读操作：有 container.view 即可查看，不需要 container.manage。 */
const canViewLogs = computed(() => auth.can('container.view'))
/** 不可用原因机器码（来自能力位 reason）。菜单常亮，进入后据此分流展示。 */
const unavailableReason = computed(() => auth.capabilities[CAP.CONTAINER_MANAGE]?.reason ?? undefined)
/** 修复动作需要的权限点（启动/重启服务用 system.manage，加组用 container.manage）。 */
const canService = computed(() => auth.can('service.manage'))
const canJoin = computed(() => auth.can('container.manage'))

/** 把后端的机器码 reason 翻成可执行的建议——"不支持"三个字对用户毫无帮助。 */
const unavailableHint = computed(() => {
  const r = unavailableReason.value
  switch (r) {
    case 'binary_missing':
      return '宿主机未安装 Docker。可点下方"安装 Docker"一键安装（高危操作，需二次确认）；装完仍需把面板运行用户加入 docker 组并重启面板方可管理。'
    case 'daemon_unreachable':
      return '已检测到 docker 命令，但守护进程不可达：面板进程不在 docker 组，或 Docker 服务未运行。点击下方按钮依次操作即可管理容器，无需手敲命令。'
    default:
      return undefined
  }
})

/** 提交一键安装 Docker（经后端任务队列，高危二次确认）。 */
async function doInstall() {
  installBusy.value = true; installError.value = ''; installTaskId.value = null
  try {
    const r = await api.post<{ task_id: string; package: string }>(
      API.containers.install(), { confirm_token: '安装 Docker' })
    installTaskId.value = r.task_id
    toast(`已提交安装任务（${r.package}），可在"任务"页查看进度。装完后请把面板运行用户加入 docker 组并重启面板。`)
  } catch (e) { installError.value = errorText(e) }
  finally { installBusy.value = false; installOpen.value = false }
}

/** 可视化修复①：启动 Docker 服务（复用 services/docker/start）。 */
async function startDocker() {
  startOpen.value = false
  fixBusy.value = true; fixError.value = ''
  try {
    await api.post(API.services.start('docker'), {})
    toast('Docker 服务已启动。若容器页仍提示不可达，请继续：把面板用户加入 docker 组 → 重启面板。')
  } catch (e) { fixError.value = errorText(e) }
  finally { fixBusy.value = false }
}

/** 可视化修复②：把面板运行用户加入 docker 组（后端按面板进程身份执行，非登录用户）。 */
async function joinGroup() {
  joinOpen.value = false
  fixBusy.value = true; fixError.value = ''
  try {
    const r = await api.post<{ user: string }>(API.containers.joinDockerGroup(), {})
    toast(`已将面板用户「${r.user}」加入 docker 组，请点击「重启面板」使新组生效。`)
  } catch (e) { fixError.value = errorText(e) }
  finally { fixBusy.value = false }
}

/** 可视化修复③：重启面板使新组生效（重启期间面板短暂不可用，稍后重新登录）。 */
async function restartPanel() {
  restartOpen.value = false
  fixBusy.value = true; fixError.value = ''
  toast('面板正在重启，稍后请重新登录。')
  try {
    await api.post(API.services.restart('panel'), {})
  } catch (e) {
    // 重启成功时面板进程先断开再起，前端可能收不到 200；以 notice 为准，不报错
    fixError.value = errorText(e)
  }
  finally { fixBusy.value = false }
}

async function load(silent = false) {
  await run(
    async () => {
      if (!supported.value) return
      if (tab.value === 'containers') containers.value = await api.get<Container[]>(API.containers.list())
      else if (tab.value === 'images') images.value = await api.get<Image[]>(API.containers.images())
      else if (tab.value === 'stats') stats.value = await api.get<StatLine[]>(API.containers.stats())
      else if (tab.value === 'networks') networks.value = await api.get<NetworkLine[]>(API.containers.networks())
      else if (tab.value === 'volumes') volumes.value = await api.get<VolumeLine[]>(API.containers.volumes())
      else {
        composeProjects.value = await api.get<ComposeProjectLine[]>(API.containers.composeProjects())
        // 编排定义与"运行中的 compose 项目"是两回事，一起拉：
        // 用户要能同时看到"我定义了什么"和"实际跑着什么"
        await loadStacks()
      }
      if (silent) error.value = '' // 自愈：轮询成功清旧错
    },
    (e) => {
      containers.value = []; images.value = []; stats.value = []; networks.value = []; volumes.value = []; composeProjects.value = []
      if (!silent) error.value = errorText(e)
    },
    { silent },
  )
}

// 容器/镜像 5s 一轮；资源 Tab 3s 一轮（用量变化快）且受「自动刷新」开关控制。
//
// 间隔与启用条件都随当前 Tab 推导：usePolling 的自调度链在**下一次调度**即用新
// 间隔，enabled 每 tick 求值——所以切 Tab / 拨开关都不需要手写重启（旧实现要在
// onMounted、watch(statsAuto)、switchTab 三处各调一次 startPoll，漏一处就变成
// "切了 Tab 还在用旧间隔"或"关了开关仍在轮询"）。
//
// 网络/卷/Compose 三个 Tab 刻意不轮询：它们的清单随显式运维动作变化，没有
// "不刷新就失去意义"的实时字段，需要时手动点工具栏「刷新」。
usePolling({
  fn: () => load(true),
  ms: () => (tab.value === 'stats' ? 3000 : 5000),
  enabled: () => {
    if (!supported.value) return false
    if (tab.value === 'stats') return statsAuto.value
    return tab.value !== 'networks' && tab.value !== 'volumes' && tab.value !== 'compose'
  },
})

onMounted(load)

async function switchTab(t: string) {
  tab.value = t as 'containers' | 'images' | 'stats' | 'networks' | 'volumes' | 'compose'
  await load()
}

/** 生命周期动作的三种入口共用同一实现（后端是 204，无响应体）。
 *  行级 busy：只禁用正在操作的这一行；失败走 toast 而非列表级 .err 红条（动作错误不污染列表错误态）。 */
async function act(c: Container, op: 'start' | 'stop' | 'restart') {
  const labels = { start: '启动', stop: '停止', restart: '重启' } as const
  setActing(c.id, true)
  try {
    await api.post(API.containers[op](c.id), {})
    toast(`已${labels[op]}容器 ${c.name}`)
  } catch (e) { toast(errorText(e), 'err') }
  finally { setActing(c.id, false); await load() }
}

async function doRemove() {
  const c = delTarget.value
  if (!c) return
  const force = delForce.value
  setActing(c.id, true)
  try {
    await api.del(API.containers.remove(c.id, force))
    toast(`已删除容器 ${c.name}`)
  } catch (e) { toast(errorText(e), 'err') }
  finally { setActing(c.id, false); delForce.value = false; delTarget.value = null; await load() }
}

/** 短 ID（12 位，与 `docker ps` 默认展示一致）；完整值放 title 供核对。 */
function shortId(id: string) {
  if (id.startsWith('sha256:')) return id.slice(7, 19)
  return id.length > 12 ? id.slice(0, 12) : id
}
/** 生命周期按钮可用性（边界处理）：按归一化状态精确判定，避免对 paused/restarting/dead
 *  发出后端会拒绝的动作（如 paused 需 docker unpause、restarting 为瞬态）。 */
function startable(c: Container) { return c.state === 'created' || c.state === 'exited' }
function stoppable(c: Container) { return c.state === 'running' }
function restartable(c: Container) { return c.state === 'running' }
function removable(c: Container) {
  // restarting 为瞬态跳过；running/paused 需 force（确认框提供显式 opt-in），其余状态均可删
  return c.state !== 'restarting'
}
/** 删除确认框动态说明：运行/暂停容器提示先停或勾选强制删除 */
const delDetail = computed(() => {
  if (!delTarget.value) return ''
  const c = delTarget.value
  let base = `将删除容器「${c.name}」（镜像 ${c.image}）。\n\n容器内未持久化到卷或宿主目录的数据会一并丢失，且无法恢复。`
  if (c.state === 'running' || c.state === 'paused') {
    base += delForce.value ? '\n\n已勾选强制删除：将先强制停止再移除。' : '\n\n该容器正在运行 / 已暂停，需先停止，或勾选下方「强制删除」。'
  }
  return base
})
function onDelCancel() { delForce.value = false; delTarget.value = null }

// 容器内搜索 + 状态筛选（常见场景：容器多时快速定位；纯前端过滤，不打后端）。
const q = ref('')
const stateFilter = ref<'all' | 'running' | 'exited'>('all')
const filtered = computed(() => {
  let list = containers.value
  if (stateFilter.value !== 'all') {
    list = list.filter((c) => (stateFilter.value === 'running' ? c.state === 'running' : c.state !== 'running'))
  }
  const k = q.value.trim().toLowerCase()
  if (k) {
    list = list.filter((c) =>
      c.name.toLowerCase().includes(k) ||
      c.image.toLowerCase().includes(k) ||
      c.status.toLowerCase().includes(k))
  }
  return list
})

/** 对象说明（备注，022）：内联保存。**按容器名称**存——完整 ID 随重建变化，
 *  名称在重建时通常保留，按 ID 存会让重建后备注变孤儿。失败由 InlineRemark
 *  就地展示，不拖累列表其它行。 */
async function saveRemark(c: Container, v: string) {
  await api.patch(API.containers.remark(c.name), { remark: v })
  c.remark = v
}
</script>

<template>
  <div>
    <div class="tools-row">
      <span class="spacer" />
      <!-- 说明按钮随整簇操作移到右侧（页内标题已移除，见 AppsView 同处注释） -->
      <HelpBtn title="容器说明" aria-label="容器说明" :expanded="helpOpen" @click="helpOpen = true" />
      <RefreshBtn :disabled="!supported" @click="load()" />
    </div>

    <!-- 不可用：诊断/引导视图（菜单已常亮，不置灰）。按 reason 分流展示。 -->
    <div v-if="!supported" class="diag">
      <div class="diag-head">
        <Icon name="docker" :size="22" />
        <h3 v-if="unavailableReason === 'binary_missing'">本机未安装 Docker</h3>
        <h3 v-else-if="unavailableReason === 'daemon_unreachable'">Docker 守护进程不可达</h3>
        <h3 v-else>当前环境不支持容器管理</h3>
      </div>
      <p class="diag-hint">{{ unavailableHint || '该环境暂不满足容器管理的前置条件。' }}</p>

      <!-- binary_missing：提供一键安装（高危，二次确认） -->
      <div v-if="unavailableReason === 'binary_missing'" class="diag-actions">
        <button class="btn-primary" :disabled="installBusy" @click="installOpen = true">
          <Icon name="download" :size="15" /> 安装 Docker
        </button>
        <span v-if="installTaskId" class="ok-note">已提交安装任务（ID：{{ installTaskId }}），可在"任务"页查看进度</span>
      </div>

      <!-- daemon_unreachable：可视化修复（按钮代替"复制命令去执行"） -->
      <div v-else-if="unavailableReason === 'daemon_unreachable'" class="diag-actions">
        <p class="dim">点击下方按钮依次修复即可管理容器：</p>
        <button class="btn-primary" :disabled="fixBusy || !canService"
          :title="canService ? '' : '需要 service.manage 权限'" @click="startOpen = true">
          <Icon name="play" :size="15" /> 启动 Docker 服务
        </button>
        <button class="btn-primary" :disabled="fixBusy || !canJoin"
          :title="canJoin ? '' : '需要 container.manage 权限'" @click="joinOpen = true">
          <Icon name="docker" :size="15" /> 把面板用户加入 docker 组
        </button>
        <button class="btn-ghost" :disabled="fixBusy || !canService" @click="restartOpen = true">
          <Icon name="restart" :size="15" /> 重启面板
        </button>
        <span v-if="!canService && !canJoin" class="dim">
          需要 system.manage 与 container.manage 权限才能执行修复操作。
        </span>
        <p v-if="fixError" class="err">{{ fixError }}</p>
      </div>

      <p v-if="installError" class="err">{{ installError }}</p>
    </div>

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button></p>

      <div class="tabs-wrap">
        <TabBar :tabs="tabs" :model-value="tab" @change="switchTab" />
      </div>

      <!-- ── 面板编排（stack 定义）：独立于下面那条 v-if 链 ──
           ⚠ 必须放在链的起点之前。`v-else-if` 要求紧邻上一个兄弟，插在链中间会
           让 Vue 报「v-else-if has no adjacent v-if」。
           也刻意**不放进**「Compose 项目」卡片里：那张卡片的条件是
           `composeProjects.length`，一个项目都没跑起来时整卡不渲染，
           入口就会跟着消失（空环境里反而建不了第一个）。 -->
      <div v-if="tab === 'compose'" class="card flush stack-card">
        <div class="card-toolbar">
          <span class="count">面板编排 · 已定义 {{ stacks.length }} 个</span>
          <span class="spacer" />
          <!-- 空态时由下方 EmptyState 的 #cta 承担入口，这里不重复出现 -->
          <button v-if="canManage && stacks.length" class="btn-primary btn-sm" type="button"
            @click="openStackEditor()">新建编排</button>
        </div>
        <div v-if="stacks.length" class="t-scroll">
          <table class="fixed">
            <colgroup><col class="w-sname" /><col class="w-snum" /><col /><col class="w-sact" /></colgroup>
            <thead><tr><th>项目</th><th>服务</th><th>目录</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="s in stacks" :key="s.project">
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
      </div>

      <!-- ── 常用镜像（内置清单）：独立于下面那条 v-if 链 ──
           ⚠ 与「面板编排」同理：必须放在链起点之前，且**不能挂在 `images.length`
           条件里**——一台刚装好的机器镜像数为 0，恰恰是最需要这份清单的时候。 -->
      <div v-if="tab === 'images'" class="card flush popular-card">
        <div class="card-toolbar">
          <span class="count">常用镜像 · {{ POPULAR_IMAGES.length }} 个</span>
          <span class="spacer" />
          <input class="filter" v-model="popularQ" type="search"
            placeholder="搜索名称 / 用途" aria-label="搜索常用镜像" />
        </div>

        <div class="popular-body">
          <div v-for="g in popularGroups" :key="g.key" class="pop-group">
            <h4 class="pop-cat">{{ g.label }}</h4>
            <div class="pop-grid">
              <div v-for="i in g.items" :key="i.ref" class="pop-item">
                <div class="pop-main">
                  <div class="pop-title">
                    <b>{{ i.name }}</b>
                    <code class="pop-ref">{{ i.ref }}</code>
                    <span v-if="pulledRefs.has(i.ref)" class="pop-badge">已拉取</span>
                  </div>
                  <span class="pop-desc">{{ i.desc }}</span>
                </div>
                <button class="btn-ghost btn-sm" type="button" :disabled="!canManage"
                  :title="canManage ? `拉取 ${i.ref}（tag 在弹窗里确认）` : '需要 container.manage 权限'"
                  @click="openPull(i.ref)">拉取</button>
              </div>
            </div>
          </div>
          <p v-if="!popularGroups.length" class="pop-empty">没有匹配的常用镜像</p>
        </div>

        <p class="hint-note">
          <b>清单内置在面板里、不联网校验</b>：只给镜像名，不预置版本号（写死的 tag 会过时，
          点下去拉不到反而像面板坏了）。点「拉取」后在弹窗里确认或改写 tag，默认 <code>latest</code>。
        </p>
      </div>

      <!-- 加载骨架放在 Tab 之后：Tab 是导航，须常驻顶部；否则骨架会把 Tab 挤到下方造成跳位 -->
      <div v-if="loading && ((tab === 'containers' && !containers.length) || (tab === 'images' && !images.length) || (tab === 'stats' && !stats.length) || (tab === 'networks' && !networks.length) || (tab === 'volumes' && !volumes.length) || (tab === 'compose' && !composeProjects.length))" class="skeleton shimmer box" />

      <!-- ── 容器 ── -->
      <div class="card flush toolbar-card" v-if="tab === 'containers' && containers.length">
        <div class="card-toolbar">
          <span class="count">共 {{ containers.length }} 个容器<span v-if="filtered.length !== containers.length">（匹配 {{ filtered.length }}）</span></span>
          <span class="spacer" />
          <input class="filter" v-model="q" type="search" placeholder="搜索名称 / 镜像 / 状态" aria-label="搜索容器" />
          <div class="seg" role="group" aria-label="状态筛选">
            <button type="button" :class="{ on: stateFilter === 'all' }" @click="stateFilter = 'all'">全部</button>
            <button type="button" :class="{ on: stateFilter === 'running' }" @click="stateFilter = 'running'">运行</button>
            <button type="button" :class="{ on: stateFilter === 'exited' }" @click="stateFilter = 'exited'">已停止</button>
          </div>
          <button class="btn-primary btn-sm" :disabled="!canManage"
            :title="canManage ? '创建容器（docker create）' : '需要 container.manage 权限'" @click="createOpen = true">
            <Icon name="plus" :size="14" /> 新建容器
          </button>
        </div>
        <div class="t-scroll" v-if="filtered.length">
        <table class="fixed" v-table-nav>
          <colgroup>
            <!-- 列宽（站点表范式）：镜像为唯一弹性列（width:auto）吸收余量；操作列 320px
                 按「4 个带文字按钮」实测（各 67px + 3×6 间距 + 单元格内边距 26px）；
                 备注列（022）固定 170px，ellipsis + title 兜长文。ID 列次要，窄屏隐藏。 -->
            <col class="w-name" /><col class="w-cremark" /><col class="w-img" /><col class="w-state" /><col class="w-ports" /><col class="w-id" /><col class="w-acts" />
          </colgroup>
          <thead>
            <tr><th scope="col">名称</th><th scope="col">备注</th><th scope="col">镜像</th><th scope="col">状态</th><th scope="col">端口</th><th scope="col" class="col-opt">ID</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="c in filtered" :key="c.id">
              <td class="mono ellipsis" :title="c.name">{{ c.name }}</td>
              <td class="remark-cell">
                <InlineRemark :model-value="c.remark" :editable="canManage"
                  :saver="(v) => saveRemark(c, v)" />
              </td>
              <td class="mono dim ellipsis" :title="c.image">{{ c.image }}</td>
              <td>
                <span class="badge" :class="containerStateBadge(c.state)">{{ containerStateLabel(c.state) }}</span>
                <span class="dim status-text ellipsis" :title="c.status">{{ c.status }}</span>
              </td>
              <td class="mono dim ellipsis" :title="c.ports">{{ c.ports || '—' }}</td>
              <td class="mono dim" :title="c.id">{{ shortId(c.id) }}</td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || isActing(c.id) || !startable(c)"
                  :title="startable(c) ? '' : '当前状态不可启动'" @click="act(c, 'start')">
                  <Icon name="play" :size="13" /> 启动
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage || isActing(c.id) || !stoppable(c)"
                  :title="stoppable(c) ? '' : '未在运行'" @click="act(c, 'stop')">
                  <Icon name="stop" :size="13" /> 停止
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage || isActing(c.id) || !restartable(c)"
                  :title="restartable(c) ? '' : '仅运行中可重启'" @click="act(c, 'restart')">
                  <Icon name="restart" :size="13" /> 重启
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canViewLogs || isActing(c.id)"
                  :title="canViewLogs ? '查看容器日志（docker logs，只读最近 N 行）' : '需要 container.view 权限'" @click="logsTarget = c; logsOpen = true">
                  <Icon name="file" :size="13" /> 日志
                </button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage || isActing(c.id) || !removable(c)"
                  :title="removable(c) ? '' : '正在重启中'" @click="delTarget = c; delForce = false">
                  <Icon name="trash" :size="13" /> 删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <EmptyState v-else title="无匹配容器"
          hint="当前搜索 / 筛选条件下没有容器，试试调整关键词或状态筛选。" />
      </div>
      <EmptyState v-else-if="tab === 'containers' && !loading" title="没有容器"
        hint="该 Docker 守护进程上没有任何容器（含已停止）。" />

      <!-- ── 镜像 ── -->
      <!-- tab 护栏必须带：访问过「镜像」Tab 后 images 旧数据仍 truthy，缺护栏会把
           镜像卡渲染在「资源 / 网络」Tab 下，吞掉目标 Tab 的卡片与空态（静默故障）。 -->
      <div class="card flush toolbar-card" v-else-if="tab === 'images' && images.length">
        <div class="card-toolbar">
          <span class="count">共 {{ images.length }} 个镜像</span>
          <span class="spacer" />
          <button class="btn-primary btn-sm" :disabled="!canManage"
            :title="canManage ? '从 registry 拉取 / 更新镜像（docker pull）' : '需要 container.manage 权限'" @click="openPull()">
            <Icon name="download" :size="14" /> 拉取 / 更新镜像
          </button>
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽与上方容器表同范式；前缀独立（w-i*），不与容器表 w-* 混用。
               镜像 ID 列次要，窄屏隐藏（.col-opt）。 -->
          <colgroup>
            <col class="w-irepo" /><col class="w-itag" /><col class="w-iid" /><col class="w-isize" /><col class="w-itime" />
          </colgroup>
          <thead>
            <tr><th>仓库</th><th>标签</th><th class="col-opt">镜像 ID</th><th>体积</th><th>创建时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in images" :key="i.id + i.tag">
              <td class="mono ellipsis" :title="i.repository">{{ i.repository }}</td>
              <td><span class="badge" :class="i.tag === '<none>' ? 'badge-warn' : 'badge-primary'">{{ i.tag }}</span></td>
              <td class="mono dim col-opt" :title="i.id">{{ shortId(i.id) }}</td>
              <td>{{ i.size }}</td>
              <td class="dim">{{ i.created }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <EmptyState v-else-if="tab === 'images' && !loading" title="没有镜像" hint="该 Docker 守护进程上没有任何镜像。" />

      <!-- ── 资源（docker stats --no-stream --all 快照） ── -->
      <div class="card flush toolbar-card" v-else-if="tab === 'stats' && stats.length">
        <div class="card-toolbar">
          <span class="count">共 {{ stats.length }} 个容器</span>
          <span class="spacer" />
          <label class="auto-toggle">
            <input type="checkbox" v-model="statsAuto" />
            <span>自动刷新（3s）</span>
          </label>
          <RefreshBtn sm :disabled="!supported" title="立即刷新一次资源快照" @click="load()" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽范式与上方两表一致；用量列全部等宽右对齐不便读，保持左对齐 + mono。
               名称列弹性吸收余量，其余按内容取固定值。 -->
          <colgroup>
            <col class="w-sname" /><col class="w-scpu" /><col class="w-smem" /><col class="w-smemp" /><col class="w-snet" /><col class="w-sblk" /><col class="w-spid" />
          </colgroup>
          <thead>
            <tr><th>容器</th><th>CPU</th><th>内存（用量 / 上限）</th><th>内存%</th><th>网络 IO</th><th>磁盘 IO</th><th class="num">PIDs</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in stats" :key="s.name">
              <td class="mono ellipsis" :title="s.name">{{ s.name }}</td>
              <td class="mono">{{ s.cpu_perc || '—' }}</td>
              <td class="mono ellipsis" :title="s.mem_usage">{{ s.mem_usage || '—' }}</td>
              <td class="mono">{{ s.mem_perc || '—' }}</td>
              <td class="mono ellipsis" :title="s.net_io">{{ s.net_io || '—' }}</td>
              <td class="mono ellipsis" :title="s.block_io">{{ s.block_io || '—' }}</td>
              <td class="mono th num">{{ s.pids || '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <EmptyState v-else-if="tab === 'stats' && !loading" title="暂无资源数据"
        hint="daemon 尚未返回任何采样行（容器刚启动时会短暂无数据），稍候或点「立即刷新」。" />

      <!-- ── 网络（docker network ls --no-trunc，只读列举） ── -->
      <div class="card flush toolbar-card" v-else-if="tab === 'networks' && networks.length">
        <div class="card-toolbar">
          <span class="count">共 {{ networks.length }} 个网络</span>
          <span class="spacer" />
          <!-- 网络清单变化频率低，不自动轮询；手动刷新即可（与帮助抽屉说明一致） -->
          <RefreshBtn sm :disabled="!supported" title="立即刷新一次网络清单" @click="load()" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽范式与上方各表一致：名称弹性吸收余量；driver / scope 按 docker 原始串
               最长形态（overlay / macvlan、swarm / global）取固定值；ID 列短值展示 +
               title 悬停完整 64 位（与容器/镜像表同口径）。全部 mono 左对齐。 -->
          <colgroup>
            <col class="w-nname" /><col class="w-ndrv" /><col class="w-nscope" /><col class="w-nid" />
          </colgroup>
          <thead>
            <tr><th>名称</th><th>驱动</th><th>作用域</th><th>ID</th></tr>
          </thead>
          <tbody>
            <tr v-for="n in networks" :key="n.id">
              <td class="mono ellipsis" :title="n.name">{{ n.name }}</td>
              <td class="mono dim">{{ n.driver || '—' }}</td>
              <td class="mono dim">{{ n.scope || '—' }}</td>
              <td class="mono dim" :title="n.id">{{ shortId(n.id) }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <EmptyState v-else-if="tab === 'networks' && !loading" title="暂无网络"
        hint="daemon 未返回任何网络（异常：连默认的 bridge 网络都不存在），可点「刷新」重试。" />

      <!-- ── 卷（docker volume ls，只读列举） ── -->
      <div class="card flush toolbar-card" v-else-if="tab === 'volumes' && volumes.length">
        <div class="card-toolbar">
          <span class="count">共 {{ volumes.length }} 个卷</span>
          <span class="spacer" />
          <!-- 卷清单变化频率比网络还低，不自动轮询；手动刷新即可（与帮助抽屉说明一致） -->
          <RefreshBtn sm :disabled="!supported" title="立即刷新一次卷清单" @click="load()" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽范式与上方各表一致：名称弹性吸收余量；驱动按 docker 原始串最长
               形态（local / nfs / cifs）取固定值；挂载路径为宿主机长路径，ellipsis
               截断 + title 悬停完整值。全部 mono 左对齐。 -->
          <colgroup>
            <col class="w-vname" /><col class="w-vdrv" /><col class="w-vmp" />
          </colgroup>
          <thead>
            <tr><th>名称</th><th>驱动</th><th>宿主机挂载路径</th></tr>
          </thead>
          <tbody>
            <tr v-for="v in volumes" :key="v.name">
              <td class="mono ellipsis" :title="v.name">{{ v.name }}</td>
              <td class="mono dim">{{ v.driver || '—' }}</td>
              <td class="mono dim ellipsis" :title="v.mountpoint">{{ v.mountpoint || '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <EmptyState v-else-if="tab === 'volumes' && !loading" title="暂无卷"
        hint="daemon 未返回任何卷。卷随容器创建（docker run -v）或手动 docker volume create 产生。" />

      <!-- ── Compose 项目（docker compose ls --all --format json，只读列举） ── -->
      <div class="card flush toolbar-card" v-else-if="tab === 'compose' && composeProjects.length">
        <div class="card-toolbar">
          <span class="count">共 {{ composeProjects.length }} 个项目</span>
          <span class="spacer" />
          <!-- Compose 项目随 up/down 显式变化，不自动轮询；手动刷新即可（与帮助抽屉说明一致） -->
          <RefreshBtn sm :disabled="!supported" title="立即刷新一次 Compose 项目清单" @click="load()" />
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽范式与上方各表一致：项目名弹性吸收余量；状态按组合语义串最长
                形态（running(10) / restarting(1)）取固定值；配置文件路径为宿主机长
                路径，ellipsis 截断 + title 悬停完整值。全部 mono 左对齐。 -->
          <colgroup>
            <col class="w-cpname" /><col class="w-cpstatus" /><col class="w-cpconf" />
          </colgroup>
          <thead>
            <tr><th>项目</th><th>状态</th><th>配置文件</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in composeProjects" :key="p.name">
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
          <table class="fixed" v-if="drillContainers.length">
            <colgroup><col class="w-dname" /><col class="w-dservice" /><col class="w-dstate" /><col /></colgroup>
            <thead><tr><th>容器</th><th>服务</th><th>状态</th><th>镜像</th></tr></thead>
            <tbody>
              <tr v-for="c in drillContainers" :key="c.id">
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
        </div>
      </div>
      <EmptyState v-else-if="tab === 'compose' && !loading" title="暂无 Compose 项目"
        hint="daemon 未返回任何 Compose 项目。项目由 docker compose up 创建（默认取 compose 文件所在目录名）；该清单含已停止项目（--all）。" />

    </template>

    <!-- 完整说明收进帮助抽屉（A6）：页面流里不再铺长文；「?」在页面头部 -->
    <HelpDrawer :open="helpOpen" title="容器说明" @close="helpOpen = false">
      <p>面板提供容器的<b>列举 / 镜像 / 创建 / 生命周期（启停 / 重启 / 删除）/ 安装 / 加组 / 备注 / 网络列举 / 卷列举 / Compose 项目列举</b>等操作。</p>
      <h4>能力边界</h4>
      <p><b>创建容器已开放（有边界）</b>：走 <code>docker create</code>，默认不启动；不放特权开关、敏感宿主挂载（如 <code>/</code>、<code>docker.sock</code>）被后端拒绝，需手输确认词「创建容器」。等价宿主级代码执行的能力已尽量收敛。</p>
      <p><b>日志查看已开放</b>：每行「日志」按钮查看容器最近 N 行输出（<code>docker logs</code> 只读快照，不带实时跟随——实时跟随会挂死请求，UI 用「自动刷新」轮询近似），需 <code>container.view</code>。</p>
      <p><b>资源用量快照已开放</b>：「资源」Tab 展示每个容器的 CPU / 内存 / 网络 IO / 磁盘 IO / PIDs（<code>docker stats --no-stream</code> 一次性快照，非流式——流式会把请求挂死），默认 3s 自动刷新、可手动关掉或点「立即刷新」，需 <code>container.view</code>。数字是 docker 的原始格式化串，未做二次解析。</p>
      <p><b>拉取镜像已开放</b>：镜像页「拉取 / 更新镜像」按 <code>仓库:标签</code> 从 registry 拉取；失败通常是宿主网络到 registry 不可达（可配 <code>/etc/docker/daemon.json</code> 的 registry-mirrors）。镜像页顶部还有一份<b>常用镜像清单</b>（内置在面板里、<b>不联网校验</b>，只给镜像名不给版本号——写死的 tag 会过时），点「拉取」会预填名字、tag 请在弹窗里确认。<b>仍不提供</b>：删除镜像（磁盘回收风险）。</p>
      <p><b>网络列举已开放</b>：「网络」Tab 展示全部 Docker 网络（<code>docker network ls --no-trunc</code>，只读，需 <code>container.view</code>）。驱动 / 作用域为 docker 原始串（bridge / host / overlay / macvlan；local / swarm / global），未做翻译；ID 列展示短值，悬停可见完整 64 位。网络清单变化频率低，该 Tab <b>不自动轮询</b>，需要时手动点「刷新」。<b>仍不提供</b>：创建 / 删除网络、容器接入 / 断开网络（改网络连通性影响面大，请直接用 docker CLI）。</p>
      <p><b>卷列举已开放</b>：「卷」Tab 展示全部 Docker 卷（<code>docker volume ls</code>，只读，需 <code>container.view</code>）。宿主机挂载路径是卷数据在磁盘上的实际位置（<code>/var/lib/docker/volumes/&lt;名称&gt;/_data</code>），可用于排查磁盘占用。该 Tab 与「网络」一样 <b>不自动轮询</b>，需要时手动点「刷新」。<b>仍不提供</b>：创建 / 删除卷（删除卷 = 其内数据一并丢失，请直接用 docker CLI）。</p>
      <p><b>Compose 项目列举已开放</b>：「Compose」Tab 展示全部 Docker Compose 项目（<code>docker compose ls --all --format json</code>，只读，需 <code>container.view</code>）。状态为 compose 的组合语义串（<code>running(1)</code> / <code>exited(2)</code>，括号内为容器数），未做翻译；配置文件列是该项目的 compose 文件绝对路径（多个 <code>-f</code> 时为逗号分隔）。清单<b>含已停止项目</b>（<code>--all</code>，与「容器」Tab 含已停止容器同口径），与「网络 / 卷」一样 <b>不自动轮询</b>，需要时手动点「刷新」。<b>生命周期写操作已开放</b>：{{ COMPOSE_ACTIONS_TEXT }} / 停止并清理（down，需手输项目名；<b>永不传 <code>-v</code></b>，否则会删除该项目的命名卷）。<b>仍不提供</b>：项目级日志（<code>docker compose logs</code> 未接，请用 CLI）。</p>
      <h4>删除语义</h4>
      <p>删除容器<b>不会</b>自动强制：运行中的容器会拒绝删除，请先「停止」再删除。</p>
    </HelpDrawer>

    <ConfirmDialog :open="!!delTarget" danger title="删除容器"
      :detail="delDetail" confirm-word="删除" @confirm="doRemove" @cancel="onDelCancel">
      <label v-if="delTarget && (delTarget.state === 'running' || delTarget.state === 'paused')" class="force-row">
        <input type="checkbox" v-model="delForce" />
        <span>强制删除（先强制停止运行中的容器，<b>数据不保留</b>）</span>
      </label>
    </ConfirmDialog>

    <!-- Compose「停止并清理（down）」：危险度最高的 compose 动作。
         确认词是**项目名本身**（不是固定的"删除"）——要求用户真的看清在停哪个项目。
         ⚠ 后端永不传 -v：命名卷会保留，本弹窗文案必须如实说明，不能让用户
         以为"清理"=删数据。 -->
    <ConfirmDialog :open="composeDownOpen" danger title="停止并清理 Compose 项目"
      :detail="`将停止并移除项目「${composeDownTarget ?? ''}」的 ${composeDownCount} 个容器与其专用网络。`"
      :confirm-word="composeDownTarget ?? ''" @confirm="doComposeDown"
      @cancel="composeDownOpen = false">
      <p class="down-note">
        <b>命名卷不会被删除</b>（面板不传 <code>-v</code>）——容器里的持久化数据仍保留在卷中，
        重新 up 后会挂回原卷。若确实要连同卷一起删除，请用 <code>docker compose down -v</code> 手动执行。
      </p>
    </ConfirmDialog>

    <ConfirmDialog :open="installOpen" danger title="安装 Docker"
      :detail="'将在宿主机上通过包管理器安装 Docker 引擎。这是高危系统变更；安装完成后仍需把面板运行用户加入 docker 组并重启面板，才能在此管理容器。'"
      confirm-word="安装 Docker" @confirm="doInstall" @cancel="installOpen = false" />

    <ConfirmDialog :open="joinOpen" danger title="把面板用户加入 docker 组"
      :detail="'将把面板运行用户加入 docker 组。docker 组等同 root 级权限（可借 docker 提权到宿主 root），请确认你了解风险。完成后需重启面板使新组生效。'"
      confirm-word="加入 docker 组" @confirm="joinGroup" @cancel="joinOpen = false" />

    <ConfirmDialog :open="restartOpen" danger title="重启面板"
      :detail="'将重启面板服务，使新加入的 docker 组生效。重启期间面板会短暂不可用，稍后需重新登录。'"
      confirm-word="重启面板" @confirm="restartPanel" @cancel="restartOpen = false" />

    <CreateContainerDialog :open="createOpen" :busy="createBusy"
      @confirm="onCreated" @cancel="createOpen = false" />

    <PullImageDialog :open="pullOpen" :busy="pullBusy" :preset="pullPreset"
      @confirm="onPull" @cancel="pullOpen = false" />

    <StackEditorDialog :open="stackEditOpen" :busy="stackBusy"
      :project="stackEditTarget?.project" :services="stackEditTarget?.services"
      @submit="onStackSubmit" @cancel="stackEditOpen = false" />

    <ContainerLogsDialog :open="logsOpen" :container-id="logsTarget?.id ?? ''" :container-name="logsTarget?.name ?? ''"
      @close="logsOpen = false" />
  </div>
</template>

<style scoped>
.ok-note { color: var(--c-ok, #3fb950); font-size: var(--fs-13); margin: 0 0 12px; }
.diag { max-width: 720px; margin: 8px 0 16px; padding: 20px; border: 1px solid var(--c-border); border-radius: var(--radius); background: var(--c-glass); }
.diag-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.diag-head h3 { margin: 0; font-size: var(--fs-16); }
.diag-head :deep(.icon) { color: var(--c-primary); }
.diag-hint { color: var(--c-text-dim); font-size: var(--fs-13); line-height: 1.7; margin: 0 0 14px; }
.diag-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
/* 顶部 Tab（容器/镜像）改用通用 TabBar 组件后的间距保留 */
.tabs-wrap { margin-bottom: 12px; }
.status-text { margin-left: 8px; font-size: var(--fs-12); }
.tip { font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.7; margin-top: 14px; }

/* 显式列宽（与服务/进程页统一范式）：table-layout:fixed + colgroup 宽度，
   长单元名/镜像名/状态文本 ellipsis 截断、完整值走 title 悬停。 */
table.fixed { table-layout: fixed; width: 100%; }
table.fixed th, table.fixed td { overflow: hidden; }
.ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 备注列（022）170px 固定：ellipsis + title 兜长文；镜像改为唯一弹性列吸收余量。
   操作列改固定 320px：原 12% 百分比随表宽缩放（1440 下仅约 141px），4 个带文字
   按钮必然折行——按「各 67px + 3×6 间距 + 单元格内边距 26px = 312」实测取值。 */
col.w-name { width: 14%; }
col.w-cremark { width: 170px; }
col.w-img { width: auto; }
col.w-state { width: 13%; }
col.w-ports { width: 11%; }
col.w-id { width: 9%; }
/* 操作列 392px：现 5 个带文字按钮（启动/停止/重启/日志/删除），按「各 67px + 4×6 间距
   + 单元格内边距 26px = 385」实测取值；窄屏由 .t-scroll 横向滚动兜底。 */
col.w-acts { width: 392px; }
/* 备注单元格：内联编辑组件自带内边距，单元格再收紧一点保持行高紧凑 */
td.remark-cell { padding: 4px 10px; }

/* 资源表列宽：名称弹性吸收余量，其余按 docker stats 输出的最长形态取固定值
   （"内存（用量 / 上限）" 列要容得下 "12.5MiB / 2GiB"，取 170px；网络/磁盘 IO 同理）。
   全部 mono 左对齐——百分比/用量是等人宽字符串，右对齐反而破坏列间对齐参照。 */
col.w-sname { width: auto; }
col.w-scpu { width: 76px; }
col.w-smem { width: 170px; }
col.w-smemp { width: 76px; }
col.w-snet { width: 132px; }
col.w-sblk { width: 132px; }
col.w-spid { width: 72px; }
/* 网络表列宽（docker network ls --no-trunc）：名称弹性吸收余量；driver / scope 按
   docker 原始串最长形态（overlay / macvlan、swarm / global）取固定值；ID 列与镜像表
   同口径（短值 + title 悬停完整 64 位）。全部 mono 左对齐（同源直出字符串）。 */
col.w-nname { width: auto; }
col.w-ndrv { width: 96px; }
col.w-nscope { width: 96px; }
col.w-nid { width: 128px; }
/* 卷表列宽（docker volume ls）：名称弹性吸收余量；驱动按 docker 原始串最长
   形态（local / nfs / cifs）取固定值；挂载路径为宿主机长路径，ellipsis +
   title 悬停完整值。全部 mono 左对齐（同源直出字符串）。 */
col.w-vname { width: auto; }
col.w-vdrv { width: 96px; }
col.w-vmp { width: 320px; }
col.w-cpname { width: auto; }
col.w-cpstatus { width: 120px; }
col.w-cpconf { width: 320px; }

/* ── Compose 下钻 ── */
.drill-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.drill-toggle:hover { color: var(--c-primary); }
.caret { display: inline-block; transition: transform .15s ease; color: var(--c-text-mute); }
.caret.open { transform: rotate(90deg); }
.drill-panel {
  border-top: 1px solid var(--c-border);
  padding: var(--row-py) 16px;
  background: var(--c-surface-2);
}
.drill-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  font-size: var(--fs-13);
}
.drill-head .count { color: var(--c-text-mute); }
/* 数量不一致是高信息量的异常，用警示色而非品牌色（品牌色是"操作"，不是"注意"） */
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
col.w-dname { width: 240px; }
col.w-dservice { width: 120px; }
col.w-dstate { width: 96px; }

/* ── 常用镜像 ── */
.popular-card { margin-bottom: 14px; }
.popular-body { padding: 4px 14px 12px; }
.pop-cat {
  margin: 12px 0 8px;
  font-size: var(--fs-12);
  font-weight: 500;
  color: var(--c-text-mute);
  letter-spacing: .02em;
}
.pop-grid {
  display: grid;
  /* auto-fill + minmax：窄屏自动降列，不必写媒体查询 */
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px;
}
.pop-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-surface-2);
}
.pop-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.pop-title { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.pop-title b { font-size: var(--fs-13); color: var(--c-text); }
.pop-ref { font-family: var(--mono); font-size: var(--fs-12); color: var(--c-text-mute); }
/* 「已拉取」是状态标记，用中性色而非品牌色（品牌色留给操作） */
.pop-badge {
  font-size: var(--fs-12);
  padding: 0 5px;
  border-radius: 4px;
  background: var(--bg-inset);
  color: var(--c-text-dim);
}
.pop-desc { font-size: var(--fs-12); color: var(--c-text-dim); }
.pop-empty { margin: 16px 0; text-align: center; color: var(--c-text-mute); font-size: var(--fs-13); }

/* ── 面板编排（stack 定义）── */
.stack-card { margin-bottom: 14px; }
col.w-sname { width: 220px; }
col.w-snum { width: 72px; }
col.w-sact { width: 88px; }
/* 外部修改标记：这不是错误（用户有权改），但必须显眼到能解释"为什么保存不了" */
.ext-mark {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: var(--fs-12);
  background: var(--c-warn-bg);
  color: var(--c-warn);
}
/* 「自动刷新」开关（资源 Tab 工具栏）：小字号与工具栏其它控件对齐 */
.auto-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-13); color: var(--c-text-dim); cursor: pointer; }
.auto-toggle input { width: 15px; height: 15px; accent-color: var(--c-primary); }

/* 首次加载占位高度（骨架本体走公共 .skeleton.shimmer，见 main.css） */
.box { height: 260px; }
/* 删除确认框内的强制删除开关（嵌在 ConfirmDialog 的 .modal-extra 插槽里） */
.force-row { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; font-size: var(--fs-13); line-height: 1.5; }
.force-row input { margin-top: 2px; width: 15px; height: 15px; accent-color: var(--c-primary); }
.force-row b { color: var(--c-danger, #e5484d); }

/* 容器内搜索框 + 状态分段筛选（容器页工具栏，.card-toolbar 内） */
.filter { width: 220px; max-width: 46vw; height: 31px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: var(--radius-sm, 7px); background: var(--c-input, var(--c-glass)); color: var(--c-text); font-size: var(--fs-13); }
.filter:focus { outline: none; border-color: var(--c-primary); }
.seg { display: inline-flex; border: 1px solid var(--c-border); border-radius: var(--radius-sm, 7px); overflow: hidden; }
.seg button { border: 0; background: transparent; color: var(--c-text-dim); font-size: var(--fs-13); padding: 6px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--c-border); }
.seg button.on { background: var(--c-primary); color: #fff; }
.seg button:not(.on):hover { background: var(--c-hover); }

/* 镜像表列宽（与上方容器表同范式；前缀 w-i* 避免与容器表 w-* 混用）。 */
col.w-irepo { width: auto; }
col.w-itag { width: 110px; }
col.w-iid { width: 120px; }
col.w-isize { width: 90px; }
col.w-itime { width: 185px; }
</style>

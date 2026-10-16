<script setup lang="ts">
/**
 * 容器（Docker）——只读列举 + 生命周期。
 *
 * 能力边界的处理是本页的重点：
 * `container.manage` 由后端按 **Docker 守护进程 socket 可达性** 判定，而不是
 * "装了 docker 没有"。所以这里必须区分两种不可用，并给出**可操作的**引导。
 *
 * 关键原则（方案 C 收尾）：诊断不是让用户"复制命令去终端执行"，而是**可视化点点点**——
 * `daemon_unreachable` 下直接给三个按钮（启动 Docker 服务 / 把面板用户加入 docker 组 /
 * 重启面板），后端按面板进程真实身份执行，用户无需手敲任何命令。
 *
 * 刻意不提供的操作：**创建容器**（`docker run` 等价宿主机任意代码执行，
 * 需独立的镜像白名单与特权/挂载禁用设计）、镜像删除与拉取。页面里明确写出，
 * 避免用户以为是漏做的功能。
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { useAsync } from '@/composables/useAsync'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, containerStateLabel, containerStateBadge } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import TabBar from '@/components/TabBar.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import CreateContainerDialog from '@/components/CreateContainerDialog.vue'
import { toast } from '@/composables/useToast'

interface Container {
  id: string; name: string; image: string; state: string
  status: string; ports: string; created: string
  /** 对象说明（备注，022）：容器不入库，备注存 container_remarks 引用表，列表端点联查挂载；无则为空串 */
  remark: string
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
const tab = ref<'containers' | 'images'>('containers')
// 顶部 Tab（容器/镜像）走本地状态，复用通用 TabBar 组件（细分段控件 + 渐变激活），
// 与主机监控等页面外观统一；图标位可选，激活态白底上随 currentColor 变白。
const tabs = [
  { value: 'containers', label: '容器', icon: 'server' },
  { value: 'images', label: '镜像', icon: 'disk' },
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
      else images.value = await api.get<Image[]>(API.containers.images())
      if (silent) error.value = '' // 自愈：轮询成功清旧错
    },
    (e) => {
      containers.value = []; images.value = []
      if (!silent) error.value = errorText(e)
    },
    { silent },
  )
}

// 自动轮询：5s 拉一次；隐藏标签页时暂停、可见时补一次；卸载清理。
let timer: ReturnType<typeof setInterval> | undefined
let pageVisible = true
function startPoll() {
  stopPoll()
  timer = setInterval(() => { if (pageVisible && supported.value) load(true) }, 5000)
}
function stopPoll() { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
function onVisibility() {
  pageVisible = document.visibilityState === 'visible'
  if (pageVisible && supported.value) load(true)
}
onMounted(() => {
  load()
  if (supported.value) {
    startPoll()
    document.addEventListener('visibilitychange', onVisibility)
  }
})
onUnmounted(() => {
  stopPoll()
  document.removeEventListener('visibilitychange', onVisibility)
})

async function switchTab(t: string) {
  tab.value = t as 'containers' | 'images'
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

      <RiskBanner level="info" title="只读列举 + 创建 / 生命周期操作"
        text="容器为只读列举，支持创建（docker create，默认不启动）/ 启停 / 重启 / 删除。创建不放特权开关、敏感宿主挂载会被后端拒绝（等价宿主级代码执行，已收敛能力边界）。" />

      <div class="tabs-wrap">
        <TabBar :tabs="tabs" :model-value="tab" @change="switchTab" />
      </div>

      <!-- 加载骨架放在 Tab 之后：Tab 是导航，须常驻顶部；否则骨架会把 Tab 挤到下方造成跳位 -->
      <div v-if="loading && ((tab === 'containers' && !containers.length) || (tab === 'images' && !images.length))" class="skeleton box" />

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
      <div class="card flush toolbar-card" v-else-if="images.length">
        <div class="card-toolbar">
          <span class="count">共 {{ images.length }} 个镜像</span>
          <span class="spacer" />
          <span class="dim">镜像为只读列举（删除 / 拉取未开放）</span>
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
      <EmptyState v-else-if="!loading" title="没有镜像" hint="该 Docker 守护进程上没有任何镜像。" />

    </template>

    <!-- 完整说明收进帮助抽屉（A6）：页面流里不再铺长文；「?」在页面头部 -->
    <HelpDrawer :open="helpOpen" title="容器说明" @close="helpOpen = false">
      <p>容器为<b>只读列举 + 生命周期操作</b>（启停 / 重启 / 删除）。</p>
      <h4>能力边界</h4>
      <p><b>创建容器已开放（有边界）</b>：走 <code>docker create</code>，默认不启动；不放特权开关、敏感宿主挂载（如 <code>/</code>、<code>docker.sock</code>）被后端拒绝，需手输确认词「创建容器」。等价宿主级代码执行的能力已尽量收敛。</p>
      <p><b>仍不提供</b>：删除镜像 / 拉取镜像（写入与网络拉取风险，且镜像拉取需可达的 registry）。</p>
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
col.w-acts { width: 320px; }
/* 备注单元格：内联编辑组件自带内边距，单元格再收紧一点保持行高紧凑 */
td.remark-cell { padding: 4px 10px; }

/* 首次加载骨架（scoped，观感与服务/进程页统一；keyframes 独立命名避免全局冲突） */
.skeleton { background: linear-gradient(90deg, var(--c-hover) 25%, var(--c-glass) 37%, var(--c-hover) 63%); background-size: 400% 100%; animation: ct-sk 1.4s ease infinite; border-radius: var(--radius); }
.box { height: 260px; }
@keyframes ct-sk { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
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

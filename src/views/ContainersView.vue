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
 * 已开放：Compose 生命周期写操作（up / stop / restart / down，见 ComposeTab 的确认流）
 * 与面板编排 stack（GET·PUT `/containers/stacks`，见 StackEditorDialog）。
 * **仍不提供**（非安全刻意排除）：`docker exec`、网络的创建/删除与容器接入/断开、
 * 卷的创建/删除、compose 项目级 `logs`（请用 `docker compose logs` CLI）。
 */
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { useAsync } from '@/composables/useAsync'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import TabBar from '@/components/TabBar.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import type { StackServicePayload } from '@/composables/stackForm'
import { toast } from '@/composables/useToast'
import ImagesTab from '@/components/containers/ImagesTab.vue'
import StatsTab from '@/components/containers/StatsTab.vue'
import NetworksTab from '@/components/containers/NetworksTab.vue'
import VolumesTab from '@/components/containers/VolumesTab.vue'
import ContainersTab from '@/components/containers/ContainersTab.vue'
import ComposeTab from '@/components/containers/ComposeTab.vue'
import { COMPOSE_ACTIONS_TEXT } from '@/composables/composeActions'

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
const helpOpen = ref(false)
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


function switchTab(t: string) {
  // 各 Tab 的子组件在 active 变真时自己拉数据（见 components/containers/*Tab.vue）
  tab.value = t as 'containers' | 'images' | 'stats' | 'networks' | 'volumes' | 'compose'
}

</script>

<template>
  <div>
    <div class="tools-row">
      <span class="spacer" />
      <!-- 说明按钮随整簇操作移到右侧（页内标题已移除，见 AppsView 同处注释） -->
      <HelpBtn title="容器说明" aria-label="容器说明" :expanded="helpOpen" @click="helpOpen = true" />
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

      <div class="tabs-wrap">
        <TabBar :tabs="tabs" :model-value="tab" @change="switchTab" />
      </div>



      <!-- ── 镜像 / 资源两个 Tab 已拆成子组件（自持数据与轮询）──
           独立于下面的 v-if 链：它们不以各自的数组长度为条件，0 数据时也要能看到
           「常用镜像」入口与空态说明。 -->
      <ContainersTab v-if="tab === 'containers'" :active="tab === 'containers'"
        :can-manage="canManage" :can-view-logs="canViewLogs" :supported="supported" />
      <ImagesTab v-if="tab === 'images'" :active="tab === 'images'" :can-manage="canManage" />
      <StatsTab v-if="tab === 'stats'" :active="tab === 'stats'" />
      <NetworksTab v-if="tab === 'networks'" :active="tab === 'networks'" />
      <VolumesTab v-if="tab === 'volumes'" :active="tab === 'volumes'" />
      <ComposeTab v-if="tab === 'compose'" :active="tab === 'compose'"
        :can-manage="canManage" :supported="supported" />









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


    <!-- Compose「停止并清理（down）」：危险度最高的 compose 动作。
         确认词是**项目名本身**（不是固定的"删除"）——要求用户真的看清在停哪个项目。
         ⚠ 后端永不传 -v：命名卷会保留，本弹窗文案必须如实说明，不能让用户
         以为"清理"=删数据。 -->

    <ConfirmDialog :open="installOpen" danger title="安装 Docker"
      :detail="'将在宿主机上通过包管理器安装 Docker 引擎。这是高危系统变更；安装完成后仍需把面板运行用户加入 docker 组并重启面板，才能在此管理容器。'"
      confirm-word="安装 Docker" @confirm="doInstall" @cancel="installOpen = false" />

    <ConfirmDialog :open="joinOpen" danger title="把面板用户加入 docker 组"
      :detail="'将把面板运行用户加入 docker 组。docker 组等同 root 级权限（可借 docker 提权到宿主 root），请确认你了解风险。完成后需重启面板使新组生效。'"
      confirm-word="加入 docker 组" @confirm="joinGroup" @cancel="joinOpen = false" />

    <ConfirmDialog :open="restartOpen" danger title="重启面板"
      :detail="'将重启面板服务，使新加入的 docker 组生效。重启期间面板会短暂不可用，稍后需重新登录。'"
      confirm-word="重启面板" @confirm="restartPanel" @cancel="restartOpen = false" />




  </div>
</template>

<style scoped>
/* 拆完 6 个 Tab 后，本视图只剩「页头 + TabBar + 诊断分支 + 帮助抽屉」。
   表格列宽、筛选控件、备注单元格等样式已随模板进入各自子组件
   （scoped 不跨组件——留在父级会静默失效）。 */
.ok-note { color: var(--c-ok, #3fb950); font-size: var(--fs-13); margin: 0 0 12px; }
.diag { max-width: 720px; margin: 8px 0 16px; padding: 20px; border: 1px solid var(--c-border); border-radius: var(--radius); background: var(--c-glass); }
.diag-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.diag-head h3 { margin: 0; font-size: var(--fs-16); }
.diag-head :deep(.icon) { color: var(--c-primary); }
.diag-hint { color: var(--c-text-dim); font-size: var(--fs-13); line-height: 1.7; margin: 0 0 14px; }
.diag-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.diag-actions .dim { font-size: var(--fs-12); }
.tabs-wrap { margin-bottom: 12px; }
</style>

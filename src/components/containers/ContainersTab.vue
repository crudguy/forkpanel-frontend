<script setup lang="ts">
/**
 * 容器 Tab（ContainersView 拆分的最后一块）。
 *
 * 自持：容器列表、5s 轮询、行级 busy、搜索/状态筛选、备注内联保存、
 * 创建/编辑资源限制/删除/日志四个弹窗、增删改后的刷新。
 *
 * 父级不再认识「容器」这个 Tab 的任何状态——它只剩页头、TabBar、诊断分支与帮助抽屉。
 */
import { computed, ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { containerStateBadge, containerStateLabel } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import CreateContainerDialog from '@/components/CreateContainerDialog.vue'
import EditContainerDialog from '@/components/EditContainerDialog.vue'
import ContainerLogsDialog from '@/components/ContainerLogsDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { statusDetail } from '@/components/containers/containerStatus'
import { usePolling } from '@/composables/usePolling'
import { useRowLoad } from '@/composables/useRowLoad'
import { toast } from '@/composables/useToast'

interface Container {
  id: string; name: string; image: string; state: string
  status: string; ports: string; created: string
  /** 对象说明（备注，022）：容器不入库，备注存 container_remarks 引用表，列表端点联查挂载 */
  remark: string
  /** 所属 Compose 项目/服务（后端读 com.docker.compose.* 标签）。非 compose 创建的
   *  容器为 null —— 后端刻意用 null 而非空串，以便区分「没有项目」和「项目名是空」。 */
  compose_project?: string | null
  compose_service?: string | null
}
/** 创建容器载荷（与 CreateContainerDialog emit 结构一致；未填可选项省略）。 */
interface CreateContainerPayload {
  name: string; image: string; confirm_token: string
  cmd?: string[]; ports?: string[]; env?: string[]; volumes?: string[]
  restart?: string; cpu_quota?: number; mem_limit?: string
}

const props = defineProps<{
  active: boolean
  /** container.manage：生命周期动作 / 创建 / 删除 / 备注编辑 */
  canManage: boolean
  /** container.view：日志查看 */
  canViewLogs: boolean
  /** 能力位（daemon 是否可用），刷新按钮的可用性 */
  supported: boolean
}>()

const containers = ref<Container[]>([])
// 状态机与列表策略（失败清列表 / 轮询成功自愈清错）统一走 useRowLoad
const { loading, error, load } = useRowLoad(
  () => api.get<Container[]>(API.containers.list()), containers,
)

watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

// 容器 5s 一轮（状态会因外部 docker CLI 操作变化）；切走即停。
usePolling({ fn: () => load(true), ms: 5000, enabled: () => props.active })

// ── 行级 busy（只禁用正在操作的那一行，不误伤其它行）──
const acting = ref<Set<string>>(new Set())
function isActing(id: string) { return acting.value.has(id) }
function setActing(id: string, on: boolean) {
  const s = new Set(acting.value)
  if (on) s.add(id); else s.delete(id)
  acting.value = s
}

async function act(c: Container, op: 'start' | 'stop' | 'restart') {
  const labels = { start: '启动', stop: '停止', restart: '重启' } as const
  setActing(c.id, true)
  try {
    await api.post(API.containers[op](c.id), {})
    toast(`已${labels[op]}容器 ${c.name}`)
  } catch (e) { toast(errorText(e), 'err') }
  finally { setActing(c.id, false); await load() }
}

// ── 删除 ──
const delTarget = ref<Container | null>(null)
/** 强制删除开关（确认框内默认不勾选的显式 opt-in）：勾选→后端 docker rm -f */
const delForce = ref(false)
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
function onDelCancel() { delForce.value = false; delTarget.value = null }

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

// ── 日志 ──
const logsTarget = ref<Container | null>(null)
const logsOpen = ref(false)

// ── 创建 ──
const createOpen = ref(false)
const createBusy = ref(false)
async function onCreated(p: CreateContainerPayload) {
  createBusy.value = true
  try {
    const r = await api.post<{ id: string; name: string; state: string }>(API.containers.create(), p)
    toast(`已创建容器 ${r.name}（状态 ${r.state}，请在列表启动）`)
    createOpen.value = false
    await load()
  } catch (e) { toast(errorText(e), 'err') }
  finally { createBusy.value = false }
}

// ── 编辑资源限制（docker update）──
//
// 只开 CPU / 内存 / 重启策略——其余属性 create 后固化，Docker 没有命令能改。
// 弹窗自己拉现值（`GET /containers/{id}/limits`），这里只负责提交与刷新。
const editTarget = ref<Container | null>(null)
const editBusy = ref(false)
async function onEditLimits(payload: { cpu_quota?: number; mem_limit?: string; restart?: string }) {
  const c = editTarget.value
  if (!c) return
  editBusy.value = true
  try {
    await api.patch(API.containers.updateLimits(c.id), payload)
    toast(`已更新容器 ${c.name} 的资源限制（未重启容器）`)
    editTarget.value = null
    await load()
  } catch (e) { toast(errorText(e), 'err') }
  finally { editBusy.value = false }
}
function onEditCancel() { editTarget.value = null }

/** 短 ID（12 位，与 `docker ps` 默认展示一致）；完整值放 title 供核对。 */function shortId(id: string) {
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

// ── 搜索 + 状态筛选（纯前端过滤，不打后端）──
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
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button>
    </p>

    <RiskBanner level="info"
      text="进入容器执行命令（docker exec）未接入面板，请到「终端」页用 docker CLI 操作。" />

    <div v-if="loading && !containers.length" class="skeleton shimmer box" />
    <div v-else-if="containers.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ containers.length }} 个容器<span v-if="filtered.length !== containers.length">（匹配 {{ filtered.length }}）</span></span>
        <span class="spacer" />
        <input class="filter" v-model="q" type="search" placeholder="搜索名称 / 镜像 / 状态" aria-label="搜索容器" />
        <div class="seg" role="group" aria-label="状态筛选">
          <button type="button" :class="{ on: stateFilter === 'all' }" @click="stateFilter = 'all'">全部</button>
          <button type="button" :class="{ on: stateFilter === 'running' }" @click="stateFilter = 'running'">运行</button>
          <button type="button" :class="{ on: stateFilter === 'exited' }" @click="stateFilter = 'exited'">已停止</button>
        </div>
        <RefreshBtn sm :disabled="!supported" title="立即刷新一次容器列表" @click="load()" />
        <button class="btn-primary btn-sm" :disabled="!canManage"
          :title="canManage ? '创建容器（docker create）' : '需要 container.manage 权限'" @click="createOpen = true">
          <Icon name="plus" :size="14" /> 新建容器
        </button>
      </div>
      <div class="t-scroll" v-if="filtered.length">
        <table class="fixed" v-table-nav>
          <colgroup>
            <!-- 镜像为唯一弹性列（width:auto）吸收余量；操作列 470px 按六个带文字按钮
                 实测（启动/停止/重启/编辑/日志/删除，各含 13px 图标）；
                 备注列固定 170px，ellipsis + title 兜长文。ID 列次要，窄屏隐藏。 -->
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
                  :saver="(v: string) => saveRemark(c, v)" />
              </td>
              <td class="mono dim ellipsis" :title="c.image">{{ c.image }}</td>
              <!-- 状态单元格：中文徽章（归一化）+ docker 原始串（运行时长 / 退出码）。
                   ⚠ 原始串不是恒显示的：created / dead / removing 下 docker 的 Status
                   就是个与 State 同义的单词（`Created`），与徽章重复，拼起来是
                   「已创建Created」。取舍逻辑在 containerStatus.ts（有单测）。
                   原始串单行 ellipsis：`Restarting (0) 7 seconds ago` 换行会把行高从
                   52 撑到 67，整张表高度随状态抖动；完整值在 title 里。 -->
              <td class="state-cell">
                <span class="badge" :class="containerStateBadge(c.state)" :title="c.status">{{ containerStateLabel(c.state) }}</span>
                <span v-if="statusDetail(c.state, c.status)" class="dim status-text"
                  :title="c.status">{{ statusDetail(c.state, c.status) }}</span>
              </td>
              <td class="mono dim ellipsis" :title="c.ports">{{ c.ports || '—' }}</td>
              <td class="mono dim col-opt" :title="c.id">{{ shortId(c.id) }}</td>
              <td class="nowrap acts">
                <button class="btn-ghost btn-sm" aria-label="启动" :disabled="!canManage || isActing(c.id) || !startable(c)"
                  :title="startable(c) ? '' : '当前状态不可启动'" @click="act(c, 'start')">
                  <Icon name="play" :size="13" /><span class="btn-label">启动</span>
                </button>
                <button class="btn-ghost btn-sm" aria-label="停止" :disabled="!canManage || isActing(c.id) || !stoppable(c)"
                  :title="stoppable(c) ? '' : '未在运行'" @click="act(c, 'stop')">
                  <Icon name="stop" :size="13" /><span class="btn-label">停止</span>
                </button>
                <button class="btn-ghost btn-sm" aria-label="重启" :disabled="!canManage || isActing(c.id) || !restartable(c)"
                  :title="restartable(c) ? '' : '仅运行中可重启'" @click="act(c, 'restart')">
                  <Icon name="restart" :size="13" /><span class="btn-label">重启</span>
                </button>
                <button class="btn-ghost btn-sm" aria-label="编辑" :disabled="!canManage || isActing(c.id)"
                  :title="canManage ? '编辑资源限制（CPU / 内存 / 重启策略；其余属性需重建容器）' : '需要 container.manage 权限'"
                  @click="editTarget = c">
                  <Icon name="edit" :size="13" /><span class="btn-label">编辑</span>
                </button>
                <button class="btn-ghost btn-sm" aria-label="日志" :disabled="!canViewLogs || isActing(c.id)"
                  :title="canViewLogs ? '查看容器日志（docker logs，只读最近 N 行）' : '需要 container.view 权限'"
                  @click="logsTarget = c; logsOpen = true">
                  <Icon name="file" :size="13" /><span class="btn-label">日志</span>
                </button>
                <button class="btn-ghost btn-sm danger" aria-label="删除" :disabled="!canManage || isActing(c.id) || !removable(c)"
                  :title="removable(c) ? '' : '正在重启中'" @click="delTarget = c; delForce = false">
                  <Icon name="trash" :size="13" /><span class="btn-label">删除</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="无匹配容器"
        hint="当前搜索 / 筛选条件下没有容器，试试调整关键词或状态筛选。" />
    </div>
    <EmptyState v-else-if="!loading" title="没有容器"
      hint="该 Docker 守护进程上没有任何容器（含已停止）。" />

    <ConfirmDialog :open="!!delTarget" danger title="删除容器"
      :detail="delDetail" confirm-word="删除" @confirm="doRemove" @cancel="onDelCancel">
      <label v-if="delTarget && (delTarget.state === 'running' || delTarget.state === 'paused')" class="force-row">
        <input type="checkbox" v-model="delForce" />
        <span>强制删除（先强制停止运行中的容器，<b>数据不保留</b>）</span>
      </label>
    </ConfirmDialog>

    <CreateContainerDialog :open="createOpen" :busy="createBusy"
      @confirm="onCreated" @cancel="createOpen = false" />

    <EditContainerDialog :open="!!editTarget" :busy="editBusy"
      :container-id="editTarget?.id ?? ''" :container-name="editTarget?.name ?? ''"
      :container-image="editTarget?.image ?? ''"
      @confirm="onEditLimits" @cancel="onEditCancel" />

    <ContainerLogsDialog :open="logsOpen" :container-id="logsTarget?.id ?? ''" :container-name="logsTarget?.name ?? ''"
      @close="logsOpen = false" />
  </div>
</template>

<style scoped>
/* 列宽必须留在本组件（scoped 不跨组件） */
col.w-name { width: 14%; }
col.w-cremark { width: 170px; }
col.w-img { width: auto; }
col.w-state { width: 13%; }
col.w-ports { width: 11%; }
col.w-id { width: 9%; }
col.w-acts { width: 470px; }
td.remark-cell { padding: var(--row-py) 10px; }
.ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 状态单元格：徽章 + 原始串一行，原始串吃满剩余宽度并 ellipsis。
   td 用 flex 只为「徽章不缩、原始串可缩」；行高仍由表格行决定。 */
td.state-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
td.state-cell > .badge { flex: 0 0 auto; }
.status-text { flex: 1 1 auto; min-width: 0; font-size: var(--fs-12);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 窄列下原始串只剩 40px（1280 视口实测，显示成 `Exi…`），既没信息量又把徽章挤到左边。
   1200 档起只留徽章，完整 status 挂在徽章的 title 上（含运行时长 / 退出码）。
   ≥1401 状态列有 172px，`Exited (0) 6 minutes ago` 能显示大半，仍保留单行 ellipsis。 */
@media (max-width: 1400px) {
  td.state-cell > .status-text { display: none; }
}
/* ── 操作列默认只留图标 ──────────────────────────────────────────────
   六个**带文字**的按钮要 470px，而这张表有 7 列。实测（真机 getBoundingClientRect）：
   表格宽 = 视口 − 280，弹性列（镜像）只剩  0.53 × 表格宽 − 640：
     1440 视口 → 镜像 0px（名称列同时掉到 107px）
     1280 视口 → 镜像 0px
     1600 视口 → 镜像 60px（`hello-world:latest` 要 148px，只显示出 `he...`）
   即镜像名在 1767 以下视口全部读不全 —— 文字态在常见分辨率下没有可用空间。
   故默认图标化（按钮 67→29、列宽 470→230），镜像列回到 1600:230 / 1440:239 / 1280:130。
   ⚠ 可访问名称靠 aria-label（模板里恒给）：按钮 title 是「可操作时为空」的条件
     表达式，图标化后只靠 title 会出现无名按钮。
   ⚠ 超宽屏（≥1767）才恢复文字，那里镜像列还有 ≥148px。 */
col.w-acts { width: 230px; }
.acts .btn-label { display: none; }
.acts .btn-sm { padding: 4px 7px; }
/* 图标化后按钮之间没有任何间距（实测相邻按钮 gap 全为 0）：模板里按钮间的换行空白
   被 Vue 的 whitespace 压缩丢掉了，而 `td` 不是 flex 容器、没有 gap 可用。
   靠相邻兄弟选择器补 6px，不加在 td 上（td 改 flex 会脱离表格布局）。 */
.acts .btn-sm + .btn-sm { margin-left: 6px; }
@media (min-width: 1767px) {
  col.w-acts { width: 470px; }
  .acts .btn-label { display: inline; }
  .acts .btn-sm { padding: 4px 10px; }
}
/* ── 窄屏紧凑档（≤1140）─────────────────────────────────────────────
   图标化之后镜像列在 1200 还有 88px，但再窄就归零：实测 1024 视口
   表格宽 744 = 170(备注) + 230(操作) + 47%(名称/状态/端口/ID)，
   弹性的镜像列拿到 **0px**（表头 `th` 宽 0、scrollWidth 51 被 overflow 裁掉，
   整列连表头都看不见）。800 视口同样为 0。
   这里不隐藏任何一列（备注是用户数据、ID 是对 docker 命令的唯一线索），
   而是把四个定宽/百分比列各让一点：备注 170→140、状态 13→12%、
   端口 11→10%、ID 9→7%，操作列 230→216（按钮内容 174 + 5×6 间距 +
   2×8 内边距 = 210，留 6px 余量）。合计让出 ~66px，1024 下镜像回到 ~66px。
   ⚠ 按钮内容宽度是实测值（6 个 29px 图标按钮），改按钮尺寸时要同步改这里。 */
@media (max-width: 1140px) {
  col.w-cremark { width: 140px; }
  col.w-state { width: 12%; }
  col.w-ports { width: 10%; }
  col.w-id { width: 7%; }
  col.w-acts { width: 216px; }
  .acts { padding-left: 8px; padding-right: 8px; }
  .acts .btn-sm + .btn-sm { margin-left: 4px; }
}
.seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--seg-border); border-radius: var(--seg-radius); background: var(--seg-bg); }
.seg button { border: 0; border-radius: var(--seg-item-radius); background: transparent; color: var(--seg-fg); font-size: var(--fs-13); padding: 6px 12px; cursor: pointer; }
.seg button.on { background: var(--seg-on-bg); color: var(--seg-on-fg); font-weight: 600; }
.seg button:not(.on):hover { background: var(--c-hover); }
.force-row { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; font-size: var(--fs-13); line-height: 1.5; }
.force-row input { margin-top: 2px; width: 15px; height: 15px; accent-color: var(--c-primary); }
.force-row b { color: var(--c-danger); }
.box { height: 260px; }
</style>

<script setup lang="ts">
/**
 * 容器（Docker）——只读列举 + 生命周期。
 *
 * 能力边界的处理是本页的重点：
 * `container.manage` 由后端按 **Docker 守护进程 socket 可达性** 判定，而不是
 * "装了 docker 没有"。所以这里必须区分两种不可用，并给出**可操作的**建议
 * （加入 docker 组 / 启动 daemon），否则用户只会看到一个说不出原因的灰页。
 *
 * 刻意不提供的操作：**创建容器**（`docker run` 等价宿主机任意代码执行，
 * 需独立的镜像白名单与特权/挂载禁用设计）、镜像删除与拉取。页面里明确写出，
 * 避免用户以为是漏做的功能。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'

interface Container {
  id: string; name: string; image: string; state: string
  status: string; ports: string; created: string
}
interface Image {
  id: string; repository: string; tag: string; size: string; created: string
}

const auth = useAuthStore()
const tab = ref<'containers' | 'images'>('containers')
const containers = ref<Container[]>([])
const images = ref<Image[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const delTarget = ref<Container | null>(null)

const supported = computed(() => auth.supported(CAP.CONTAINER_MANAGE))
const canManage = computed(() => auth.enabled(CAP.CONTAINER_MANAGE, 'container.manage'))

/** 把后端的机器码 reason 翻成可执行的建议——"不支持"三个字对用户毫无帮助。 */
const unavailableHint = computed(() => {
  const r = auth.capabilities[CAP.CONTAINER_MANAGE]?.reason
  switch (r) {
    case 'binary_missing':
      return '宿主机未安装 Docker CLI（在 /usr/bin 等标准路径下未找到 docker 可执行文件）。安装 Docker 后重启面板即可。'
    case 'daemon_unreachable':
      return '已检测到 docker 命令，但守护进程不可达：面板进程不在 docker 组，或 Docker 服务未运行。'
        + '排查：① `systemctl start docker` 启动服务；② 执行 `usermod -aG docker <面板运行用户>` 后**重启面板**；'
        + '③ 确认 /var/run/docker.sock 存在且可连。'
    default:
      return undefined
  }
})

async function load() {
  error.value = ''; notice.value = ''
  if (!supported.value) return
  try {
    if (tab.value === 'containers') containers.value = await api.get<Container[]>(API.containers.list())
    else images.value = await api.get<Image[]>(API.containers.images())
  } catch (e) {
    error.value = errorText(e)
    containers.value = []; images.value = []
  }
}
onMounted(load)

async function switchTab(t: 'containers' | 'images') {
  tab.value = t
  await load()
}

/** 生命周期动作的三种入口共用同一实现（后端是 204，无响应体）。 */
async function act(c: Container, op: 'start' | 'stop' | 'restart') {
  busy.value = true; error.value = ''; notice.value = ''
  const labels = { start: '启动', stop: '停止', restart: '重启' } as const
  try {
    await api.post(API.containers[op](c.id), {})
    notice.value = `已${labels[op]}容器 ${c.name}`
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false; await load() }
}

async function doRemove() {
  const c = delTarget.value
  if (!c) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await api.del(API.containers.remove(c.id))
    notice.value = `已删除容器 ${c.name}`
    delTarget.value = null
  } catch (e) { error.value = errorText(e); delTarget.value = null }
  finally { busy.value = false; await load() }
}

/** 状态 → 徽章色调。running 绿；exited/dead 灰/红；过渡态黄。 */
function stateClass(s: string) {
  if (s === 'running') return 'badge-ok'
  if (s === 'restarting' || s === 'paused' || s === 'created') return 'badge-warn'
  return 'badge-danger'
}
/** 短 ID（12 位，与 `docker ps` 默认展示一致）；完整值放 title 供核对。 */
function shortId(id: string) {
  if (id.startsWith('sha256:')) return id.slice(7, 19)
  return id.length > 12 ? id.slice(0, 12) : id
}
function canStart(c: Container) { return c.state !== 'running' }
function canStop(c: Container) { return c.state === 'running' }
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <button class="btn-primary" :disabled="busy || !supported" @click="load">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
    </div>

    <EmptyState v-if="!supported"
      title="当前环境不支持容器管理"
      :hint="unavailableHint"
      :reason="auth.capabilities[CAP.CONTAINER_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="notice" class="ok-note">{{ notice }}</p>

      <div class="tabs">
        <button :class="{ on: tab === 'containers' }" @click="switchTab('containers')">
          <Icon name="server" :size="14" /> 容器
        </button>
        <button :class="{ on: tab === 'images' }" @click="switchTab('images')">
          <Icon name="disk" :size="14" /> 镜像
        </button>
      </div>

      <!-- ── 容器 ── -->
      <div class="card flush" v-if="tab === 'containers' && containers.length">
        <table>
          <thead>
            <tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>ID</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="c in containers" :key="c.id">
              <td class="mono">{{ c.name }}</td>
              <td class="mono dim">{{ c.image }}</td>
              <td>
                <span class="badge" :class="stateClass(c.state)">{{ c.state }}</span>
                <span class="dim status-text">{{ c.status }}</span>
              </td>
              <td class="mono dim">{{ c.ports || '—' }}</td>
              <td class="mono dim" :title="c.id">{{ shortId(c.id) }}</td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy || !canStart(c)"
                  :title="canStart(c) ? '' : '已在运行'" @click="act(c, 'start')">
                  <Icon name="play" :size="13" /> 启动
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy || !canStop(c)"
                  :title="canStop(c) ? '' : '未在运行'" @click="act(c, 'stop')">
                  <Icon name="stop" :size="13" /> 停止
                </button>
                <button class="btn-ghost btn-sm" :disabled="!canManage || busy" @click="act(c, 'restart')">
                  <Icon name="restart" :size="13" /> 重启
                </button>
                <button class="btn-ghost btn-sm danger" :disabled="!canManage || busy" @click="delTarget = c">
                  <Icon name="trash" :size="13" /> 删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else-if="tab === 'containers'" title="没有容器"
        hint="该 Docker 守护进程上没有任何容器（含已停止）。" />

      <!-- ── 镜像 ── -->
      <div class="card flush" v-else-if="images.length">
        <table>
          <thead>
            <tr><th>仓库</th><th>标签</th><th>镜像 ID</th><th>体积</th><th>创建时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in images" :key="i.id + i.tag">
              <td class="mono">{{ i.repository }}</td>
              <td><span class="badge" :class="i.tag === '<none>' ? 'badge-warn' : 'badge-primary'">{{ i.tag }}</span></td>
              <td class="mono dim" :title="i.id">{{ shortId(i.id) }}</td>
              <td>{{ i.size }}</td>
              <td class="dim">{{ i.created }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="没有镜像" hint="该 Docker 守护进程上没有任何镜像。" />

      <p class="tip">
        <b>不提供</b>「创建容器 / 删除镜像 / 拉取镜像」：创建容器等价于在宿主机执行任意代码
        （镜像内容 + 挂载宿主目录 + 特权模式 + 端口暴露），必须配套镜像白名单、禁止特权与宿主挂载、
        资源配额等设计后才能开放。<br />
        删除容器<b>不会</b>自动强制：运行中的容器会拒绝删除，请先「停止」再删除。
      </p>
    </template>

    <ConfirmDialog :open="!!delTarget" danger title="删除容器"
      :detail="delTarget ? `将删除容器「${delTarget.name}」（镜像 ${delTarget.image}）。\n\n容器内未持久化到卷或宿主目录的数据会一并丢失，且无法恢复。运行中的容器需先停止。` : ''"
      confirm-word="删除" @confirm="doRemove" @cancel="delTarget = null" />
  </div>
</template>

<style scoped>
.ok-note { color: var(--c-ok, #3fb950); font-size: 13px; margin: 0 0 12px; }
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button { display: inline-flex; align-items: center; gap: 6px; }
.tabs button.on { border-color: var(--c-primary); color: var(--c-primary); }
.status-text { margin-left: 8px; font-size: 12px; }
.tip { font-size: 12px; color: var(--c-text-dim); line-height: 1.7; margin-top: 14px; }
</style>

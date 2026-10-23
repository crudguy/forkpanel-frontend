<script setup lang="ts">
/**
 * 镜像 Tab（ContainersView 拆分的第一块）。
 *
 * ## 为什么自成一体
 * 原先镜像相关的**一切**都挤在 ContainersView 里：`images` 状态、拉取弹窗、
 * 常用镜像清单、5s 轮询的 `tab === 'images'` 分支、以及三处模板块（常用镜像卡、
 * 镜像表、空态）。六个 Tab 共处一个 script 时，加一个 Tab 要同步改 `load()` 分支、
 * 模板 `v-else-if` 链、轮询 `enabled` 条件三处，漏一处就是静默故障。
 *
 * 现在：**自己加载、自己轮询、自己报错**。父组件只传 `active`（是否当前 Tab）
 * 与 `canManage`（权限位），不再知道镜像的存在。
 *
 * ⚠ 轮询用 `usePolling` 而非手写 interval：隐藏暂停 / 回可见补拉 / 卸载清理
 * 由它统一负责（全站纪律，见 composables/usePolling.ts）。
 */
import { computed, ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import PullImageDialog from '@/components/PullImageDialog.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import { usePolling } from '@/composables/usePolling'
import { POPULAR_IMAGES, filterPopular, groupByCategory, isPulled } from '@/composables/popularImages'
import { toast } from '@/composables/useToast'

interface Image {
  id: string; repository: string; tag: string; size: string; created: string
}

const props = defineProps<{
  /** 是否为当前激活的 Tab（决定要不要轮询） */
  active: boolean
  /** container.manage：拉取是写操作，缺权限时按钮置灰 */
  canManage: boolean
}>()

const images = ref<Image[]>([])
const loading = ref(false)
const error = ref('')

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    images.value = await api.get<Image[]>(API.containers.images())
    if (silent) error.value = '' // 自愈：轮询成功清旧错
  } catch (e) {
    if (!silent) { images.value = []; error.value = errorText(e) }
  } finally {
    if (!silent) loading.value = false
  }
}

// 切到本 Tab 时拉一次（挂载即激活，`immediate` 让首次进入也有数据）
watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

// 镜像 5s 一轮（沿用原间隔）：镜像列表会因外部 docker pull/build 变化
usePolling({ fn: () => load(true), ms: 5000, enabled: () => props.active })

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

// 拉取 / 更新镜像（docker pull，写操作）：弹窗 + POST，受 container.manage 门控。
const pullOpen = ref(false)
const pullBusy = ref(false)
async function onPull(image: string) {
  pullBusy.value = true
  try {
    const r = await api.post<{ repository: string; tag: string }>(API.containers.pull(), { image })
    toast(`已拉取镜像 ${r.repository}:${r.tag}（可在「镜像」页查看）`)
    pullOpen.value = false
    await load()
  } catch (e) { toast(errorText(e), 'err') }
  finally { pullBusy.value = false }
}

/** 短 ID（12 位，与 `docker ps` 默认展示一致）；完整值放 title 供核对。 */
function shortId(id: string) {
  if (id.startsWith('sha256:')) return id.slice(7, 19)
  return id.length > 12 ? id.slice(0, 12) : id
}
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button>
    </p>

    <RiskBanner level="info"
      text="面板只提供镜像的列举与拉取；删除镜像未接入面板（磁盘回收动作，误删后需重新拉取），该操作请到「终端」页用 docker CLI 执行。" />

    <!-- ── 常用镜像（内置清单）：不依赖 images.length —— 一台刚装好的机器镜像数为 0，
         恰恰是最需要这份清单的时候 ── -->
    <div class="card flush popular-card">
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

    <!-- ── 已拉取的镜像 ── -->
    <div v-if="loading && !images.length" class="skeleton shimmer box" />
    <div v-else-if="images.length" class="card flush toolbar-card">
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
          <!-- 列宽与容器表同范式；前缀独立（w-i*）。镜像 ID 列次要，窄屏隐藏。 -->
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

    <PullImageDialog :open="pullOpen" :busy="pullBusy" :preset="pullPreset"
      @confirm="onPull" @cancel="pullOpen = false" />
  </div>
</template>

<style scoped>
/* 列宽必须留在本组件：scoped 的 `col.w-*` 只命中本文件模板里的 <col>，
   搬到父级会静默失效（表宽全变成 auto）。 */
col.w-irepo { width: auto; }
col.w-itag { width: 110px; }
col.w-iid { width: 120px; }
col.w-isize { width: 90px; }
col.w-itime { width: 185px; }

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
.box { height: 260px; }
</style>

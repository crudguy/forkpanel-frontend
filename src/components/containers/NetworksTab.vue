<script setup lang="ts">
/**
 * 网络 Tab（ContainersView 拆分）。
 *
 * 只读列举：`docker network ls --no-trunc`。**刻意不轮询**——网络清单只在
 * `docker network create/rm` / `docker run --network` 时变化，都是显式运维动作，
 * 没有"不刷新就失去意义"的实时字段；工具栏「刷新」即可（与帮助抽屉口径一致）。
 */
import { ref, watch } from 'vue'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
// 驱动列的展示规则（docker 对内置 none 网络输出字面串 `null`，`|| '—'` 兜不住）：
// 判据在 containerStatus.ts 有单测，这里只接线。
import { driverText } from '@/components/containers/containerStatus'
import { useRowLoad } from '@/composables/useRowLoad'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'

/** Docker 网络行（`docker network ls --no-trunc` 的一行）。driver / scope 为 docker
 *  原始串（bridge / host / overlay / macvlan…；local / swarm / global），与面板其它
 *  docker 直出字段同口径不翻译；id 为完整 64 位，展示截 12 位、完整值走 title 悬停。 */
interface NetworkLine {
  name: string; driver: string; scope: string; id: string
}

const props = defineProps<{ active: boolean }>()

const networks = ref<NetworkLine[]>([])
// 状态机与列表策略统一走 useRowLoad（本 Tab 不轮询，但失败清列表的口径一致）
const { loading, error, load } = useRowLoad(
  () => api.get<NetworkLine[]>(API.containers.networks()), networks,
)

watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

// 全站表格约定：分页 + 排序走 useTableControls，页脚用 <TablePager>。
// 默认按名称升序：网络只有一个稳定标识就是名字（bridge / host / none 在前，自定义网络在后）。
const networkSortCols: SortColumn<NetworkLine>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  // 按**展示文本**比较：driver 为字面串 `null` 时表格显示「—」，按原文排会把它塞进 n 段中间
  { key: 'driver', dir: 'asc', compare: (a, b) => driverText(a.driver).localeCompare(driverText(b.driver)) },
  { key: 'scope', dir: 'asc', compare: (a, b) => (a.scope ?? '').localeCompare(b.scope ?? '') },
  { key: 'id', dir: 'asc', compare: (a, b) => (a.id ?? '').localeCompare(b.id ?? '') },
]
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<NetworkLine>({
    rows: networks, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' }, columns: networkSortCols,
    persistKey: 'containers.networks',
  })

/** 短 ID（12 位，与 `docker network ls` 默认展示一致）；完整值放 title 供核对。 */
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
      text="面板只读列举 Docker 网络；创建 / 删除网络、容器接入 / 断开网络未接入面板——这些会改变网络连通性的操作，请到「终端」页用 docker CLI 执行。" />

    <div v-if="loading && !networks.length" class="skeleton shimmer box" />
    <div v-else-if="networks.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ networks.length }} 个网络</span>
        <span class="spacer" />
        <RefreshBtn sm title="立即刷新一次网络清单" @click="load()" />
      </div>
      <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 名称弹性吸收余量；driver / scope 按 docker 原始串最长形态取值；
               ID 列短值 + title 悬停完整 64 位（与容器/镜像表同口径）。 -->
          <colgroup>
            <col class="w-nname" /><col class="w-ndrv" /><col class="w-nscope" /><col class="w-nid" />
          </colgroup>
          <thead>
            <tr>
              <SortTh label="名称" :active="isSorted('name')" :dir="sortDir" @sort="toggleSort('name')" />
              <SortTh label="驱动" :active="isSorted('driver')" :dir="sortDir" @sort="toggleSort('driver')" />
              <SortTh label="作用域" :active="isSorted('scope')" :dir="sortDir" @sort="toggleSort('scope')" />
              <SortTh label="ID" :active="isSorted('id')" :dir="sortDir" @sort="toggleSort('id')" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in pageRows" :key="n.id">
              <td class="mono ellipsis" :title="n.name">{{ n.name }}</td>
              <td class="mono dim">{{ driverText(n.driver) }}</td>
              <td class="mono dim">{{ n.scope || '—' }}</td>
              <td class="mono dim" :title="n.id">{{ shortId(n.id) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
        @update:page="gotoPage" @update:size="changeSize" />
    </div>
    <EmptyState v-else-if="!loading" title="暂无网络"
      hint="daemon 未返回任何网络（异常：连默认的 bridge 网络都不存在），可点「刷新」重试。" />
  </div>
</template>

<style scoped>
/* 列宽必须留在本组件：scoped 的 col 规则不跨组件 */
col.w-nname { width: auto; }
col.w-ndrv { width: 96px; }
col.w-nscope { width: 96px; }
col.w-nid { width: 128px; }
.box { height: 260px; }
</style>

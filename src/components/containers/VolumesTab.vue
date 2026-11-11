<script setup lang="ts">
/**
 * 卷 Tab（ContainersView 拆分）。
 *
 * 只读列举：`docker volume ls`。**刻意不轮询**——卷随容器创建（`docker run -v`）
 * 或手动 `docker volume create` 产生，比网络还罕见，没有实时字段；工具栏「刷新」即可。
 */
import { ref, watch } from 'vue'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { useRowLoad } from '@/composables/useRowLoad'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'

/** Docker 卷行。driver 为 docker 原始串（local / nfs / cifs…），同口径不翻译；
 *  mountpoint 是卷数据在宿主机上的实际路径（排查磁盘占用用）。 */
interface VolumeLine {
  name: string; driver: string; mountpoint: string
}

const props = defineProps<{ active: boolean }>()

const volumes = ref<VolumeLine[]>([])
// 状态机与列表策略统一走 useRowLoad（本 Tab 不轮询，但失败清列表的口径一致）
const { loading, error, load } = useRowLoad(
  () => api.get<VolumeLine[]>(API.containers.volumes()), volumes,
)

watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

// 全站表格约定：分页 + 排序走 useTableControls，页脚用 <TablePager>。
// 默认按名称升序：卷名是唯一稳定标识，也是用户找卷时最先想到的键。
const volumeSortCols: SortColumn<VolumeLine>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'driver', dir: 'asc', compare: (a, b) => (a.driver ?? '').localeCompare(b.driver ?? '') },
  { key: 'mountpoint', dir: 'asc', compare: (a, b) => (a.mountpoint ?? '').localeCompare(b.mountpoint ?? '') },
]
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<VolumeLine>({
    rows: volumes, defaultSize: 100, defaultSort: { key: 'name', dir: 'asc' }, columns: volumeSortCols,
    persistKey: 'containers.volumes',
  })
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button>
    </p>

    <RiskBanner level="info"
      text="面板只读列举 Docker 卷；创建 / 删除卷未接入面板——删除卷会丢失其内全部数据，该操作请到「终端」页用 docker CLI 执行。" />

    <div v-if="loading && !volumes.length" class="skeleton shimmer box" />
    <div v-else-if="volumes.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ volumes.length }} 个卷</span>
        <span class="spacer" />
        <RefreshBtn sm title="立即刷新一次卷清单" @click="load()" />
      </div>
      <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 名称弹性吸收余量；驱动按 docker 原始串最长形态取值；
               挂载路径为宿主机长路径，ellipsis + title 悬停完整值。 -->
          <colgroup>
            <col class="w-vname" /><col class="w-vdrv" /><col class="w-vmp" />
          </colgroup>
          <thead>
            <tr>
              <SortTh label="名称" :active="isSorted('name')" :dir="sortDir" @sort="toggleSort('name')" />
              <SortTh label="驱动" :active="isSorted('driver')" :dir="sortDir" @sort="toggleSort('driver')" />
              <SortTh label="宿主机挂载路径" :active="isSorted('mountpoint')" :dir="sortDir" @sort="toggleSort('mountpoint')" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in pageRows" :key="v.name">
              <td class="mono ellipsis" :title="v.name">{{ v.name }}</td>
              <td class="mono dim">{{ v.driver || '—' }}</td>
              <td class="mono dim ellipsis" :title="v.mountpoint">{{ v.mountpoint || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
        @update:page="gotoPage" @update:size="changeSize" />
    </div>
    <EmptyState v-else-if="!loading" title="暂无卷"
      hint="daemon 未返回任何卷。卷随容器创建（docker run -v）或手动 docker volume create 产生。" />
  </div>
</template>

<style scoped>
col.w-vname { width: auto; }
col.w-vdrv { width: 96px; }
col.w-vmp { width: 320px; }
.box { height: 260px; }
</style>

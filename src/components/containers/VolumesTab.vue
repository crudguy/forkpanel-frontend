<script setup lang="ts">
/**
 * 卷 Tab（ContainersView 拆分）。
 *
 * 只读列举：`docker volume ls`。**刻意不轮询**——卷随容器创建（`docker run -v`）
 * 或手动 `docker volume create` 产生，比网络还罕见，没有实时字段；工具栏「刷新」即可。
 */
import { ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'

/** Docker 卷行。driver 为 docker 原始串（local / nfs / cifs…），同口径不翻译；
 *  mountpoint 是卷数据在宿主机上的实际路径（排查磁盘占用用）。 */
interface VolumeLine {
  name: string; driver: string; mountpoint: string
}

const props = defineProps<{ active: boolean }>()

const volumes = ref<VolumeLine[]>([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  try {
    volumes.value = await api.get<VolumeLine[]>(API.containers.volumes())
    error.value = ''
  } catch (e) {
    volumes.value = []
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}

watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button>
    </p>

    <div v-if="loading && !volumes.length" class="skeleton shimmer box" />
    <div v-else-if="volumes.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ volumes.length }} 个卷</span>
        <span class="spacer" />
        <RefreshBtn sm title="立即刷新一次卷清单" @click="load" />
      </div>
      <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 名称弹性吸收余量；驱动按 docker 原始串最长形态取值；
               挂载路径为宿主机长路径，ellipsis + title 悬停完整值。 -->
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

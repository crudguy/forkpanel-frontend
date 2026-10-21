<script setup lang="ts">
/**
 * 资源 Tab（ContainersView 拆分第二块）。
 *
 * ## 轮询语义（沿用原实现，改成自持）
 * 3s 一轮、受「自动刷新」开关控制——用量数据不刷新就失去意义，但低配机器上
 * 一直开着会有明显开销，所以开关默认开且立刻生效（`enabled` 每 tick 求值，
 * 拨动后下一次调度即按新值走，不需要重启轮询）。
 *
 * ## 为什么数据也在本组件里
 * 原先 `load()` 按 `tab` 分六个分支，每加一个 Tab 就要改一次；拆出来后父组件的
 * `load()` 不再认识 stats，本组件自己在激活时拉、切走即停。
 */
import { ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { usePolling } from '@/composables/usePolling'

/** 资源用量快照行（docker stats --no-stream --all 的一行）。百分比/用量一律按
 *  docker 原始格式化串展示（如 "1.52%"、"12.5MiB / 2GiB"）——后端不二次解析，
 *  避免把 "0B" / "--" 之类边界形态算错；前端等宽渲染即可。 */
interface StatLine {
  name: string; cpu_perc: string; mem_usage: string; mem_perc: string
  net_io: string; block_io: string; pids: string
}

const props = defineProps<{
  /** 是否为当前激活的 Tab（决定要不要轮询） */
  active: boolean
}>()

const stats = ref<StatLine[]>([])
const loading = ref(false)
const error = ref('')
/** 自动刷新开关（默认开：用量数据不刷新就失去意义）。 */
const auto = ref(true)

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    stats.value = await api.get<StatLine[]>(API.containers.stats())
    if (silent) error.value = '' // 自愈：轮询成功清旧错
  } catch (e) {
    if (!silent) { stats.value = []; error.value = errorText(e) }
  } finally {
    if (!silent) loading.value = false
  }
}

// 切到本 Tab 时拉一次（挂载即激活）
watch(() => props.active, (v) => { if (v) void load() }, { immediate: true })

// 3s 一轮；关掉开关或切走即停（enabled 每 tick 求值，拨动无需重启）
usePolling({ fn: () => load(true), ms: 3000, enabled: () => props.active && auto.value })
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">
      {{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load()">重试</button>
    </p>

    <div v-if="loading && !stats.length" class="skeleton shimmer box" />
    <div v-else-if="stats.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ stats.length }} 个容器</span>
        <span class="spacer" />
        <label class="auto-toggle">
          <input type="checkbox" v-model="auto" />
          <span>自动刷新（3s）</span>
        </label>
        <RefreshBtn sm title="立即刷新一次资源快照" @click="load()" />
      </div>
      <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 用量列保持左对齐 + mono（等宽右对齐反而不便读）；名称列弹性吸收余量。 -->
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
    <EmptyState v-else-if="!loading" title="暂无资源数据"
      hint="daemon 尚未返回任何采样行（容器刚启动时会短暂无数据），稍候或点「立即刷新」。" />
  </div>
</template>

<style scoped>
/* 列宽必须留在本组件（scoped 只命中本文件模板里的 <col>） */
col.w-sname { width: auto; }
col.w-scpu { width: 76px; }
col.w-smem { width: 170px; }
col.w-smemp { width: 76px; }
col.w-snet { width: 132px; }
col.w-sblk { width: 132px; }
col.w-spid { width: 72px; }

/* 「自动刷新」开关：小字号与工具栏其它控件对齐 */
.auto-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-13); color: var(--c-text-dim); cursor: pointer; }
.auto-toggle input { width: 15px; height: 15px; accent-color: var(--c-primary); }
.box { height: 260px; }
</style>

<script lang="ts">
/** 指标头数据项。导出给两个监控页做类型标注，避免各自复制一份接口后漂移。 */
export interface MetricItem {
  /** 卡片标识（概览页布局个性化用：cpu/mem/disk/load/net；其余场景可省略） */
  id?: string
  label: string
  /** 已格式化的数值（脚本侧完成 toFixed 等） */
  value: string
  unit?: string
  /** 副行（总量 / 出站速率等）；见 MetricCard 的恒定预留行说明 */
  sub?: string
  icon?: string
  tone?: 'primary' | 'cyan' | 'ok' | 'warn' | 'danger'
  progress?: number
}
</script>

<script setup lang="ts">
/**
 * 指标头（评估报告 A2）：「实时趋势」与「专业快照」两页顶部同款读数条。
 *
 * 为什么需要它：
 * 1. 两页各自维护一份同类卡片，一处改了另一处忘了漂移——收敛成一个组件；
 * 2. 两页读数此前取自**不同时刻**的两个端点（环形缓冲的最新点 vs 打开瞬间的
 *    即时快照），同一时刻两个 CPU 值，看起来像"面板在撒谎"。
 *    现在两页都取**面板统一的采样序列**（`metrics/realtime` 环形缓冲，后端每
 *    2 秒采样一次），并把「采样于 HH:mm:ss」标在卡片下方——口径透明。
 */
import MetricCard from '@/components/MetricCard.vue'
import Icon from '@/components/Icon.vue'

defineProps<{
  items: MetricItem[]
  /** 采样时刻（Unix 秒）。标注出来，避免两页读数被误读为"同一瞬间的两次测量" */
  sampledAt?: number | null
  /** 悬浮说明：数据来源与刷新口径 */
  sourceHint?: string
}>()

/** Unix 秒 → HH:mm:ss（本地时区） */
function hms(ts?: number | null) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
</script>

<template>
  <div class="mh">
    <div class="grid" :class="`cols-${items.length}`">
      <MetricCard v-for="it in items" :key="it.label" v-bind="it" />
    </div>
    <p class="cap" :title="sourceHint">
      <Icon name="clock" :size="12" class="cap-ico" />
      采样于 {{ hms(sampledAt) }}<slot name="extra" />
    </p>
  </div>
</template>

<style scoped>
.mh { display: flex; flex-direction: column; }
.cap {
  margin: 8px 2px 0; align-self: flex-end;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--fs-12); color: var(--c-text-mute);
}
.cap-ico { flex: none; }
</style>

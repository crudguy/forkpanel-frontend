<script setup lang="ts">
/**
 * 指标卡骨架：形状与 MetricCard 完全一致（图标+标签头 / 大数值 / 副行 / 进度条），
 * 仅用公共 `.skeleton` 脉冲占位。
 *
 * 为什么单独抽：首屏此前用 `v-for i in 5` + 写死 `height:96px` 的方块当骨架（见
 * DashboardView 旧实现），与实际 MetricCard 的高度/内部分栏对不上——数据到达瞬间
 * 整块跳动、且与各卡基线不齐，看起来像"刷新了两下"。这里复用真实卡片的栅格与间距，
 * 只把内容换成占位条，加载完成无缝替换、零跳动。
 *
 * `progress` 透传：MetricCard 仅在有 `progress` 时渲染进度条，骨架同步才不会有"加载时
 * 少一条、到达后多一条"的高度差（cpu/mem/disk 有、load/net 无）。
 */
defineProps<{ progress?: boolean }>()
</script>

<template>
  <div class="card stat" aria-hidden="true">
    <div class="head">
      <span class="ico skeleton" />
      <span class="sk-label skeleton" />
    </div>
    <div class="val"><span class="sk-num skeleton" /></div>
    <div class="sub"><span class="sk-sub skeleton" /></div>
    <div v-if="progress" class="progress"><i class="skeleton sk-bar" /></div>
  </div>
</template>

<style scoped>
/* 与 MetricCard 同栅格、同间距：替换时零跳动 */
.stat { display: flex; flex-direction: column; gap: 11px; }
.head { display: flex; align-items: center; gap: 9px; }
.ico { width: 30px; height: 30px; border-radius: 9px; flex: none; }
.sk-label { height: 12px; width: 44%; border-radius: 6px; }
.val { display: flex; align-items: baseline; gap: 5px; }
.sk-num { height: 26px; width: 56%; border-radius: 6px; }
.sub { min-height: 15px; }
.sk-sub { display: inline-block; height: 12px; width: 72%; border-radius: 6px; }
.progress { height: 6px; }
.sk-bar { display: block; height: 100%; border-radius: 999px; }
</style>

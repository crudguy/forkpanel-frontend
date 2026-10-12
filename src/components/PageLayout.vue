<script setup lang="ts">
/**
 * 页面根容器（评估报告 B3）。
 *
 * 为什么需要它：审计发现 27 个视图里有 5 个根节点仍是裸 <div>
 * （进程管理 / 服务 / 文件 / 任务中心 / 专业快照），而其余页面早已统一用
 * `.page-head` + `.card` 范式。根节点不统一，既无法在 CI 做"每个 view 根必须是
 * PageLayout"的静态检查，也让"页面 = 页头 + 一个 Panel 容器"的约定悬空。
 *
 * 设计约束：
 * - 本组件只做**语义根 + 最小布局**，绝不重复 .content 已有的 22px 内边距
 *   （内边距由 layouts/MainLayout.vue 的 .content 提供），否则会双重内边距把内容挤窄。
 * - 页面标题来自 route.meta.title（前端约定：顶栏标题单一事实源），所以本组件
 *   不再渲染标题，避免与页面内 .page-head 的 h2 重复。
 * - 子内容里的 .page-head / .card / EmptyState 等保持原样，本组件只是把它们
 *   包进一个可识别的根，为后续统一滚动容器、骨架、错误边界留扩展点。
 */
</script>

<template>
  <div class="page-root">
    <slot />
  </div>
</template>

<style scoped>
.page-root {
  /* 占满 .content 的可视高度，便于内部表格/列表做粘性表头与独立滚动 */
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
</style>

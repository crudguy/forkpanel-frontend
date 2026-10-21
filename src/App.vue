<script setup lang="ts">
/**
 * 根组件：路由出口 + **外层错误边界**。
 *
 * 布局壳（MainLayout）是懒加载的，它自己崩掉时内层边界（在 MainLayout 内部）
 * 根本来不及渲染——所以这里必须再兜一层，至少保证还能"重新加载页面"。
 */
import ErrorBoundary from '@/components/ErrorBoundary.vue'
</script>

<template>
  <ErrorBoundary title="控制台布局出错">
    <RouterView />
  </ErrorBoundary>
</template>

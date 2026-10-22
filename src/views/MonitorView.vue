<script setup lang="ts">
/**
 * 主机监控容器：合并原「主机监控 / 专业监控 / 进程」三个菜单为一个入口。
 *
 * - Tab 用**子路由**承载（/system、/system/pro、/system/procs）：可深链、可刷新、
 *   浏览器前进后退天然可用，页面标题也随子路由 meta.title 变化。
 * - 三个子视图组件（SystemView/ProfessionalView/ProcessesView）零改动复用；
 *   旧路由 /professional、/processes 在路由表里重定向，老链接不断。
 * - 高亮用 route.path 精确比对，不用 router-link-active（'/' 概览项会是所有路径的前缀）。
 */
import TabBar from '@/components/TabBar.vue'

const tabs = [
  { to: '/system', label: '实时趋势' },
  { to: '/system/pro', label: '专业快照' },
  { to: '/system/procs', label: '进程管理' },
  { to: '/system/dirs', label: '目录与位置' },
]
</script>

<template>
  <div class="monitor">
    <TabBar :tabs="tabs" />
    <RouterView />
  </div>
</template>

<style scoped>
.monitor { display: flex; flex-direction: column; gap: 16px; }
</style>

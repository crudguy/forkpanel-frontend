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
import { useRoute } from 'vue-router'

const route = useRoute()
const tabs = [
  { to: '/system', label: '实时趋势' },
  { to: '/system/pro', label: '专业快照' },
  { to: '/system/procs', label: '进程管理' },
]
</script>

<template>
  <div class="monitor">
    <div class="tabs" role="tablist" aria-label="监控视图切换">
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab"
        :class="{ on: route.path === t.to }" role="tab" :aria-selected="route.path === t.to">
        {{ t.label }}
      </RouterLink>
    </div>
    <RouterView />
  </div>
</template>

<style scoped>
.monitor { display: flex; flex-direction: column; gap: 16px; }
.tabs { display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
        border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-surface-2); }
.tab { padding: 7px 16px; border-radius: 7px; font-size: 13.5px; color: var(--c-text-dim);
       text-decoration: none; transition: color .15s ease, background .15s ease; }
.tab:hover { color: var(--c-text); }
.tab.on { background: var(--gradient); color: #fff; font-weight: 500; }
</style>

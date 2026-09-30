<script setup lang="ts">
/**
 * 通用 Tab 条：承载同一功能域下的多个子路由（如主机监控的 实时趋势/专业快照/进程管理）。
 *
 * - 激活态按 route.path **精确**比对，不用 router-link-active：概览 '/' 是所有路径的前缀，
 *   非精确匹配会让它在任意页面都亮起。
 * - 只负责切换，内容由父级 <RouterView /> 渲染；Tab 是否出现由父级按权限点决定，
 *   这样"哪些 Tab 可见"的规则集中在各容器里，不与路由表漂移。
 */
import { useRoute } from 'vue-router'

defineProps<{ tabs: { to: string; label: string }[] }>()
const route = useRoute()
</script>

<template>
  <div class="tabs" role="tablist">
    <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab"
      :class="{ on: route.path === t.to }" role="tab" :aria-selected="route.path === t.to">
      {{ t.label }}
    </RouterLink>
  </div>
</template>

<style scoped>
.tabs { display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
        border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-surface-2); }
.tab { padding: 7px 16px; border-radius: 7px; font-size: 13.5px; color: var(--c-text-dim);
       text-decoration: none; transition: color .15s ease, background .15s ease; }
.tab:hover { color: var(--c-text); }
.tab.on { background: var(--gradient); color: #fff; font-weight: 500; }
</style>

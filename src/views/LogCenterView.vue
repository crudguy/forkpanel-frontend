<script setup lang="ts">
/**
 * 日志中心容器：合并原「日志 / 审计日志」两个菜单为一个入口。
 *
 * - Tab 用**子路由**承载（/logs、/logs/audit）：可深链、可刷新、标题随 meta.title 变化；
 *   旧路由 /audit 在路由表重定向，老链接不断。
 * - 子视图（LogsView/AuditView）零改动复用。
 * - 审计 Tab 按**权限点** audit.view 单独控制可见性（判定口径与侧边栏同一套
 *   whyDisabled，避免两处规则漂移）；无权限者不会看到该 Tab。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'

const route = useRoute()
const auth = useAuthStore()

const tabs = computed(() => {
  const list = [{ to: '/logs', label: '系统日志' }]
  // whyDisabled 返回 null 表示当前账号可用
  if (auth.whyDisabled(CAP.METRICS_READ, 'audit.view') === null) {
    list.push({ to: '/logs/audit', label: '审计日志' })
  }
  return list
})
</script>

<template>
  <div class="log-center">
    <div class="tabs" role="tablist" aria-label="日志视图切换">
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab"
        :class="{ on: route.path === t.to }" role="tab" :aria-selected="route.path === t.to">
        {{ t.label }}
      </RouterLink>
    </div>
    <RouterView />
  </div>
</template>

<style scoped>
.log-center { display: flex; flex-direction: column; gap: 16px; }
.tabs { display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
        border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-surface-2); }
.tab { padding: 7px 16px; border-radius: 7px; font-size: 13.5px; color: var(--c-text-dim);
       text-decoration: none; transition: color .15s ease, background .15s ease; }
.tab:hover { color: var(--c-text); }
.tab.on { background: var(--gradient); color: #fff; font-weight: 500; }
</style>

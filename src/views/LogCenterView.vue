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
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import TabBar from '@/components/TabBar.vue'

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
    <TabBar :tabs="tabs" />
    <RouterView />
  </div>
</template>

<style scoped>
.log-center { display: flex; flex-direction: column; gap: 16px; }
</style>

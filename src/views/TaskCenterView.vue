<script setup lang="ts">
/**
 * 任务容器：合并原「计划任务 / 任务中心」两个菜单为一个入口。
 *
 * - 两者同域（后台任务）且命名相近易混：「计划任务」是 cron 配置，「任务中心」是
 *   异步执行记录（备份/恢复等任务的进度与日志）。合并后语义一次讲清。
 * - Tab 子路由：/cron（计划任务，默认落地）、/cron/tasks（任务中心）；旧路由
 *   /tasks 重定向，老链接不断。
 * - 两个 Tab 分别按权限点独立判定可见性（cron.view / task.view），口径同侧边栏
 *   whyDisabled，避免"能看到入口却打不开"。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import TabBar from '@/components/TabBar.vue'

const auth = useAuthStore()

const tabs = computed(() => {
  const list: { to: string; label: string }[] = []
  // whyDisabled 返回 null 表示当前账号可用
  if (auth.whyDisabled(CAP.SCHEDULER_MANAGE, 'cron.view') === null) {
    list.push({ to: '/cron', label: '计划任务' })
  }
  if (auth.whyDisabled(CAP.METRICS_READ, 'task.view') === null) {
    list.push({ to: '/cron/tasks', label: '任务中心' })
  }
  return list
})
</script>

<template>
  <div class="task-center">
    <TabBar :tabs="tabs" />
    <RouterView />
  </div>
</template>

<style scoped>
.task-center { display: flex; flex-direction: column; gap: 16px; }
</style>

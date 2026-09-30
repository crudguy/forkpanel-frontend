<script setup lang="ts">
/**
 * 安全容器：合并原「防火墙 / 安全中心」两个菜单为一个入口。
 *
 * - Tab 子路由：**防火墙规则** /firewall（高频，默认落地）、**安全基线**
 *   /firewall/baseline（基线检查 + 活跃会话 + MFA）；旧路由 /security 重定向，老链接不断。
 * - 安全基线 Tab 按权限点 security.manage 控制可见性（口径同侧边栏 whyDisabled），
 *   只读账号看不到该 Tab。
 * - FirewallView / SecurityView 两个子视图零改动复用。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import TabBar from '@/components/TabBar.vue'

const auth = useAuthStore()

const tabs = computed(() => {
  const list = [{ to: '/firewall', label: '防火墙规则' }]
  // whyDisabled 返回 null 表示当前账号可用
  if (auth.whyDisabled(CAP.FIREWALL_MANAGE, 'security.manage') === null) {
    list.push({ to: '/firewall/baseline', label: '安全基线' })
  }
  return list
})
</script>

<template>
  <div class="sec-center">
    <TabBar :tabs="tabs" />
    <RouterView />
  </div>
</template>

<style scoped>
.sec-center { display: flex; flex-direction: column; gap: 16px; }
</style>

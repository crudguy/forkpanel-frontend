<script setup lang="ts">
/**
 * 侧栏菜单。
 *
 * ⚠️ 核心纪律：可见性完全由后端能力矩阵 + RBAC 权限点决定，
 * **禁止**出现 isLinux / navigator.platform / target_os 之类的平台判断。
 * 这是"避免硬编码 Linux 假设"在前端的对应约束（设计方案 §0.3.4）。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { CAP, type CapabilityMap } from '@/api/types'

interface Item {
  to: string
  label: string
  cap: string   // 能力位
  perm: string  // RBAC 权限点
}

const auth = useAuthStore()

const items = computed<Item[]>(() => [
  { to: '/', label: '仪表盘', cap: CAP.METRICS_READ, perm: 'system.view' },
  { to: '/system', label: '系统监控', cap: CAP.METRICS_READ, perm: 'system.view' },
  { to: '/services', label: '软件与服务', cap: CAP.SERVICE_MANAGE, perm: 'service.view' },
  { to: '/sites', label: '网站与 SSL', cap: CAP.WEBSERVER_MANAGE, perm: 'site.view' },
  { to: '/files', label: '文件', cap: CAP.METRICS_READ, perm: 'file.read' },
  { to: '/databases', label: '数据库', cap: CAP.DBMS_MANAGE, perm: 'db.view' },
  { to: '/firewall', label: '防火墙与安全', cap: CAP.FIREWALL_MANAGE, perm: 'firewall.view' },
  { to: '/cron', label: '计划任务', cap: CAP.SCHEDULER_MANAGE, perm: 'cron.view' },
  { to: '/logs', label: '日志', cap: CAP.LOGS_READ, perm: 'log.view' },
  { to: '/settings', label: '设置', cap: CAP.METRICS_READ, perm: 'settings.manage' },
])

function disabledReason(item: Item): string | null {
  return auth.whyDisabled(item.cap, item.perm)
}

const caps = computed<CapabilityMap>(() => auth.capabilities)
</script>

<template>
  <nav class="side">
    <div class="brand">Panel</div>
    <ul>
      <li v-for="it in items" :key="it.to">
        <RouterLink
          :to="it.to"
          :class="{ disabled: disabledReason(it) }"
          :title="disabledReason(it) ?? ''"
          :tabindex="disabledReason(it) ? -1 : 0"
        >
          {{ it.label }}
        </RouterLink>
      </li>
    </ul>
    <div v-if="auth.platform" class="meta">
      {{ auth.platform.os }} · {{ auth.platform.arch }}
      <span v-if="auth.platform.distro"> · {{ auth.platform.distro }}</span>
    </div>
  </nav>
</template>

<style scoped>
.side { width: 200px; border-right: 1px solid var(--c-border); padding: 16px 0; display: flex;
        flex-direction: column; gap: 8px; }
.brand { font-weight: 600; padding: 0 16px 8px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
li a { display: block; padding: 8px 16px; color: var(--c-text); text-decoration: none; font-size: 14px; }
li a:hover { background: var(--c-hover); }
li a.router-link-exact-active { background: var(--c-active); font-weight: 500; }
li a.disabled { color: var(--c-text-dim); opacity: .5; pointer-events: none; }
.meta { margin-top: auto; padding: 8px 16px; font-size: 11px; color: var(--c-text-dim); }
</style>

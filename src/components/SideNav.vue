<script setup lang="ts">
/**
 * 侧边导航。
 *
 * ⚠️ 纪律（同前）：菜单可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，
 * **禁止**出现 isLinux / navigator.platform / target_os 之类的平台判断。
 * 新模块的 cap 复用既有常量兜底（如明细类用 METRICS_READ），仅 perm 区分可见性。
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import Icon from '@/components/Icon.vue'

interface Item { to: string; label: string; icon: string; cap: string; perm: string }

const auth = useAuthStore()
const collapsed = ref(false)

// 分组结构：参考主流面板（概览 / 主机 / 应用 / 安全 / 运维 / 系统）
const groups = computed(() => [
  { title: '概览', items: [
    { to: '/', label: '概览', icon: 'dashboard', cap: CAP.METRICS_READ, perm: 'system.view' },
  ] },
  { title: '主机', items: [
    { to: '/system', label: '主机监控', icon: 'cpu', cap: CAP.METRICS_READ, perm: 'system.view' },
    { to: '/professional', label: '专业监控', icon: 'chart', cap: CAP.METRICS_READ, perm: 'system.view' },
    { to: '/processes', label: '进程', icon: 'process', cap: CAP.METRICS_READ, perm: 'system.view' },
  ] },
  { title: '应用', items: [
    { to: '/services', label: '软件与服务', icon: 'server', cap: CAP.SERVICE_MANAGE, perm: 'service.view' },
    { to: '/sites', label: '网站与 SSL', icon: 'globe', cap: CAP.WEBSERVER_MANAGE, perm: 'site.view' },
    { to: '/databases', label: '数据库', icon: 'database', cap: CAP.DBMS_MANAGE, perm: 'db.view' },
    { to: '/containers', label: '容器', icon: 'server', cap: CAP.CONTAINER_MANAGE, perm: 'container.view' },
    { to: '/backups', label: '备份', icon: 'disk', cap: CAP.BACKUP_MANAGE, perm: 'backup.view' },
    { to: '/files', label: '文件', icon: 'folder', cap: CAP.FILE_READ, perm: 'file.read' },
  ] },
  { title: '安全', items: [
    { to: '/firewall', label: '防火墙', icon: 'firewall', cap: CAP.FIREWALL_MANAGE, perm: 'firewall.view' },
    { to: '/security', label: '安全中心', icon: 'shield', cap: CAP.FIREWALL_MANAGE, perm: 'security.manage' },
    { to: '/logs', label: '日志', icon: 'list', cap: CAP.LOGS_READ, perm: 'log.view' },
  ] },
  { title: '运维', items: [
    { to: '/cron', label: '计划任务', icon: 'clock', cap: CAP.SCHEDULER_MANAGE, perm: 'cron.view' },
    { to: '/tasks', label: '任务中心', icon: 'terminal', cap: CAP.METRICS_READ, perm: 'task.view' },
    { to: '/terminal', label: '终端', icon: 'terminal', cap: CAP.TERMINAL_MANAGE, perm: 'system.manage' },
    { to: '/assistant', label: 'AI 助手', icon: 'sparkles', cap: CAP.METRICS_READ, perm: 'system.view' },
  ] },
  { title: '系统', items: [
    { to: '/users', label: '用户', icon: 'users', cap: CAP.USER_MANAGE, perm: 'user.manage' },
    { to: '/audit', label: '审计日志', icon: 'audit', cap: CAP.METRICS_READ, perm: 'audit.view' },
    { to: '/settings', label: '设置', icon: 'gear', cap: CAP.METRICS_READ, perm: 'settings.manage' },
  ] },
])

function why(it: Item): string | null {
  return auth.whyDisabled(it.cap, it.perm)
}
</script>

<template>
  <aside class="side" :class="{ collapsed }">
    <div class="brand">
      <div class="logo"><Icon name="bolt" :size="18" /></div>
      <span class="brand-name">ForkPanel</span>
      <button class="collapse-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
        <Icon name="chevron" :size="16" class="chev" />
      </button>
    </div>

    <nav class="nav">
      <div v-for="g in groups" :key="g.title" class="group">
        <div class="group-title">{{ g.title }}</div>
        <RouterLink
          v-for="it in g.items"
          :key="it.to"
          :to="it.to"
          class="item"
          :class="{ disabled: !!why(it) }"
          :title="why(it) ?? it.label"
        >
          <Icon :name="it.icon" :size="19" class="ico" />
          <span class="label">{{ it.label }}</span>
        </RouterLink>
      </div>
    </nav>

    <div v-if="auth.platform" class="meta">
      <Icon name="server" :size="14" />
      <span class="meta-txt">{{ auth.platform.distro || auth.platform.os }} · {{ auth.platform.arch }}</span>
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: 234px; flex: none;
  display: flex; flex-direction: column;
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
  transition: width .2s ease;
  position: sticky; top: 0; height: 100vh;
}
.side.collapsed { width: 76px; }

.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 16px 14px; position: relative;
}
.logo {
  width: 32px; height: 32px; border-radius: 9px; flex: none;
  display: grid; place-items: center; color: #fff;
  background: var(--gradient); box-shadow: var(--glow);
}
.brand-name { font-weight: 700; font-size: 16px; letter-spacing: .3px; }
.collapse-btn {
  margin-left: auto; width: 26px; height: 26px; padding: 0; border: none; background: transparent;
  color: var(--c-text-dim); border-radius: 7px;
}
.collapse-btn:hover { background: var(--c-hover); color: var(--c-text); }
.chev { transition: transform .2s ease; }
.collapsed .chev { transform: rotate(180deg); }

.nav { flex: 1; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 14px; }
.group { display: flex; flex-direction: column; gap: 2px; }
.group-title {
  font-size: 11px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase;
  color: var(--c-text-mute); padding: 4px 10px; margin-bottom: 2px;
}
.collapsed .group-title { opacity: 0; height: 14px; margin: 0; }

.item {
  position: relative;
  display: flex; align-items: center; gap: 11px;
  padding: 9px 11px; border-radius: 10px;
  color: var(--c-text-dim); text-decoration: none; font-size: 14px;
  transition: background .14s ease, color .14s ease;
}
.item:hover:not(.disabled) { background: var(--c-hover); color: var(--c-text); }
.item .ico { flex: none; }
.collapsed .label { display: none; }
.collapsed .item { justify-content: center; padding: 10px; }

.item.router-link-exact-active {
  color: var(--c-primary); background: var(--c-active); font-weight: 600;
}
.item.router-link-exact-active::before {
  content: ''; position: absolute; left: -12px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 20px; border-radius: 0 3px 3px 0; background: var(--gradient);
  box-shadow: 0 0 10px var(--c-primary);
}
.item.disabled { opacity: .4; pointer-events: none; }

.meta {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--c-border);
  font-size: 12px; color: var(--c-text-mute); white-space: nowrap; overflow: hidden;
}
.collapsed .meta { justify-content: center; padding: 12px 0; }
.collapsed .meta-txt { display: none; }
</style>

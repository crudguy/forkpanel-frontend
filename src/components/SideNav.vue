<script setup lang="ts">
/**
 * 侧边导航。
 *
 * ⚠️ 纪律（同前）：菜单可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，
 * **禁止**出现 isLinux / navigator.platform / target_os 之类的平台判断。
 * 新模块的 cap 复用既有常量兜底（如明细类用 METRICS_READ），仅 perm 区分可见性。
 *
 * ── 折叠态的两个约定（都踩过坑，别再改回去）──
 * 1. 折叠后品牌区**只留应用图标**：栏宽 76px 装不下 logo(32) + 文字 + 按钮(26)，
 *    三者并存的结果是文字被挤成 "Fo"、按钮被挤出可视区。
 *    现在折叠态隐藏文字、去掉品牌行的按钮，只居中一个图标。
 * 2. 折叠开关**固定在底部**且两种状态都不换位置（VS Code / Supabase / 宝塔同款）。
 *    曾经的实现把它放在品牌行右侧，用的是 `margin-left:auto`——折叠后那行已被
 *    logo 占满，按钮被推到可视区之外，于是**收起来就再也展不开**。
 *    也刻意**不做**"点 logo 展开"：logo 在展开态点击没有语义（既非链接也不是开关），
 *    同一个元素在不同状态下做不同事，用户只会更犹豫该点哪里。
 *
 * ── 箭头方向约定（2026-09-30 调整）──
 * chevron 图标原生朝右（">"）。展开态旋转 180° → 朝左（点我会「收起」）；
 * 折叠态旋转 0°   → 朝右（点我会「展开」）。箭头即"点了侧边栏会往哪走"。
 *
 * ── 系统基础信息已移出侧边栏 ──
 * 底部的 distro·arch 原来塞在折叠开关上方，既挤占开关空间又和 topbar 重复。
 * 现统一放到 MainLayout 的 topbar 右侧状态簇，侧边栏底部只留折叠开关。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import { navCollapsed, toggleNav } from '@/composables/nav'
import Icon from '@/components/Icon.vue'

interface Item { to: string; label: string; icon: string; cap: string; perm: string }

const auth = useAuthStore()

// 菜单项：扁平列表，不再分组。可见性 = 后端能力矩阵(cap) AND RBAC 权限点(perm)，
// **禁止** isLinux / navigator.platform 之类平台判断。新模块 cap 复用既有常量兜底
// （明细类用 METRICS_READ），仅 perm 区分可见性。
const items = computed(() => [
  { to: '/', label: '概览', icon: 'dashboard', cap: CAP.METRICS_READ, perm: 'system.view' },
  // 「通知」不再占菜单位：topbar 常驻铃铛 + 未读徽标即入口
  { to: '/system', label: '主机监控', icon: 'cpu', cap: CAP.METRICS_READ, perm: 'system.view' },
  // 「专业监控 / 进程」已并入主机监控页页内 Tab（/system/pro、/system/procs）
  { to: '/services', label: '软件与服务', icon: 'server', cap: CAP.SERVICE_MANAGE, perm: 'service.view' },
  // 门禁用 METRICS_READ 兜底而非 WEBSERVER_MANAGE：站点 CRUD（静态站）不依赖
  // nginx——以 webserver 能力门禁会让无 nginx 的环境整项不可达；页内具体动作
  // （配置下发/重载）各自按 WEBSERVER_MANAGE 置灰
  { to: '/sites', label: '网站与 SSL', icon: 'globe', cap: CAP.METRICS_READ, perm: 'site.view' },
  { to: '/databases', label: '数据库', icon: 'database', cap: CAP.DBMS_MANAGE, perm: 'db.view' },
  { to: '/containers', label: '容器', icon: 'docker', cap: CAP.CONTAINER_MANAGE, perm: 'container.view' },
  { to: '/backups', label: '备份', icon: 'archive', cap: CAP.BACKUP_MANAGE, perm: 'backup.view' },
  { to: '/files', label: '文件', icon: 'folder', cap: CAP.FILE_READ, perm: 'file.read' },
  { to: '/firewall', label: '安全', icon: 'shield', cap: CAP.FIREWALL_MANAGE, perm: 'firewall.view' },
  // 「安全中心」已并入安全页第二个 Tab（/firewall/baseline：基线检查 + 会话 + MFA）
  { to: '/logs', label: '日志', icon: 'list', cap: CAP.LOGS_READ, perm: 'log.view' },
  { to: '/cron', label: '任务', icon: 'clock', cap: CAP.SCHEDULER_MANAGE, perm: 'cron.view' },
  // 「任务中心」已并入任务页第二个 Tab（/cron/tasks）
  { to: '/terminal', label: '终端', icon: 'terminal', cap: CAP.TERMINAL_MANAGE, perm: 'system.manage' },
  { to: '/assistant', label: 'AI 助手', icon: 'sparkles', cap: CAP.METRICS_READ, perm: 'system.view' },
  { to: '/users', label: '用户', icon: 'users', cap: CAP.USER_MANAGE, perm: 'user.manage' },
  // 「审计日志」已并入日志页第二个 Tab（/logs/audit）
  { to: '/settings', label: '设置', icon: 'gear', cap: CAP.METRICS_READ, perm: 'settings.manage' },
])

function why(it: Item): string | null {
  return auth.whyDisabled(it.cap, it.perm)
}

const route = useRoute()
// 「主机监控」含页内子 Tab（/system、/system/pro、/system/procs），高亮按前缀匹配；
// 其余菜单仍精确匹配——概览 '/' 是所有路径的前缀，绝不能改前缀，否则全页常亮。
function isOn(it: Item): boolean {
  return it.to === '/system' ? route.path.startsWith('/system') : route.path === it.to
}
</script>

<template>
  <aside class="side" :class="{ collapsed: navCollapsed }">
    <div class="brand">
      <div class="logo"><Icon name="dog" :size="25" /></div>
      <span class="brand-name">ForkPanel</span>
    </div>

    <nav class="nav">
      <RouterLink
        v-for="it in items"
        :key="it.to"
        :to="it.to"
        class="item"
        :class="{ disabled: !!why(it), on: isOn(it) }"
        :title="why(it) ?? it.label"
        :aria-disabled="why(it) ? 'true' : undefined"
        :tabindex="why(it) ? -1 : undefined"
      >
        <Icon :name="it.icon" :size="19" class="ico" />
        <span class="label">{{ it.label }}</span>
      </RouterLink>
    </nav>

    <!-- 底部固定区：只放折叠开关。两种状态都不换位置，用户学一次就够。
         系统基础信息（distro·arch 等）已移往 MainLayout 的 topbar 右侧状态簇。 -->
    <div class="bottom">
      <button class="toggle" :title="navCollapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-expanded="!navCollapsed" @click="toggleNav">
        <Icon name="chevron" :size="16" class="chev" />
        <span class="toggle-label">收起侧边栏</span>
      </button>
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
  padding: 16px 16px 14px;
}
.logo {
  width: 32px; height: 32px; border-radius: 9px; flex: none;
  display: grid; place-items: center; color: #fff;
  background: var(--gradient); box-shadow: var(--glow);
}
.brand-name { font-weight: 700; font-size: 16px; letter-spacing: .3px; }
/* 折叠态：只留图标。文字必须 display:none 而不是靠容器裁切——
   76px 的栏宽装不下 logo+文字+按钮，靠挤只会得到 "Fo" 这种半截文本。 */
.collapsed .brand { justify-content: center; gap: 0; padding: 16px 0 14px; }
.collapsed .brand-name { display: none; }

.nav { flex: 1; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 3px; }

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

.item.router-link-exact-active,
.item.on {
  color: var(--c-primary); background: var(--c-active); font-weight: 600;
}
.item.router-link-exact-active::before,
.item.on::before {
  content: ''; position: absolute; left: -12px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 20px; border-radius: 0 3px 3px 0; background: var(--gradient);
  box-shadow: 0 0 10px var(--c-primary);
}
.item.disabled { opacity: .4; pointer-events: none; }

.bottom {
  flex: none; border-top: 1px solid var(--c-border);
  padding: 6px 8px 8px;
}
.toggle {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: none; background: transparent; cursor: pointer;
  color: var(--c-text-dim); border-radius: 10px; font-size: 13px; font-family: inherit;
  transition: background .14s ease, color .14s ease;
}
.toggle:hover { background: var(--c-hover); color: var(--c-text); }
.chev { flex: none; transition: transform .2s ease; transform: rotate(180deg); }
/* 展开态箭头朝左（点我会收起），折叠态翻转朝右（点我会展开）。
   箭头方向即"点了侧边栏会往哪走"，与主流面板一致。 */
.collapsed .chev { transform: rotate(0deg); }
.collapsed .toggle { justify-content: center; padding: 8px; }
.collapsed .toggle-label { display: none; }
</style>

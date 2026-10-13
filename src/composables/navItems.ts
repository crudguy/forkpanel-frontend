/**
 * 导航项（单一事实源）。
 *
 * 命令面板（A11）与侧边栏（SideNav）共用同一份「路由 → 标题/图标/能力位/权限点」
 * 定义，避免两处各写一份导致漂移（菜单与面板搜出来的结果不一致）。
 *
 * 可见性口径与 SideNav 完全一致：能力位 AND 权限点，由调用方用
 * `auth.whyDisabled(cap, perm)` 判定。这里只放静态定义。
 *
 * `group` 为能力域分组（A10 分组建议，已落地）：侧边栏按它分 8 组折叠、
 * 深链并入当前组、折叠态组图标可点内联展开子项；命令面板也按它归类展示。
 */
import { CAP } from '@/api/types'

export interface NavDef {
  to: string
  label: string
  icon: string
  cap: string
  perm: string
  group: string
}

export const NAV_ITEMS: NavDef[] = [
  { to: '/', label: '概览', icon: 'dashboard', cap: CAP.METRICS_READ, perm: 'system.view', group: '主机监控' },
  { to: '/system', label: '主机监控', icon: 'cpu', cap: CAP.METRICS_READ, perm: 'system.view', group: '主机监控' },
  { to: '/services', label: '软件与服务', icon: 'server', cap: CAP.SERVICE_MANAGE, perm: 'service.view', group: '软件与服务' },
  { to: '/sites', label: '网站', icon: 'globe', cap: CAP.METRICS_READ, perm: 'site.view', group: '站点' },
  { to: '/apps', label: '应用', icon: 'bolt', cap: CAP.SERVICE_MANAGE, perm: 'service.view', group: '软件与服务' },
  { to: '/waf', label: 'WAF', icon: 'firewall', cap: CAP.METRICS_READ, perm: 'site.view', group: '站点' },
  { to: '/certs', label: '证书', icon: 'lock', cap: CAP.METRICS_READ, perm: 'site.view', group: '站点' },
  { to: '/databases', label: '数据库', icon: 'database', cap: CAP.DBMS_MANAGE, perm: 'db.view', group: '数据' },
  { to: '/containers', label: '容器', icon: 'docker', cap: CAP.CONTAINER_VIEW, perm: 'container.view', group: '数据' },
  { to: '/backups', label: '备份', icon: 'archive', cap: CAP.BACKUP_MANAGE, perm: 'backup.view', group: '数据' },
  { to: '/files', label: '文件', icon: 'folder', cap: CAP.FILE_READ, perm: 'file.read', group: '数据' },
  { to: '/firewall', label: '安全', icon: 'shield', cap: CAP.METRICS_READ, perm: 'firewall.view', group: '安全' },
  { to: '/logs', label: '日志', icon: 'list', cap: CAP.LOGS_READ, perm: 'log.view', group: '日志' },
  { to: '/cron', label: '任务', icon: 'clock', cap: CAP.SCHEDULER_MANAGE, perm: 'cron.view', group: '任务' },
  { to: '/terminal', label: '终端', icon: 'terminal', cap: CAP.TERMINAL_MANAGE, perm: 'system.manage', group: '系统' },
  { to: '/assistant', label: 'AI 助手', icon: 'sparkles', cap: CAP.METRICS_READ, perm: 'system.view', group: '系统' },
  { to: '/users', label: '用户', icon: 'users', cap: CAP.USER_MANAGE, perm: 'user.manage', group: '系统' },
  { to: '/settings', label: '设置', icon: 'gear', cap: CAP.METRICS_READ, perm: 'settings.manage', group: '系统' },
]

/**
 * 分组图标（侧边栏**折叠态**用）：折叠栏只显示 8 个分组图标（上级菜单），
 * 点分组图标 → 内联展开该分组的子项（下级菜单），保持「分组→子项」层级。
 * 复用各分组代表子项的图标作为组图标即可，不新增图标定义；
 * 单子项分组（安全/日志/任务）组图标即自身、点之直接跳转。
 */
export const GROUP_ICONS: Record<string, string> = {
  '主机监控': 'cpu',
  '软件与服务': 'server',
  '站点': 'globe',
  '数据': 'database',
  '安全': 'shield',
  '日志': 'list',
  '任务': 'clock',
  '系统': 'gear',
}

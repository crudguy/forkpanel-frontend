/**
 * 导航项（单一事实源）。
 *
 * 命令面板（A11）与侧边栏（SideNav）共用同一份「路由 → 标题/图标/能力位/权限点」
 * 定义，避免两处各写一份导致漂移（菜单与面板搜出来的结果不一致）。
 *
 * 可见性口径与 SideNav 完全一致：能力位 AND 权限点，由调用方用
 * `auth.whyDisabled(cap, perm)` 判定。这里只放静态定义。
 *
 * `group` 为能力域分组（A10 分组建议，已落地）：侧边栏按它插入静态分组分隔线
 * （不折叠、无 drill，一级扁平模式下仅作归类提示）；命令面板也按它归类展示。
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

// 2026-10-29 重设计：8 组 → 6 组（监控 / 服务 / 数据 / 安全 / 运维 / 系统）。
// 消除单条目分组（安全/日志/任务），安全域收敛（防火墙 + 公网访问），运维合并
// （日志 + 任务 + 终端），高频前置、低频（系统）靠后。SideNav 按 group 自动插分隔线，
// 故仅改此处的 group 字段 + 顺序即可，无需动 SideNav。
export const NAV_ITEMS: NavDef[] = [
  // —— 监控：看盒子 ——
  { to: '/', label: '概览', icon: 'dashboard', cap: CAP.METRICS_READ, perm: 'system.view', group: '监控' },
  { to: '/system', label: '主机监控', icon: 'cpu', cap: CAP.METRICS_READ, perm: 'system.view', group: '监控' },
  // —— 服务：跑业务（软件包 + systemd 单元 / 托管应用 / 站点）——
  // 「软件与服务」保留原名：其页内默认页签即「软件」，改名「服务」反而与页签错位；
  // 它（系统包 + systemd 单元）与「应用」（面板托管进程 + 自动反代）是两个不同概念，不合并。
  { to: '/services', label: '软件与服务', icon: 'server', cap: CAP.SERVICE_MANAGE, perm: 'service.view', group: '服务' },
  { to: '/apps', label: '应用', icon: 'bolt', cap: CAP.SERVICE_MANAGE, perm: 'service.view', group: '服务' },
  { to: '/sites', label: '网站', icon: 'globe', cap: CAP.METRICS_READ, perm: 'site.view', group: '服务' },
  { to: '/waf', label: 'WAF', icon: 'firewall', cap: CAP.METRICS_READ, perm: 'site.view', group: '服务' },
  { to: '/certs', label: '证书', icon: 'lock', cap: CAP.METRICS_READ, perm: 'site.view', group: '服务' },
  // —— 数据：存数据 ——
  { to: '/databases', label: '数据库', icon: 'database', cap: CAP.DBMS_MANAGE, perm: 'db.view', group: '数据' },
  { to: '/containers', label: '容器', icon: 'docker', cap: CAP.CONTAINER_VIEW, perm: 'container.view', group: '数据' },
  { to: '/backups', label: '备份', icon: 'archive', cap: CAP.BACKUP_MANAGE, perm: 'backup.view', group: '数据' },
  { to: '/files', label: '文件', icon: 'folder', cap: CAP.FILE_READ, perm: 'file.read', group: '数据' },
  // —— 安全：守边界（防火墙 + 公网暴露同处，边界决策一处完成）——
  { to: '/firewall', label: '安全', icon: 'shield', cap: CAP.FIREWALL_MANAGE, perm: 'firewall.manage', group: '安全' },
  // 公网访问原埋在「系统」组底部；它与防火墙同质（对外暴露 / 边界防御），2026-10-29 上移至此。
  // 图标由 globe 改为 network：globe 已被「网站」占用，折叠态 76px 下两者会撞脸。
  { to: '/system/expose', label: '公网访问', icon: 'network', cap: CAP.EXPOSE_MANAGE, perm: 'system.view', group: '安全' },
  // —— 运维：排障（日志 / 任务 / 终端 合并，消除单条目分组噪音）——
  { to: '/logs', label: '日志', icon: 'list', cap: CAP.LOGS_READ, perm: 'log.view', group: '运维' },
  { to: '/cron', label: '任务', icon: 'clock', cap: CAP.SCHEDULER_MANAGE, perm: 'cron.view', group: '运维' },
  { to: '/terminal', label: '终端', icon: 'terminal', cap: CAP.TERMINAL_MANAGE, perm: 'system.manage', group: '运维' },
  // —— 系统：低频管理区（顶栏另有常驻 AI 助手按钮，侧栏保留兜底入口）——
  { to: '/assistant', label: 'AI 助手', icon: 'sparkles', cap: CAP.METRICS_READ, perm: 'system.view', group: '系统' },
  { to: '/users', label: '用户', icon: 'users', cap: CAP.USER_MANAGE, perm: 'user.manage', group: '系统' },
  { to: '/settings', label: '设置', icon: 'gear', cap: CAP.METRICS_READ, perm: 'settings.manage', group: '系统' },
]

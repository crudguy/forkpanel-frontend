import type { RouteLocationRaw } from 'vue-router'

/**
 * 通知的展示口径：**来源中文 + 按来源跳回业务页 + 正文纯文本**。
 *
 * 前两项此前完全没有：列表里显示 `backup/restore/security` 这种机器值，
 * 通知又只是一段死文字——用户看到「备份计划 #3 失败」却点不过去，
 * 还得自己去侧栏找对应页面。这里把映射收在纯函数里（不进 .vue），
 * 单测能直接跑；新增来源只要改这两张表。
 *
 * 跳转目前按 source 粒度（面板没有 action_url 字段），来源未知就不给链接，
 * 避免把用户送到一个不相干的页面。
 */
const SOURCE_LABEL: Record<string, string> = {
  backup: '备份', restore: '恢复', cert: '证书',
  task: '任务', security: '安全', system: '系统',
}

const SOURCE_ROUTE: Record<string, string> = {
  backup: '/backups', restore: '/backups',
  cert: '/certs', task: '/cron/tasks', security: '/waf', system: '/settings',
}

/** 来源 → 中文；未登记的来源回退原值（不假装认识）。 */
export function notifSourceLabel(v: string | null | undefined): string {
  if (v == null || v === '') return '—'
  const label = SOURCE_LABEL[v]
  return typeof label === 'string' ? label : v
}

/** 来源 → 业务页；未登记的来源返回 null（模板渲染纯文本，不给死链）。 */
export function notifSourceRoute(v: string | null | undefined): RouteLocationRaw | null {
  if (v == null || v === '') return null
  const path = SOURCE_ROUTE[v]
  return typeof path === 'string' ? path : null
}

/**
 * 正文纯文本化。
 *
 * 后端早期在通知正文里写过 `**异地副本缺失**` 这种 Markdown 强调标记，
 * 而列表是纯文本渲染，星号会原样出现在界面上。写入侧已改成纯文本，
 * 这里顺手把历史数据里的 `**` 去掉（不做完整 Markdown 渲染：通知正文
 * 是后端拼的错误信息，绝不能走 v-html）。
 */
export function notifBodyText(v: string | null | undefined): string {
  return v ? v.replace(/\*\*/g, '') : ''
}

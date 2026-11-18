import { describe, it, expect } from 'vitest'
import { buildCommands, filterCommands, type RouteLike } from './commandPalette'

const routes: RouteLike[] = [
  { name: 'login', path: '/login', meta: { title: '登录' } },
  { name: 'dashboard', path: '/', meta: { title: '概览' } },
  { name: 'system', path: '/system', meta: { title: '实时趋势' } },
  { name: 'system-pro', path: '/system/pro', meta: { title: '专业快照' } },
  { name: 'logs-audit', path: '/logs/audit', meta: { title: '审计日志' } },
  { name: 'service-detail', path: '/services/:unit', meta: { title: '服务详情' } },
  { name: 'not-found', path: '/:pathMatch(.*)*', meta: { title: '页面不存在' } },
  { path: '/old', redirect: '/' },
]

describe('buildCommands', () => {
  it('只收有名字、有标题、可直达的路由', () => {
    const cmds = buildCommands(routes)
    expect(cmds.map((c) => c.name)).toEqual(['dashboard', 'system', 'system-pro', 'logs-audit'])
    expect(cmds.find((c) => c.name === 'logs-audit')?.path).toBe('/logs/audit')
  })

  it('覆盖 Tab 子路由（侧栏 20 项不足以定位 /logs/audit）', () => {
    expect(buildCommands(routes).some((c) => c.path === '/logs/audit')).toBe(true)
  })
})

describe('filterCommands', () => {
  const cmds = buildCommands(routes)

  it('空查询返回全量（不排序打乱路由顺序）', () => {
    expect(filterCommands(cmds, '  ')).toEqual(cmds)
  })

  it('中文标题与英文路径都能命中', () => {
    expect(filterCommands(cmds, '审计').map((c) => c.name)).toEqual(['logs-audit'])
    expect(filterCommands(cmds, 'audit').map((c) => c.name)).toEqual(['logs-audit'])
    expect(filterCommands(cmds, 'pro').map((c) => c.name)).toEqual(['system-pro'])
  })

  it('空格分词按 AND 匹配', () => {
    expect(filterCommands(cmds, 'system pro').map((c) => c.name)).toEqual(['system-pro'])
    expect(filterCommands(cmds, 'system 不存在')).toEqual([])
  })

  it('标题前缀优先于包含', () => {
    const withMore = [...cmds, { name: 'x', title: '专业版快照', path: '/x' }]
    expect(filterCommands(withMore, '专业')[0].name).toBe('system-pro')
  })
})

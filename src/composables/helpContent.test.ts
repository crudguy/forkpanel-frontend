/**
 * 帮助页内容守卫。
 *
 * 这类「文案与菜单一致性」问题不属于类型错误：菜单改了名字、换了路由、加了新模块，
 * 帮助页照常渲染，只是把用户引到不存在的页面、或漏掉一整个模块——`vue-tsc` 和
 * `vite build` 都不会皱一下眉。故用内容层断言钉住：
 *   1. 模块速览必须**一条不落**覆盖 `NAV_ITEMS`（标签/图标/顺序都同源）；
 *   2. 每个模块必须有说明（新增菜单忘补 → 变红）；
 *   3. 常用操作不得指向不存在的路由，也不得重复；
 *   4. 权限过滤的三条分支（全通 / 全禁 / 部分）都真跑一遍。
 *
 * ⚠️ 每条断言前先做**扫描自检**（条数下限 + 哨兵项在场）：如果哪天上游映射失效
 * 抓到空集，"差集为空"会让测试恒绿——那比没有守卫更危险。
 */
import { describe, expect, it } from 'vitest'
import { FAQS, MODULE_DOCS, QUICK_TASKS, pickQuickTasks } from './helpContent'
import { NAV_ITEMS } from './navItems'

describe('帮助内容与导航项一致', () => {
  it('模块速览一条不落地覆盖导航项', () => {
    // 扫描自检：映射真的抓到了东西，且已知项在场（防「空集 = 通过」）
    expect(NAV_ITEMS.length).toBeGreaterThanOrEqual(20)
    expect(MODULE_DOCS.length).toBe(NAV_ITEMS.length)
    expect(MODULE_DOCS.map((m) => m.to)).toEqual(NAV_ITEMS.map((n) => n.to))
    expect(MODULE_DOCS.find((m) => m.to === '/help')?.label).toBe('帮助')
    expect(MODULE_DOCS.find((m) => m.to === '/sites')?.icon).toBe('globe')
  })

  it('每个模块都有非空说明', () => {
    const missing = MODULE_DOCS.filter((m) => !m.desc.trim()).map((m) => m.to)
    expect(missing).toEqual([])
    // 哨兵：说明不是同一句话复读出来的
    expect(MODULE_DOCS.find((m) => m.to === '/help')?.desc).toContain('本页')
    expect(MODULE_DOCS.find((m) => m.to === '/terminal')?.desc).toContain('高危')
  })

  it('常用操作都指向真实页面且不重复', () => {
    expect(QUICK_TASKS.length).toBeGreaterThanOrEqual(6)
    const routes = new Set(NAV_ITEMS.map((n) => n.to))
    expect(QUICK_TASKS.filter((t) => !routes.has(t.to)).map((t) => t.to)).toEqual([])
    const dup = QUICK_TASKS.map((t) => t.to).filter((to, i, arr) => arr.indexOf(to) !== i)
    expect(dup).toEqual([])
    // 哨兵：至少覆盖站点与日志两条最常问的
    expect(QUICK_TASKS.map((t) => t.to)).toContain('/sites')
    expect(QUICK_TASKS.map((t) => t.to)).toContain('/logs')
  })

  it('权限过滤：全部可用时原样返回，并带出导航项图标', () => {
    const got = pickQuickTasks(() => null)
    expect(got.length).toBe(QUICK_TASKS.length)
    expect(got.map((t) => t.to)).toEqual(QUICK_TASKS.map((t) => t.to))
    // 图标来自 navItems，不是帮助页另写一份
    expect(got.find((t) => t.to === '/sites')?.icon).toBe('globe')
  })

  it('权限过滤：全部不可用时返回空，不摆一排点不动的入口', () => {
    expect(pickQuickTasks(() => '权限不足')).toEqual([])
  })

  it('权限过滤：只保留有权限的那部分', () => {
    const got = pickQuickTasks((_cap, perm) => (perm === 'site.view' ? null : '权限不足'))
    expect(got.map((t) => t.to)).toEqual(['/sites', '/certs'])
  })

  it('常见问题每条都有问答', () => {
    expect(FAQS.length).toBeGreaterThanOrEqual(4)
    expect(FAQS.filter((f) => !f.q.trim() || !f.a.trim())).toEqual([])
  })
})

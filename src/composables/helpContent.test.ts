/**
 * 帮助页内容守卫。
 *
 * 这类「文案与菜单/命令一致性」问题不属于类型错误：菜单改了名字、换了路由、
 * 命令改了参数、删掉一条关键前置，帮助页照常渲染，只是把用户引到不存在的页面、
 * 或教他执行一条根本不存在的命令——`vue-tsc` 和 `vite build` 都不会皱一下眉。
 * 故用内容层断言钉住：
 *   1. 模块速览必须**一条不落**覆盖 `NAV_ITEMS`（标签/图标/顺序都同源）；
 *   2. 每个模块必须有说明（新增菜单忘补 → 变红）；
 *   3. 常用操作不得指向不存在的路由，也不得重复；
 *   4. 权限过滤的三条分支（全通 / 全禁 / 部分）都真跑一遍；
 *   5. 终端命令分组齐全、字段完整、命令名不重复，高危与关键命令在场；
 *   6. 常见问题问答齐全、问题不重复，覆盖原硬编码卡片里的独有信息。
 *
 * ⚠️ 每条断言前先做**扫描自检**（条数下限 + 哨兵项在场）：如果哪天上游映射失效
 * 抓到空集，"差集为空"会让测试恒绿——那比没有守卫更危险。
 */
import { describe, expect, it } from 'vitest'
import { CLI_GLOBALS, CLI_GROUPS, FAQS, MODULE_DOCS, QUICK_TASKS, pickQuickTasks } from './helpContent'
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

  it('每个模块都有可操作的说明，而非只有名词', () => {
    const missing = MODULE_DOCS.filter((m) => !m.desc.trim()).map((m) => m.to)
    expect(missing).toEqual([])
    // 说明至少两句：既不空泛，也不会长到把速览卡片撑成小作文
    const short = MODULE_DOCS.filter((m) => m.desc.length < 40).map((m) => m.to)
    expect(short).toEqual([])
    expect(MODULE_DOCS.every((m) => m.desc.length < 160)).toBe(true)
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
    // 描述要给出前置或后果，不只是「在这里做某件事」
    expect(QUICK_TASKS.filter((t) => t.desc.length < 20).map((t) => t.to)).toEqual([])
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
})

describe('终端命令参考完整且与事实对齐', () => {
  // 扫描自检：分组与命令条数下限 + 已知项在场，防「抓到空集则恒绿」
  const all = CLI_GROUPS.flatMap((g) => g.commands)
  const names = all.map((c) => c.cmd)

  it('分组与命令条数足够，覆盖安装到卸载的完整流程', () => {
    expect(CLI_GROUPS.length).toBeGreaterThanOrEqual(5)
    expect(all.length).toBeGreaterThanOrEqual(20)
    expect(CLI_GLOBALS.length).toBeGreaterThanOrEqual(3)
    expect(CLI_GLOBALS.some((g) => g.includes('--config'))).toBe(true)
    // 哨兵：最常问的几条必须在场，少一条就是帮助页退步
    const mustHave = [
      'panel init', 'panel doctor', 'panel backup', 'panel verify-backup',
      'panel restore-db', 'panel passwd', 'panel key', 'panel expose',
      'panel upgrade', 'panel uninstall', 'panel capabilities', 'panel config status',
    ]
    expect(mustHave.filter((m) => !names.some((n) => n.startsWith(m)))).toEqual([])
  })

  it('每条命令都写全用途/场景/参数/前置/注意，写法不重复', () => {
    const incomplete = all.filter((c) =>
      !c.cmd.trim() || !c.purpose.trim() || !c.when.trim() ||
      !c.requires.trim() || !c.caution.trim() || !Array.isArray(c.params),
    ).map((c) => c.cmd)
    expect(incomplete).toEqual([])
    const dup = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dup).toEqual([])
    expect(all.filter((c) => c.purpose.length < 10 || c.caution.length < 20).map((c) => c.cmd)).toEqual([])
  })

  it('高危命令带标记，关键参数与前置条件写进正文', () => {
    const risk = all.filter((c) => c.risk).map((c) => c.cmd)
    expect(risk.length).toBeGreaterThanOrEqual(6)
    expect(risk.some((c) => c.startsWith('panel restore-db'))).toBe(true)
    expect(risk.some((c) => c.startsWith('panel key'))).toBe(true)
    expect(risk.some((c) => c.startsWith('panel expose'))).toBe(true)
    expect(risk).toContain('panel uninstall')

    const find = (prefix: string) => all.find((c) => c.cmd.startsWith(prefix))!
    expect(find('panel backup').params.join(' ')).toContain('--no-encrypt')
    expect(find('panel capabilities').params.join(' ')).toContain('--json')
    expect(find('panel config set port').params.join(' ')).toContain('--yes')
    expect(find('panel restore-db').requires).toContain('停止面板服务')
    expect(find('panel key').caution).toContain('轮换')
    // expose 的「撤销暴露 ≠ 卸载」是最容易混淆的一处，必须写清
    expect(find('panel expose').caution).toContain('panel uninstall')
  })
})

describe('常见问题覆盖常见疑惑', () => {
  it('每条都有问答、问题不重复，并覆盖硬编码卡片里的独有信息', () => {
    expect(FAQS.length).toBeGreaterThanOrEqual(10)
    expect(FAQS.filter((f) => !f.q.trim() || !f.a.trim()).map((f) => f.q)).toEqual([])
    const dup = FAQS.map((f) => f.q).filter((q, i, arr) => arr.indexOf(q) !== i)
    expect(dup).toEqual([])
    // 原「账户与安全/备份与恢复/安全提示」三块里的独有信息已经并进来
    const joined = FAQS.map((f) => f.q + f.a).join('\n')
    for (const point of ['passwd', '仅支持 Linux', '备份', 'root', 'uninstall']) {
      expect(joined).toContain(point)
    }
  })
})

// @vitest-environment jsdom
// 任务中心：状态筛选 + 每页条数传导到服务端（limit）。
//
// 修的是两条错位：
//  1) 前端分页默认 100，后端 `GET /tasks` 缺省只给 50 条 ⇒ 分页器算出 2 页、
//     第 2 页是空的；`total` 也被显示成 50。
//  2) 后端已支持 `?state=`，前端没有任何筛选入口。
//
// 断言的是**真的发给接口的查询串**，不是「源码里出现了 state 这个词」——
// 后者在变量名、注释、类型声明里都能命中，属于恒绿写法。
import { describe, it, expect } from 'vitest'
import TasksView from './TasksView.vue'
import { API } from '@/api/endpoints'
import { mountView, capsAllOk } from '@/test/mount'

const PERMS = ['task.view', 'task.manage', 'system.view']

function task(over: Record<string, unknown> = {}) {
  return {
    id: 7, key: 'backup.daily', kind: 'backup', state: 'ok', progress: 100,
    started_at: 1, finished_at: 2, exit_code: null, ...over,
  }
}

/** 从假 fetch 的调用记录里取出所有 GET /api/v1/tasks 的完整 URL。 */
function listUrls(m: { fake: { calls: { url: string; method: string }[] } }): string[] {
  return m.fake.calls.filter((c) => c.method === 'GET' && c.url.includes('/api/v1/tasks')).map((c) => c.url)
}

describe('任务中心 · 每页条数传导为 limit', () => {
  it('默认请求带 limit=100，与服务端默认 50 对齐后不再「只拿回半页」', async () => {
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.tasks.list()]: [task()] },
    })
    const urls = listUrls(m)
    expect(urls.length).toBeGreaterThanOrEqual(1)
    // 默认 100（localStorage 干净时 useTableControls 的 defaultSize）
    expect(urls[0]).toContain('limit=100')
    m.fake.assertClean(); m.cleanup()
  })

  it('改成每页 20 条：重新向服务端要数，且 limit=20', async () => {
    // 行数必须 > 最小档位（10），否则 TablePager 判定「一页装得下」而整块隐藏——
    // 那是刻意的抑制设计，不是缺陷。造 15 行让它真的出现。
    const rows = Array.from({ length: 15 }, (_, i) => task({ id: 100 - i }))
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.tasks.list()]: rows },
    })
    const before = listUrls(m).length
    const sel = m.host.querySelector('select[aria-label="按状态筛选任务"]')
    expect(sel, '筛选条里的状态下拉必须真的渲染出来').not.toBeNull()
    const sizeSel = Array.from(m.host.querySelectorAll('select')).find(
      (s) => s !== sel && Array.from(s.options).some((o) => o.value === '20'),
    ) as HTMLSelectElement | undefined
    expect(sizeSel, 'TablePager 的每页条数下拉未渲染').toBeTruthy()
    sizeSel!.value = '20'
    sizeSel!.dispatchEvent(new Event('change'))
    await m.flush()
    const urls = listUrls(m)
    expect(urls.length, '改每页条数必须重拉，否则本地行数不够用').toBeGreaterThan(before)
    expect(urls[urls.length - 1]).toContain('limit=20')
    m.fake.assertClean(); m.cleanup()
  })
})

describe('任务中心 · 状态筛选', () => {
  it('选中「失败」后请求带 state=failed，且列表只剩对应状态', async () => {
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        // 只有带 state 的那一路返回失败任务；无筛选返回一条成功任务
        [API.tasks.list()]: [task({ id: 9, state: 'ok' })],
      },
    })
    const sel = m.host.querySelector('select[aria-label="按状态筛选任务"]') as HTMLSelectElement
    sel.value = 'failed'
    sel.dispatchEvent(new Event('change'))
    await m.flush()

    const urls = listUrls(m)
    expect(urls[urls.length - 1]).toContain('state=failed')
    // 计数文案跟随筛选，而不是永远说「共 N 个任务」
    expect(m.host.textContent).toContain('失败')
    m.fake.assertClean(); m.cleanup()
  })

  it('筛选下拉只列后端真会发出的 6 个状态（不含 done / cancelled 脏值）', async () => {
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.tasks.list()]: [task()] },
    })
    const sel = m.host.querySelector('select[aria-label="按状态筛选任务"]') as HTMLSelectElement
    const values = Array.from(sel.options).map((o) => o.value)
    expect(values).toEqual(['', 'queued', 'running', 'ok', 'failed', 'canceled', 'interrupted'])
    expect(values).not.toContain('done')
    expect(values).not.toContain('cancelled')
    m.fake.assertClean(); m.cleanup()
  })
})

describe('任务中心 · 失败任务的退出码前置', () => {
  it('失败行显示 exit 徽标；成功行不显示', async () => {
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        [API.tasks.list()]: [
          task({ id: 1, state: 'failed', exit_code: 127 }),
          task({ id: 2, state: 'ok', exit_code: 0 }),
        ],
      },
    })
    const chips = Array.from(m.host.querySelectorAll('.exit-chip')).map((e) => e.textContent?.trim())
    expect(chips).toEqual(['exit 127'])
    m.fake.assertClean(); m.cleanup()
  })
})

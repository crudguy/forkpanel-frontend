// @vitest-environment jsdom
//
// F-18 后半（任务）：取消成功后要有 toast、列表与开着的详情都要重载；
// 失败不许占列表顶部那条「重试」（它只会重拉列表，重试不了取消）。
// 共用夹具见 `src/test/toastHarness.ts`。
import { describe, it, expect, beforeEach } from 'vitest'
import TasksView from './TasksView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { fakeError, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import { withToastHost, clearToasts, toastTexts, buttonByText } from '@/test/toastHarness'

const PERMS = ['task.view', 'task.manage', 'system.view']

function task(over: Record<string, unknown> = {}) {
  return {
    id: 7, key: 'backup.daily', kind: 'backup', state: 'running', progress: 10,
    started_at: 1, finished_at: null, exit_code: null, ...over,
  }
}

function mount(routes: Record<string, FakeRoute>): Promise<Mounted> {
  return mountView({ component: withToastHost(TasksView), caps: capsAllOk(), perms: PERMS, routes })
}

beforeEach(clearToasts)

describe('F-18 后半 · 任务取消的反馈', () => {
  it('取消任务：toast + 重载后状态变「已取消」', async () => {
    let lists = 0
    const m = await mount({
      [API.tasks.list()]: () => {
        lists += 1
        return [task({ state: lists === 1 ? 'running' : 'cancelled' })]
      },
      [API.tasks.cancel(7)]: { ok: true },
    })
    buttonByText(m.host, '取消').click()
    await m.flush()

    expect(m.fake.count(API.tasks.cancel(7), 'POST')).toBe(1)
    expect(toastTexts()).toContain('已请求取消任务 #7')
    expect(m.fake.count(API.tasks.list(), 'GET'), '写后没有重载').toBe(2)
    expect(m.host.textContent, '重载后状态没跟着变').toContain('已取消')
    m.fake.assertClean(); m.cleanup()
  })

  it('详情面板开着时取消：详情与输出都被重新拉取（open 也是 await 的）', async () => {
    const m = await mount({
      [API.tasks.list()]: [task()],
      [API.tasks.cancel(7)]: { ok: true },
      [API.tasks.get(7)]: task(),
      [API.tasks.output(7)]: { id: 7, lines: ['line-1'] },
    })
    buttonByText(m.host, /输出/).click()
    await m.flush()
    expect(m.fake.count(API.tasks.get(7), 'GET')).toBe(1)
    expect(m.host.textContent).toContain('line-1')

    buttonByText(m.host, '取消').click()
    await m.flush()

    expect(m.fake.count(API.tasks.cancel(7), 'POST')).toBe(1)
    expect(m.fake.count(API.tasks.get(7), 'GET'), '开着的详情没有被刷新').toBe(2)
    expect(m.fake.count(API.tasks.output(7), 'GET')).toBe(2)
    m.fake.assertClean(); m.cleanup()
  })

  it('取消失败：落 toast，不占用列表顶部那条「重试」错误条', async () => {
    const m = await mount({
      [API.tasks.list()]: [task()],
      // 后端真实契约：已结束的任务 → 409 + 10005（tasks.rs 的 ApiError::conflict）
      [API.tasks.cancel(7)]: fakeError(409, 10005, '任务已结束（running），无法取消'),
    })
    buttonByText(m.host, '取消').click()
    await m.flush()

    // 只断到前缀：errorText 目前把 10005 一律压成「已有同名资源，请换一个名称」，
    // 与后端这句中文冲突文案对不上（已单列待裁决，不在这里把错文案钉成"预期"）。
    expect(toastTexts().some((t) => t.startsWith('取消任务失败：')), '失败没有落 toast').toBe(true)
    expect(toastTexts().filter((t) => t.startsWith('已请求取消'))).toEqual([])
    // 那条错误条的重试按钮只会重拉列表，不能用来重试取消——所以这里不许出现它
    expect(m.host.querySelector('.err')).toBeNull()
    m.fake.assertClean(); m.cleanup()
  })
})

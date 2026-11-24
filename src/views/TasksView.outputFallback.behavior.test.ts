// @vitest-environment jsdom
//
// 任务输出文件被日志清理策略删掉后，后端降级成 200 + note。
// 详情面板必须把「输出不可用」讲清楚，不能显示误导性的「(无输出)」或错误堆栈。
import { describe, it, expect } from 'vitest'
import TasksView from './TasksView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import type { FakeRoute } from '@/test/apiFake'
import { withToastHost, buttonByText } from '@/test/toastHarness'
import { API } from '@/api/endpoints'

const PERMS = ['task.view', 'task.manage', 'system.view']

function task() {
  return {
    id: 7, key: 'cron.run:x', kind: 'internal', state: 'ok', progress: 100,
    started_at: 1, finished_at: 2, exit_code: 0,
  }
}

function mount(routes: Record<string, FakeRoute>): Promise<Mounted> {
  return mountView({ component: withToastHost(TasksView), caps: capsAllOk(), perms: PERMS, routes })
}

describe('任务输出不可用的展示', () => {
  it('降级 note 优先于 (无输出)，明确说明输出文件已不存在', async () => {
    const m = await mount({
      [API.tasks.list()]: [task()],
      [API.tasks.get(7)]: task(),
      [API.tasks.output(7)]: {
        id: 7, lines: [], note: '输出文件不存在或已被清理，无法查看本次输出',
      },
    })
    buttonByText(m.host, /输出/).click()
    await m.flush()

    expect(m.host.textContent).toContain('输出文件不存在或已被清理')
    expect(m.host.textContent).not.toContain('(无输出)')
    expect(m.fake.count(API.tasks.output(7), 'GET')).toBe(1)
    m.fake.assertClean(); m.cleanup()
  })

  it('正常无输出仍显示占位，不误报为文件缺失', async () => {
    const m = await mount({
      [API.tasks.list()]: [task()],
      [API.tasks.get(7)]: task(),
      [API.tasks.output(7)]: { id: 7, lines: [], note: '无输出文件' },
    })
    buttonByText(m.host, /输出/).click()
    await m.flush()

    expect(m.host.textContent).toContain('(无输出)')
    expect(m.host.textContent).not.toContain('⚠')
    m.fake.assertClean(); m.cleanup()
  })
})

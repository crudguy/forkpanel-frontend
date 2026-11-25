// @vitest-environment jsdom
//
// 详情必须就地展开在所点击的任务行下面，不能固定在页面最底部：
// 任务多时用户点开第 N 行要滑很久才看得到输出。
import { describe, it, expect } from 'vitest'
import TasksView from './TasksView.vue'
import { mountView, capsAllOk } from '@/test/mount'
import { buttonByText } from '@/test/toastHarness'
import { API } from '@/api/endpoints'

const PERMS = ['task.view', 'task.manage', 'system.view']

function task(id: number) {
  return {
    id, key: `cron.run:job-${id}`, kind: 'internal', state: 'ok', progress: 100,
    started_at: 1, finished_at: 2, exit_code: 0,
  }
}

function mountThree() {
  return mountView({
    component: TasksView,
    caps: capsAllOk(),
    perms: PERMS,
    routes: {
      [API.tasks.list()]: [task(1), task(2), task(3)],
      [API.tasks.get(2)]: task(2),
      [API.tasks.output(2)]: { id: 2, lines: ['line-2'] },
    },
  })
}

describe('任务详情就地展开', () => {
  it('点第 2 行：详情行紧跟该行，不在表格末尾', async () => {
    const m = await mountThree()
    await m.flush()
    const rows = [...m.host.querySelectorAll('tbody tr')]
    expect(rows.length, '夹具应有 3 行数据').toBe(3)

    buttonByText(rows[1] as HTMLElement, /输出/).click()
    await m.flush()

    const after = rows[1].nextElementSibling as HTMLElement | null
    expect(after?.classList.contains('detail-row'), '详情没有跟在点击行后面').toBe(true)
    expect(after?.textContent).toContain('line-2')
    expect(m.host.querySelectorAll('tr.detail-row').length, '不应出现多处详情').toBe(1)
    expect(rows[2].nextElementSibling?.classList.contains('detail-row') === true, '详情又被挪到末尾').toBe(false)
    m.fake.assertClean(); m.cleanup()
  })

  it('点详情内的关闭：详情行消失', async () => {
    const m = await mountThree()
    await m.flush()
    const rows = [...m.host.querySelectorAll('tbody tr')]

    buttonByText(rows[1] as HTMLElement, /输出/).click()
    await m.flush()
    const detail = rows[1].nextElementSibling as HTMLElement
    expect(detail.classList.contains('detail-row')).toBe(true)

    buttonByText(detail, '关闭').click()
    await m.flush()
    expect(m.host.querySelectorAll('tr.detail-row').length, '关闭后详情仍在').toBe(0)
    m.fake.assertClean(); m.cleanup()
  })
})

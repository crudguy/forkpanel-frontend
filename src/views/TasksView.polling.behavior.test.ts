// @vitest-environment jsdom
// F-06：副标题承诺「运行中每 2 秒自动刷新」，必须真在列表页发生。
// 真挂载 + 真等一个轮询周期（不用 fake timers：mountView 的 flush 依赖真实
// setTimeout(0)，切 fake 后挂载本身会挂住）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import TasksView from './TasksView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'

const SRC = readFileSync(resolve(process.cwd(), 'src/views/TasksView.vue'), 'utf8')
const LAYOUT = readFileSync(resolve(process.cwd(), 'src/layouts/MainLayout.vue'), 'utf8')

const PERMS = ['task.view', 'task.manage', 'system.view']

function task(over: Record<string, unknown> = {}) {
  return {
    id: 7, key: 'backup.daily', kind: 'backup', state: 'running', progress: 10,
    started_at: 1, finished_at: null, exit_code: null, ...over,
  }
}

/** 等一个完整轮询周期 + 余量，让 usePolling 的自调度链真正跑一次。 */
async function oneTick(m: Mounted) {
  await new Promise<void>((r) => setTimeout(r, 2200))
  await m.flush()
}

describe('F-06 任务列表自动刷新', () => {
  it('列表里有运行中任务：2 秒后真的补拉，进度条显示新值且不闪骨架', async () => {
    let n = 0
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        [API.tasks.list()]: () => {
          n += 1
          return [task({ progress: n === 1 ? 10 : 65 })]
        },
      },
    })
    expect(m.host.textContent).toContain('10%')
    expect(m.fake.count(API.tasks.list(), 'GET')).toBe(1)
    await oneTick(m)
    expect(m.fake.count(API.tasks.list(), 'GET'), '停在列表页也必须补拉').toBeGreaterThanOrEqual(2)
    expect(m.host.textContent).toContain('65%')
    expect(m.host.querySelector('.skeleton'), '后台刷新不许闪骨架（silent）').toBeNull()
    m.fake.assertClean(); m.cleanup()
  })

  it('列表全已结束：不产生无谓请求（enabled 每 tick 求值）', async () => {
    const m = await mountView({
      component: TasksView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.tasks.list()]: [task({ state: 'ok', progress: 100 })] },
    })
    expect(m.fake.count(API.tasks.list(), 'GET')).toBe(1)
    await oneTick(m)
    expect(m.fake.count(API.tasks.list(), 'GET')).toBe(1)
    m.fake.assertClean(); m.cleanup()
  })

  it('无 task.view 权限：一次都不拉', async () => {
    const m = await mountView({
      component: TasksView,
      perms: ['system.view'],
      caps: capsAllOk(),
      routes: { [API.tasks.list()]: [task()] },
    })
    await oneTick(m)
    expect(m.fake.count(API.tasks.list(), 'GET')).toBe(0)
    m.fake.assertClean(); m.cleanup()
  })
})

describe('F-06 接线守卫（轮询与副标题不得各写一份）', () => {
  it('TasksView 的列表轮询走 usePolling，且 enabled 绑的是列表而非 sel', () => {
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(body.length, '源码读取异常——扫描前提不成立').toBeGreaterThan(4000)
    expect(body).toContain('enabled: () => canView.value && tasks.value.some(isLive)')
    expect(body).toContain('ms: 2000')
    expect(body).toContain('fn: () => { void loadSilent() }')
    // 恰好两路 usePolling：列表 + 详情。少一路即退化回「只在详情里刷」。
    expect((body.match(/usePolling\(\{/g) ?? []).length).toBe(2)
    // ⚠ 用户触发的 load 必须无参：模板 `@click="load"` 会把 PointerEvent
    //   当第一个实参传进来，带 silent 形参会让它静默吞错。
    expect(body).toContain('function load() { return run(fetchTasks) }')
    expect(body).toContain('function loadSilent() { return run(fetchTasks, undefined, { silent: true }) }')
    expect(body).toContain('@click="load"')
  })

  // 原断言要求副标题逐字写「运行中每 2 秒自动刷新」。2026-11-27 顶栏文案收敛后
  // 定为**不再承诺刷新频率**——频率属于内部机制，只在 usePolling 的 `ms: 2000`
  // （上一条已钉住）单一维护；顶栏再写一遍就是两处维护、改一处漏一处。
  // 守卫反转后仍非恒绿：谁把频率写回顶栏，这条立刻变红。
  it('顶栏副标题不承诺刷新频率——频率只在 usePolling 里单一维护', () => {
    const block = LAYOUT.slice(LAYOUT.indexOf('const SUBTITLES'), LAYOUT.indexOf('const subtitle ='))
    expect(block.length, '源码读取异常——扫描前提不成立').toBeGreaterThan(500)
    expect(block, '顶栏副标题不得写刷新周期').not.toMatch(/每\s*\d+\s*秒/)
    expect(block, '顶栏副标题不得写刷新周期').not.toMatch(/\d+\s*秒(自动)?刷新/)
  })
})

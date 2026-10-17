import { describe, it, expect } from 'vitest'
import { useAsync } from './useAsync'

/**
 * useAsync 是 12+ 个列表页共用的加载状态机，语义（silent / onError / finally）
 * 全靠注释约定。这里把注释里承诺的行为逐条钉死——它们曾经是「各写各的 catch」，
 * 漂移过两次（漏 finally 骨架卡死、漏 errorText 把英文甩给用户）。
 */
describe('useAsync', () => {
  it('非 silent：进入即置 loading 并清空上一轮错误', async () => {
    const { loading, error, run } = useAsync()
    error.value = '上一轮的错'
    let sawLoadingInside = false
    const p = run(async () => { sawLoadingInside = loading.value })
    expect(loading.value, '进入即置位，不等 await').toBe(true)
    expect(error.value).toBe('')
    await p
    expect(sawLoadingInside).toBe(true)
    expect(loading.value, 'finally 恒清 loading').toBe(false)
  })

  it('非 silent 失败：中文兜底文案，且 loading 仍被清掉（漏 finally 会骨架卡死）', async () => {
    const { loading, error, run } = useAsync()
    const ok = await run(async () => { throw new Error('boom') })
    expect(ok).toBe(false)
    expect(loading.value).toBe(false)
    expect(error.value).toBe('请求失败，请稍后重试')
  })

  it('silent：完全不碰 loading 与 error（轮询不闪骨架、不打扰用户）', async () => {
    const { loading, error, run } = useAsync()
    error.value = '上一轮的错'
    const ok = await run(async () => { throw new Error('boom') }, undefined, { silent: true })
    expect(ok).toBe(false)
    expect(loading.value, 'silent 不置加载中').toBe(false)
    expect(error.value, 'silent 不清错').toBe('上一轮的错')
  })

  it('有 onError 时恒被调用——包括 silent（由它自己决定 silent 时做什么）', async () => {
    const { run } = useAsync()
    const seen: unknown[] = []
    const ok = await run(
      async () => { throw new Error('x') },
      (e) => { seen.push(e) },
      { silent: true },
    )
    expect(ok).toBe(false)
    expect(seen, 'silent 也要通知 onError').toHaveLength(1)
    expect((seen[0] as Error).message).toBe('x')
  })

  it('有 onError 时 run 不再替它写 error（接管即接管到底）', async () => {
    const { error, run } = useAsync()
    await run(async () => { throw new Error('x') }, () => {})
    expect(error.value).toBe('')
  })

  it('success 返回 true（调用方可据此跳过错误分支）', async () => {
    const { run } = useAsync()
    expect(await run(async () => 'whatever')).toBe(true)
  })

  it('initialLoading=true 起手即 loading（users 等首屏想显示加载中）', () => {
    const { loading } = useAsync(true)
    expect(loading.value).toBe(true)
  })
})

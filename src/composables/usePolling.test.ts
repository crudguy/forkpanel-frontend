// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { usePolling } from './usePolling'

// jsdom 没有 setInterval 的 fake 计时，用 vi.useFakeTimers
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePolling', () => {
  it('按间隔调用 fn', () => {
    const fn = vi.fn()
    usePolling({ fn, ms: 1000 })
    vi.advanceTimersByTime(3000)
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('enabled 为 false 时跳过 tick，且条件恢复后自动生效（无需重启）', () => {
    let on = false
    const fn = vi.fn()
    usePolling({ fn, ms: 1000, enabled: () => on })
    vi.advanceTimersByTime(3000)
    expect(fn).not.toHaveBeenCalled()
    on = true
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalled()
  })

  it('间隔可随状态变化（getter 形态）', () => {
    let fast = false
    const fn = vi.fn()
    // fast=true 时 200ms，否则 1000ms
    usePolling({ fn, ms: () => (fast ? 200 : 1000) })
    vi.advanceTimersByTime(2000)
    const slowCount = fn.mock.calls.length // ≈2
    fast = true
    vi.advanceTimersByTime(2000)
    // 间隔变化后 2 秒内应显著多于慢速（200ms 一档 ≈10 次）
    expect(fn.mock.calls.length - slowCount).toBeGreaterThan(slowCount)
  })

  it('页面隐藏时跳过 tick', () => {
    const fn = vi.fn()
    usePolling({ fn, ms: 1000 })
    // 模拟隐藏
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  it('回可见时立即补拉一次（不等整周期）', () => {
    const fn = vi.fn()
    usePolling({ fn, ms: 30_000 })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).not.toHaveBeenCalled()
    // 刚切回来，距上次 tick 远不足 30s——必须立刻补一次
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('pauseWhenHidden=false 时隐藏也继续轮询', () => {
    const fn = vi.fn()
    usePolling({ fn, ms: 1000, pauseWhenHidden: false })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(3000)
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  it('间隔下限 200ms（防手滑写成 0 导致死循环）', () => {
    const fn = vi.fn()
    usePolling({ fn, ms: 1 })
    vi.advanceTimersByTime(1000)
    // 1000ms 内最多 5 次（1000/200），而不是 1000 次
    expect(fn.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('stop 后不再调用', () => {
    const fn = vi.fn()
    const p = usePolling({ fn, ms: 1000 })
    p.stop()
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('异步 reject 收敛到 onError，且调度链不停摆（P1-21）', async () => {
    const onError = vi.fn()
    let shouldFail = true
    const fn = vi.fn(() =>
      shouldFail ? Promise.reject(new Error('async boom')) : Promise.resolve(),
    )
    usePolling({ fn, ms: 1000, onError })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('async boom')
    // 关键：一次 reject 之后链必须继续，不能停摆（页面数据停止更新却无错误的旧病）
    shouldFail = false
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn.mock.calls.length).toBe(4) // 1000/2000/3000/4000 各一次
    expect(onError).toHaveBeenCalledTimes(1) // 恢复后不再报错
  })

  it('同步 throw 收敛到 onError（P1-21）', () => {
    const onError = vi.fn()
    const fn = vi.fn(() => {
      throw new Error('sync boom')
    })
    usePolling({ fn, ms: 1000, onError })
    vi.advanceTimersByTime(1000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('sync boom')
  })

  it('未传 onError 时异步 reject 不静默：降级 console.error（P1-21）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(() => Promise.reject(new Error('async boom')))
    usePolling({ fn, ms: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][1]).toBeInstanceOf(Error)
    spy.mockRestore()
  })

  it('未传 onError 时同步 throw 不静默：降级 console.error（P1-21）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(() => {
      throw new Error('sync boom')
    })
    usePolling({ fn, ms: 1000 })
    vi.advanceTimersByTime(1000)
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][1]).toBeInstanceOf(Error)
    spy.mockRestore()
  })
})

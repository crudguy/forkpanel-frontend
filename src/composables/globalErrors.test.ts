import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  GLOBAL_ERROR_TEXT,
  createGlobalErrorHandlers,
  isIgnorableGlobalError,
} from './globalErrors'

const rejection = (reason: unknown) => ({ reason } as unknown as PromiseRejectionEvent)
const runtimeError = (error: unknown) => ({ error } as unknown as ErrorEvent)
const resourceError = () => ({ error: null, message: '' } as unknown as ErrorEvent)

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore() })

describe('isIgnorableGlobalError', () => {
  it('主动取消不是故障', () => {
    expect(isIgnorableGlobalError({ name: 'AbortError' })).toBe(true)
    expect(isIgnorableGlobalError({ code: 0, status: 0, message: 'request_cancelled' })).toBe(true)
  })

  it('真实异常一律要可见（夹具能区分「全忽略」与「恒 false」两种坏实现）', () => {
    expect(isIgnorableGlobalError(new Error('boom'))).toBe(false)
    expect(isIgnorableGlobalError({ code: 403, status: 403, message: 'forbidden' })).toBe(false)
    expect(isIgnorableGlobalError('boom')).toBe(false)
    expect(isIgnorableGlobalError(null)).toBe(false)
    expect(isIgnorableGlobalError(undefined)).toBe(false)
  })
})

describe('createGlobalErrorHandlers', () => {
  it('未处理 rejection 给一次可见反馈，且只回显固定文案', () => {
    const notify = vi.fn()
    const h = createGlobalErrorHandlers({ notify, now: () => 0 })
    h.onUnhandledRejection(rejection(new Error('secret stack')))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(GLOBAL_ERROR_TEXT)
    expect(String(notify.mock.calls[0][0])).not.toContain('secret')
  })

  it('主动取消不弹提示', () => {
    const notify = vi.fn()
    const h = createGlobalErrorHandlers({ notify, now: () => 0 })
    h.onUnhandledRejection(rejection({ name: 'AbortError' }))
    h.onUnhandledRejection(rejection({ code: 0, status: 0, message: 'request_cancelled' }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('节流窗口内只弹一次；跨过窗口后重新可弹', () => {
    let t = 0
    const notify = vi.fn()
    const h = createGlobalErrorHandlers({ notify, now: () => t, throttleMs: 3000 })
    h.onUnhandledRejection(rejection(new Error('a')))
    h.onUnhandledRejection(rejection(new Error('b')))
    expect(notify).toHaveBeenCalledTimes(1)
    t = 2999
    h.onUnhandledRejection(rejection(new Error('c')))
    expect(notify).toHaveBeenCalledTimes(1)
    t = 3000
    h.onUnhandledRejection(rejection(new Error('d')))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('error 与 unhandledrejection 共用一个节流窗口（同一故障不弹两次）', () => {
    const notify = vi.fn()
    const h = createGlobalErrorHandlers({ notify, now: () => 100, throttleMs: 3000 })
    h.onError(runtimeError(new Error('boom')))
    h.onUnhandledRejection(rejection(new Error('boom')))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('资源加载错误（无 error 字段）不算页面级异常', () => {
    const notify = vi.fn()
    const h = createGlobalErrorHandlers({ notify, now: () => 0 })
    h.onError(resourceError())
    expect(notify).not.toHaveBeenCalled()
  })

  it('notify 抛错不外泄（兜底不能再制造新的未处理异常）', () => {
    const h = createGlobalErrorHandlers({
      notify: () => { throw new Error('toast down') },
      now: () => 0,
    })
    expect(() => h.onUnhandledRejection(rejection(new Error('boom')))).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
  })
})

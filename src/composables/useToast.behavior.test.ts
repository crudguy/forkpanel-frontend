// @vitest-environment jsdom
/**
 * 错误码 toast 的真挂载行为测试。
 *
 * 只断言 `useToasts()` 里有 code 是不够的：那证明不了用户看得见、点得动。
 * 这里真挂 ToastHost，验证徽标渲染、复制内容与"点徽标不误关 toast"。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ToastHost from '@/components/ToastHost.vue'
import { ApiError, ValidationError } from '@/api/client'
import { mountView } from '@/test/mount'
import { clearToasts } from '@/test/toastHarness'
import { toastError, useToasts } from './useToast'

beforeEach(clearToasts)

describe('错误码可展示与可复制（toast 真挂载）', () => {
  it('API 错误渲染 code 徽标；点击复制完整信息且不误关 toast', async () => {
    const m = await mountView({ component: ToastHost })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    toastError(new ApiError(10005, 409, 'conflict: site name exists'))
    await m.flush()

    const badge = document.querySelector<HTMLElement>('.toast-code')
    expect(badge, 'toast 上没有错误码徽标').not.toBeNull()
    expect(badge!.textContent).toContain('10005')
    expect(document.querySelector('.toast .tx')?.textContent).toBe('已有同名资源，请换一个名称')

    const before = useToasts().length
    badge!.click()
    await m.flush()
    expect(writeText).toHaveBeenCalledWith('code=10005\n已有同名资源，请换一个名称')
    // ⚠ 不能断言 DOM：TransitionGroup 的离开动画在 jsdom 里不结束，元素会留在 DOM 里，
    // 于是"点徽标误关 toast"也恒绿。dismiss 同步改队列，判队列才抓得住。
    expect(useToasts().length, '点徽标把 toast 从队列移除了（漏了 @click.stop）').toBe(before)
    m.cleanup()
  })

  it('非 API 错误不产生假 code', async () => {
    const m = await mountView({ component: ToastHost })
    toastError(new ValidationError('域名格式不正确'))
    await m.flush()
    expect(document.querySelector('.toast-code')).toBeNull()
    expect(document.querySelector('.toast .tx')?.textContent).toBe('域名格式不正确')
    m.cleanup()
  })
})

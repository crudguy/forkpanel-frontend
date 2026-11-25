// @vitest-environment jsdom
//
// 任务中心点开详情只是改 ?task=id，不是换页：不能把用户从列表下方滚回顶部。
import { describe, it, expect } from 'vitest'
import { router } from './index'

type Dest = { path: string; hash: string }
type Src = { path: string }
type ScrollDecision = unknown

const scroll = router.options.scrollBehavior as (
  to: Dest, from: Src, saved: unknown,
) => ScrollDecision

const dest = (path: string, hash = ''): Dest => ({ path, hash })

describe('路由滚动行为', () => {
  it('同一路径只改 query（任务详情 ?task=id）保持当前滚动位置', () => {
    expect(scroll(dest('/cron/tasks'), { path: '/cron/tasks' }, undefined)).toBe(false)
  })

  it('换页面仍回到顶部', () => {
    expect(scroll(dest('/apps'), { path: '/cron/tasks' }, undefined)).toEqual({ top: 0 })
  })

  it('带锚点仍滚到锚点', () => {
    expect(scroll(dest('/settings', '#caps'), { path: '/settings' }, undefined))
      .toEqual({ el: '#caps', top: 24, behavior: 'smooth' })
  })

  it('浏览器前进/后退恢复保存的位置', () => {
    expect(scroll(dest('/apps'), { path: '/cron/tasks' }, { left: 0, top: 320 }))
      .toEqual({ left: 0, top: 320 })
  })
})

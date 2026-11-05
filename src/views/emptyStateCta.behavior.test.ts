// @vitest-environment jsdom
/**
 * F-19：空态必须带 CTA，且 CTA 真的把用户带回常驻新建表单。
 *
 * 真挂载两个视图 + 空列表夹具，断言按钮在 DOM 里、点击后焦点落在表单首个输入。
 * 只做源码断言挡不住「#cta 忘了写 / id 写错 / 按钮没绑事件」——这几样在
 * vue-tsc / build 下全绿，用户却仍卡在「暂无数据」页。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import { focusCreateCard } from '@/composables/emptyStateCta'
import CronView from '@/views/CronView.vue'
import DatabasesView from '@/views/DatabasesView.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

const PERMS = ['system.view', 'cron.view', 'cron.manage', 'db.view', 'db.manage']

function ctaButton(mounted: Mounted, text: string): HTMLButtonElement {
  const b = [...mounted.host.querySelectorAll<HTMLButtonElement>('.empty .cta button')]
    .find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`空态里找不到 CTA 按钮「${text}」（定位失效会静默空集通过）`)
  return b
}

describe('focusCreateCard 纯 DOM 行为', () => {
  it('找不到卡片时静默返回（不许抛错打断 UI）', () => {
    expect(() => focusCreateCard('does-not-exist')).not.toThrow()
  })

  it('找到卡片：滚动并聚焦第一个输入', () => {
    const card = document.createElement('section')
    card.id = 'probe-card'
    const scroll = vi.fn()
    // jsdom 没有 scrollIntoView；生产里也不能因为缺这个 API 就不聚焦。
    Object.defineProperty(card, 'scrollIntoView', { value: scroll, configurable: true })
    const first = document.createElement('input')
    const second = document.createElement('input')
    card.append(first, second)
    document.body.appendChild(card)
    try {
      focusCreateCard('probe-card')
      expect(scroll).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(first)
    } finally {
      card.remove()
    }
  })
})

describe('两个视图的空态 CTA 真的可用', () => {
  it('CronView：暂无任务时 CTA 在 DOM 里，点击把焦点带回新建表单', async () => {
    m = await mountView({
      component: CronView,
      routes: { [API.cron.jobs()]: [] },
      perms: PERMS,
    })
    expect(m.host.textContent).toContain('暂无计划任务')
    expect(m.host.textContent).toContain('新建任务')
    const btn = ctaButton(m, '去新建任务')
    expect(btn.disabled, '有 cron.manage 权限时不该置灰').toBe(false)
    btn.click()
    await m.flush()
    const first = m.host.querySelector<HTMLInputElement>('#cron-create-card input')
    expect(first, '新建卡片必须带 id，CTA 才能定位').not.toBeNull()
    expect(document.activeElement).toBe(first)
  })

  it('DatabasesView：暂无连接时 CTA 在 DOM 里，点击把焦点带回新增卡', async () => {
    m = await mountView({
      component: DatabasesView,
      routes: { [API.db.connections()]: [] },
      perms: PERMS,
    })
    expect(m.host.textContent).toContain('暂无连接')
    const btn = ctaButton(m, '去新增连接')
    expect(btn.disabled).toBe(false)
    btn.click()
    await m.flush()
    const first = m.host.querySelector<HTMLInputElement>('#db-create-card input')
    expect(first).not.toBeNull()
    expect(document.activeElement).toBe(first)
  })
})

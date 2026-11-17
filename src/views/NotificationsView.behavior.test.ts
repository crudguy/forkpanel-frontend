// @vitest-environment jsdom
/**
 * 通知页的**用户可见行为**：级别中文、标记已读/全部已读后共享未读数立即变化。
 *
 * 为什么必须真挂载：`crit` 原样显示成英文、以及"页面已清零、顶栏仍是 3"
 * 这两类问题，vue-tsc / 构建 / 源码断言全都看不出来。这里用真 fetch 假件
 * 跑完整链路（组件 → api → fetch → store），断言 DOM 与 store 同一帧。
 */
import { describe, it, expect } from 'vitest'
import NotificationsView from './NotificationsView.vue'
import { mountView } from '@/test/mount'
import { API } from '@/api/endpoints'
import { useNotificationsStore } from '@/stores/notifications'

interface Item {
  id: number
  ts: number
  level: string
  source: string
  title: string
  body: string | null
  read: boolean
}

const PERMS = ['system.view', 'system.manage']
const NOW = 1_794_887_208

/** 一个会随写操作变化的后端：未读数与列表保持真实关系（不是两套写死常量）。 */
function backend() {
  const items: Item[] = [
    { id: 1, ts: NOW, level: 'crit', source: 'restore', title: '恢复计划失败', body: '请人工确认现场', read: false },
    { id: 2, ts: NOW - 3600, level: 'warn', source: 'backup', title: '远端上传失败', body: '异地副本缺失', read: false },
  ]
  let count = 2
  return {
    routes: {
      [API.notifications.list()]: () => items,
      [API.notifications.unreadCount()]: () => ({ count }),
      [API.notifications.markRead(1)]: () => { items[0].read = true; count -= 1; return true },
      [API.notifications.readAll()]: () => {
        for (const n of items) n.read = true
        const updated = count
        count = 0
        return { updated }
      },
    },
    items,
  }
}

const rows = () => Array.from(document.querySelectorAll('.list .item'))
const badge = () => document.querySelector('.tools-row .badge')?.textContent?.trim() ?? null
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tools-row button, .list button'))
    .find((b) => b.textContent?.includes(text))

describe('通知页：级别与未读数一致性', () => {
  it('crit 显示「错误」而不是英文原值', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      expect(rows()).toHaveLength(2)
      expect(rows()[0].querySelector('.lvl')?.textContent).toBe('错误')
      expect(rows()[1].querySelector('.lvl')?.textContent).toBe('警告')
      // 回归判据：列表里不应再出现后端机器值
      expect(rows()[0].textContent).not.toContain('crit')
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('标记单条已读：store 未读数与页面徽标同步减一', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      const store = useNotificationsStore()
      expect(store.unread, '首屏未读数应来自 store').toBe(2)
      expect(badge()).toBe('未读 2')

      button('标记已读')!.click()
      await m.flush()

      expect(be.items[0].read).toBe(true)
      expect(store.unread).toBe(1)
      expect(badge()).toBe('未读 1')
      expect(rows()[0].className).toContain('read')
      expect(m.fake.count(API.notifications.markRead(1), 'POST')).toBe(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('全部已读：store 清零，徽标消失（顶栏读同一份状态）', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      const store = useNotificationsStore()
      expect(store.unread).toBe(2)

      button('全部已读')!.click()
      await m.flush()

      expect(store.unread).toBe(0)
      expect(badge()).toBeNull()
      expect(rows().every((r) => r.className.includes('read'))).toBe(true)
      expect(m.fake.count(API.notifications.readAll(), 'POST')).toBe(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })
})

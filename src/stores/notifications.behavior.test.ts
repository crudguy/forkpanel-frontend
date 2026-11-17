// 通知未读数由顶栏铃铛与通知页共用：这里钉住 store 的写入/失败语义。
// jsdom 是必需的：client.ts 在请求前读 document.cookie（CSRF），纯 node 下会抛。
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installApiFake, fakeError, type ApiFake, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import { useNotificationsStore } from './notifications'

let fake: ApiFake | null = null
afterEach(() => { fake?.restore(); fake = null })

function seeded(route: FakeRoute) {
  const pinia = createPinia()
  setActivePinia(pinia)
  fake = installApiFake({ [API.notifications.unreadCount()]: route })
  return useNotificationsStore()
}

describe('通知未读数 store', () => {
  it('refresh 写入后端计数', async () => {
    const s = seeded({ count: 7 })
    await s.refresh()
    expect(s.unread).toBe(7)
    expect(fake!.count(API.notifications.unreadCount(), 'GET')).toBe(1)
    fake!.assertClean()
  })

  it('refresh 失败保留旧值且不外抛（不能把徽标清零冒充"没有未读"）', async () => {
    const s = seeded(fakeError(500, 10901, '内部错误'))
    s.setUnread(3)
    await expect(s.refresh()).resolves.toBeUndefined()
    expect(s.unread).toBe(3)
    fake!.assertClean()
  })

  it('setUnread 收敛负数 / 小数 / NaN，避免徽标出现 -1 或 1.5', () => {
    const s = seeded({ count: 0 })
    s.setUnread(-3)
    expect(s.unread).toBe(0)
    s.setUnread(2.9)
    expect(s.unread).toBe(2)
    s.setUnread(Number.NaN)
    expect(s.unread).toBe(0)
  })
})
